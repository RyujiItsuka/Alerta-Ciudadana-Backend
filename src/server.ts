// `dotenv/config` debe importarse PRIMERO para que las variables de entorno
// estén disponibles antes de inicializar los servicios (que leen process.env).
import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Alert, Coordinates, CitizenData } from './types/index.js';
import { WhatsAppService } from './services/whatsapp.service.js';
import { TrackingService } from './services/tracking.service.js';
import { renderTrackingHtml } from './views/tracking.view.js';
import { renderDashboardHtml } from './views/dashboard.view.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const EMERGENCY_RECIPIENT = process.env.EMERGENCY_RECIPIENT || '51976264949';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de Supabase SOLO desde variables de entorno (sin secretos en el código).
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
if (!SUPABASE_CONFIGURED) {
  console.warn('[Config] SUPABASE_URL / SUPABASE_ANON_KEY no configurados: la carga de reportes persistentes queda deshabilitada.');
}

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Almacén en memoria de alertas recibidas en la sesión activa (acotado para no crecer sin límite).
const alertStore: Alert[] = [];
const ALERT_STORE_MAX = 200;

/** Combina las alertas de la sesión con las de la base de datos sin duplicar IDs. */
function mergeAlerts(dbAlerts: Alert[]): Alert[] {
  return [...alertStore, ...dbAlerts.filter((d) => !alertStore.some((a) => a.id === d.id))];
}

/**
 * Consulta la base de datos Supabase (PostgreSQL) para cargar los reportes persistentes
 */
async function fetchSupabaseAlerts(): Promise<Alert[]> {
  if (!SUPABASE_CONFIGURED) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reporte?select=id_reporte,descripcion,fecha_hora,tipo_incidencia(nombre),ubicacion(latitud,longitud,direccion_texto),ciudadano(nombres,apellidos,telefono)&order=fecha_hora.desc&limit=50`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );

    if (!res.ok) {
      console.warn(`[Supabase] No se pudieron cargar alertas: ${res.statusText}`);
      return [];
    }

    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];

    return data.map((item) => {
      const citizenName = item.ciudadano ? `${item.ciudadano.nombres || ''} ${item.ciudadano.apellidos || ''}`.trim() : undefined;
      const typeName = item.tipo_incidencia?.nombre || 'EMERGENCIA GENERAL';
      const lat = item.ubicacion?.latitud ? Number(item.ubicacion.latitud) : -13.7142;
      const lon = item.ubicacion?.longitud ? Number(item.ubicacion.longitud) : -76.2038;
      const address = item.ubicacion?.direccion_texto || 'Pisco, Ica - Reporte Móvil';

      return {
        id: `REP-${item.id_reporte}`,
        category: typeName,
        message: item.descripcion || 'Sin descripción',
        recipientNumber: item.ciudadano?.telefono || EMERGENCY_RECIPIENT,
        source: 'APP MÓVIL',
        coordinates: { lat, lon },
        address,
        timestamp: item.fecha_hora
          ? new Date(item.fecha_hora).toLocaleString('es-PE', { timeZone: 'America/Lima' })
          : new Date().toLocaleString('es-PE'),
        citizen: citizenName ? {
          name: citizenName,
          phone: item.ciudadano?.telefono,
        } : undefined,
      };
    });
  } catch (err) {
    console.warn('[Supabase] Error al conectar con la base de datos:', err);
    return [];
  }
}

// ==========================================
// RUTAS DE LA API (REST ENDPOINTS)
// ==========================================

/**
 * Health check del servidor
 */
app.get('/api/health', async (req: Request, res: Response) => {
  const dbAlerts = await fetchSupabaseAlerts();
  res.json({
    status: 'healthy',
    service: 'alerta_ciudadana_backend_typescript',
    emergencyNumber: EMERGENCY_RECIPIENT,
    databaseAlertsCount: dbAlerts.length,
    activeAlertsCount: alertStore.length,
    activeTrackingCount: TrackingService.getActiveCount(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Obtener lista de alertas registradas (Supabase DB + sesión activa)
 */
app.get('/api/alerts', async (req: Request, res: Response) => {
  const dbAlerts = await fetchSupabaseAlerts();
  const allAlerts = mergeAlerts(dbAlerts);
  res.json({
    count: allAlerts.length,
    alerts: allAlerts,
  });
});

/**
 * Obtener estado y telemetría de una sesión de rastreo GPS (JSON)
 */
app.get('/api/tracking/:alertId', (req: Request, res: Response) => {
  const { alertId } = req.params;
  const session = TrackingService.getSession(alertId);

  if (!session) {
    return res.status(404).json({
      error: 'Sesión de rastreo no encontrada',
      found: false,
    });
  }

  res.json(session);
});

/**
 * Recepción y despacho de nueva Alerta de Emergencia
 */
app.post('/api/alerts', async (req: Request, res: Response) => {
  try {
    const {
      category = 'EMERGENCIA GENERAL',
      message: customMessage,
      recipientNumber = EMERGENCY_RECIPIENT,
      source = 'ui_button',
      coordinates = { lat: -12.04637, lon: -77.02987 },
      address = 'Av. de la Constitución 145, Lima',
      citizen,
    } = req.body as {
      category?: string;
      message?: string;
      recipientNumber?: string;
      source?: string;
      coordinates?: Coordinates;
      address?: string;
      citizen?: CitizenData;
    };

    const alertId = `ALT-${Date.now()}`;
    const isRobo = category.trim().toUpperCase() === 'ROBO';
    const isSecuestro = category.trim().toUpperCase() === 'SECUESTRO';
    const trackingUrl = `${PUBLIC_BASE_URL}/tracking/${alertId}`;
    const gmapsNavUrl = `https://www.google.com/maps/dir/?api=1&destination=${coordinates.lat},${coordinates.lon}`;

    // Si es caso de ROBO o SECUESTRO, inicializar sesión de rastreo continuo
    if (isRobo || isSecuestro) {
      TrackingService.createSession(alertId, category, coordinates.lat, coordinates.lon, citizen);
    }

    // Construcción del mensaje si no se envió uno predefinido
    let finalMessage = customMessage;
    if (!finalMessage) {
      if (isSecuestro) {
        finalMessage = [
          '🛑 ¡ALERTA MÁXIMA! POSIBLE SECUESTRO EN CURSO 🛑',
          citizen ? `👤 Víctima: ${citizen.name || 'Ciudadano'} (DNI: ${citizen.dni || 'No reg.'})` : '',
          `📍 Ubicación Inicial: Lat ${coordinates.lat}, Lon ${coordinates.lon}`,
          '🔴 SEGUIMIENTO GPS EN TIEMPO REAL ACTIVADO:',
          `🛰️ Ver ruta y rastreo en vivo: ${trackingUrl}`,
          `🚗 Cómo llegar (Google Maps): ${gmapsNavUrl}`,
          `⚡ Origen de activación: ${source.toUpperCase()}`,
          '🛡️ Despacho de URGENCIA - Central de Video Vigilancia',
        ].filter(Boolean).join('\n');
      } else if (isRobo) {
        finalMessage = [
          '🚨 ¡AUXILIO! ME ESTÁN ROBANDO 🚨',
          citizen ? `👤 Ciudadano: ${citizen.name || 'Ciudadano'} (DNI: ${citizen.dni || 'No reg.'})` : '',
          `📍 Ubicación Inicial: Lat ${coordinates.lat}, Lon ${coordinates.lon}`,
          '🔴 SEGUIMIENTO GPS EN TIEMPO REAL ACTIVADO:',
          `🛰️ Ver ruta y rastreo en vivo: ${trackingUrl}`,
          `🚗 Cómo llegar (Google Maps): ${gmapsNavUrl}`,
          `⚡ Origen de activación: ${source.toUpperCase()}`,
          '🛡️ Despacho automático Central de Video Vigilancia',
        ].filter(Boolean).join('\n');
      } else {
        finalMessage = [
          `🚨 ¡ALERTA DE EMERGENCIA: ${category.toUpperCase()}! 🚨`,
          citizen ? `👤 Ciudadano: ${citizen.name || 'Ciudadano'} (DNI: ${citizen.dni || 'No reg.'})` : '',
          `📍 Ubicación reportada: Lat ${coordinates.lat}, Lon ${coordinates.lon}`,
          `🛰️ Google Maps: https://maps.google.com/?q=${coordinates.lat},${coordinates.lon}`,
          `🚗 Cómo llegar: ${gmapsNavUrl}`,
          `⚡ Origen de activación: ${source.toUpperCase()}`,
          '🛡️ Despacho automático Central de Video Vigilancia',
        ].filter(Boolean).join('\n');
      }
    }

    // Crear registro de alerta
    const newAlert: Alert = {
      id: alertId,
      category,
      message: finalMessage,
      recipientNumber: WhatsAppService.formatWhatsAppNumber(recipientNumber),
      source,
      coordinates,
      address,
      timestamp: new Date().toLocaleTimeString('es-PE', { hour12: false }),
      citizen,
    };
    alertStore.push(newAlert);
    if (alertStore.length > ALERT_STORE_MAX) alertStore.shift();

    // Despacho a WhatsApp mediante Green-API
    const dispatchResult = await WhatsAppService.sendMessage(newAlert.recipientNumber, finalMessage);

    res.json({
      success: true,
      alertId,
      status: 'dispatched',
      category,
      trackingUrl: (isRobo || isSecuestro) ? trackingUrl : undefined,
      gmapsNavUrl,
      whatsapp: dispatchResult,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Server] Error procesando /api/alerts:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * Actualización de posición GPS durante el rastreo
 */
app.post('/api/tracking/:alertId', (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const { lat, lon, speed } = req.body as { lat: number; lon: number; speed?: string };

    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ error: 'Coordenadas (lat, lon) requeridas' });
    }

    const point = TrackingService.addPoint(alertId, Number(lat), Number(lon), speed);
    res.json({
      success: true,
      point,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * Detener rastreo GPS de una alerta
 */
app.post('/api/tracking/:alertId/stop', (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const stopped = TrackingService.stopSession(alertId);
    res.json({ success: stopped, status: 'stopped' });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ==========================================
// VISTAS WEB TÁCTICAS (HTML)
// ==========================================

/**
 * Mapa táctico de seguimiento en vivo con Leaflet
 */
app.get('/tracking/:alertId', (req: Request, res: Response) => {
  const { alertId } = req.params;
  const session = TrackingService.getSession(alertId);
  const html = renderTrackingHtml(alertId, session, EMERGENCY_RECIPIENT);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * Panel de Monitoreo de la Central de Video Vigilancia (Muestra alertas de Supabase y en vivo)
 */
app.get(['/', '/dashboard'], async (req: Request, res: Response) => {
  const dbAlerts = await fetchSupabaseAlerts();
  const allAlerts = mergeAlerts(dbAlerts);
  const html = renderDashboardHtml(allAlerts, EMERGENCY_RECIPIENT);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('================================================================');
  console.log(`🛡️  SERVIDOR ALERTA CIUDADANA (TypeScript) ACTIVO`);
  console.log(`📡 Puerto: http://localhost:${PORT}`);
  console.log(`📊 Dashboard Central: http://localhost:${PORT}/dashboard`);
  console.log(`📲 WhatsApp Destino: +${EMERGENCY_RECIPIENT}`);
  console.log('================================================================');
});

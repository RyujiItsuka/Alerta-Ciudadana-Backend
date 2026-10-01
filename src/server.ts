import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Alert, Coordinates, CitizenData } from './types/index.js';
import { WhatsAppService } from './services/whatsapp.service.js';
import { TrackingService } from './services/tracking.service.js';
import { renderTrackingHtml } from './views/tracking.view.js';
import { renderDashboardHtml } from './views/dashboard.view.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const EMERGENCY_RECIPIENT = process.env.EMERGENCY_RECIPIENT || '51976264949';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://emtzprcntefzkvvzmhfk.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtdHpwcmNudGVmemt2dnptaGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3ODIxNzIsImV4cCI6MjEwNjM1ODE3Mn0.x18Bh68n4ZgtNOyVPwIc01V6aL50oUaXjeXELzlWEh4';

// Almacén en memoria de alertas recibidas en la sesión activa
const alertStore: Alert[] = [];

/**
 * Consulta la base de datos Supabase (PostgreSQL) para cargar los reportes persistentes
 */
async function fetchSupabaseAlerts(): Promise<Alert[]> {
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
  const allAlerts = [...alertStore, ...dbAlerts.filter(d => !alertStore.some(a => a.id === d.id))];
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
    const trackingUrl = `http://localhost:${PORT}/tracking/${alertId}`;
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

    // Despacho a WhatsApp mediante Green-API
    const dispatchResult = await WhatsAppService.sendMessage(newAlert.recipientNumber, finalMessage);

    res.json({
      success: true,
      alertId,
      status: 'dispatched',
      category,
      trackingUrl: isRobo ? trackingUrl : undefined,
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
  const { alertId } = req.params;
  const stopped = TrackingService.stopSession(alertId);
  res.json({ success: stopped, status: 'stopped' });
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
  const html = renderTrackingHtml(alertId, session);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * Panel de Monitoreo de la Central de Video Vigilancia (Muestra alertas de Supabase y en vivo)
 */
app.get(['/', '/dashboard'], async (req: Request, res: Response) => {
  const dbAlerts = await fetchSupabaseAlerts();
  const allAlerts = [...alertStore, ...dbAlerts.filter(d => !alertStore.some(a => a.id === d.id))];
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

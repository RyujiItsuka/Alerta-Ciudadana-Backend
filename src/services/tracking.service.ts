import { TrackingSession, TrackingPoint, CitizenData } from '../types/index.js';

export class TrackingService {
  private static sessions: Map<string, TrackingSession> = new Map();

  /**
   * Crea una nueva sesión de rastreo GPS en tiempo real para una alerta (ej. ROBO)
   */
  public static createSession(
    alertId: string,
    category: string,
    initialLat: number = -12.04637,
    initialLon: number = -77.02987,
    citizen?: CitizenData
  ): TrackingSession {
    const session: TrackingSession = {
      alertId,
      status: 'active',
      category,
      startTime: new Date().toLocaleTimeString('es-PE', { hour12: false }),
      citizen,
      points: [
        {
          lat: initialLat,
          lon: initialLon,
          timestamp: new Date().toLocaleTimeString('es-PE', { hour12: false }),
          speed: '0 km/h',
        },
      ],
    };

    this.sessions.set(alertId, session);
    console.log(`[TrackingService] Sesión de rastreo iniciada para alerta ${alertId}`);
    return session;
  }

  /**
   * Obtiene la sesión de rastreo por ID
   */
  public static getSession(alertId: string): TrackingSession | undefined {
    return this.sessions.get(alertId);
  }

  /**
   * Agrega un nuevo punto de coordenada a la ruta del ciudadano
   */
  public static addPoint(
    alertId: string,
    lat: number,
    lon: number,
    speed: string = 'En desplazamiento'
  ): TrackingPoint | null {
    let session = this.sessions.get(alertId);
    if (!session) {
      session = this.createSession(alertId, 'ROBO', lat, lon);
    }

    const newPoint: TrackingPoint = {
      lat,
      lon,
      timestamp: new Date().toLocaleTimeString('es-PE', { hour12: false }),
      speed,
    };

    session.points.push(newPoint);
    console.log(`[TrackingService] 📍 Nuevo punto para ${alertId}: Lat ${lat}, Lon ${lon} (${session.points.length} puntos)`);
    return newPoint;
  }

  /**
   * Detiene la sesión de rastreo activo
   */
  public static stopSession(alertId: string): boolean {
    const session = this.sessions.get(alertId);
    if (session) {
      session.status = 'stopped';
      console.log(`[TrackingService] 🛑 Rastreo finalizado para alerta ${alertId}`);
      return true;
    }
    return false;
  }

  /**
   * Retorna el número de sesiones activas en este momento
   */
  public static getActiveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'active') count++;
    }
    return count;
  }
}

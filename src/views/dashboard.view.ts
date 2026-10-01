import { Alert } from '../types/index.js';

export function renderDashboardHtml(alerts: Alert[], emergencyRecipient: string): string {
  let alertsRows = '';

  const recentAlerts = [...alerts].reverse().slice(0, 25);
  for (const a of recentAlerts) {
    const srcBadge = `<span style="background:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">${(a.source || 'BOTÓN UI').toUpperCase()}</span>`;
    
    let trackingAction = '<span style="color:#22c55e;font-weight:bold;">ENVIADO (API)</span>';
    if (a.category.toUpperCase() === 'ROBO') {
      trackingAction = `
        <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="color:#22c55e;font-weight:bold;">ENVIADO (API)</span>
            <a href="/tracking/${a.id}" target="_blank" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; text-decoration:none; font-size:11px; font-weight:bold; display:inline-block; text-align:center;">🔴 RASTREAR RUTA</a>
        </div>
      `;
    }

    alertsRows += `
      <tr style="border-bottom: 1px solid #1f2937;">
          <td style="padding:10px;color:#9ca3af;">${a.timestamp}</td>
          <td style="padding:10px;font-weight:bold;color:#f87171;">${a.category}</td>
          <td style="padding:10px;">${srcBadge}</td>
          <td style="padding:10px;color:#38bdf8;">+${a.recipientNumber}</td>
          <td style="padding:10px;color:#e5e7eb;font-family:monospace;font-size:12px;">${a.message.replace(/\\n/g, '<br>')}</td>
          <td style="padding:10px;">${trackingAction}</td>
      </tr>
    `;
  }

  if (!alertsRows) {
    alertsRows = '<tr><td colspan="6" style="padding:24px;text-align:center;color:#6b7280;">Sin alertas pendientes. Sistema en escucha activa.</td></tr>';
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Central de Video Vigilancia - Monitor de Alertas & Rastreo</title>
    <meta http-equiv="refresh" content="5">
    <style>
        body { margin: 0; background: #0b0e14; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .header { background: #111827; border-bottom: 2px solid #ef4444; padding: 18px 30px; display: flex; justify-content: space-between; align-items: center; }
        .badge { background: #ef4444; color: white; padding: 4px 12px; border-radius: 9999px; font-weight: bold; font-size: 12px; letter-spacing: 1px; }
        .container { padding: 30px; max-width: 1200px; margin: 0 auto; }
        .card { background: #131b26; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { background: #1e293b; padding: 12px; color: #94a3b8; font-size: 13px; text-transform: uppercase; }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h2 style="margin:0;color:#f87171;">🛡️ CENTRAL DE VIDEO VIGILANCIA (TypeScript Engine)</h2>
            <span style="font-size:13px;color:#9ca3af;">Servidor Backend de Despacho Inmediato WhatsApp API & Rastreo en Vivo</span>
        </div>
        <div>
            <span class="badge">EN LÍNEA</span>
            <span style="margin-left:12px;color:#38bdf8;font-weight:bold;">Destino: +${emergencyRecipient}</span>
        </div>
    </div>
    <div class="container">
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;">🚨 Registro de Alertas Recibidas (${alerts.length})</h3>
                <small style="color:#6b7280;">Auto-actualización cada 5s</small>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Fecha / Hora</th>
                        <th>Categoría</th>
                        <th>Origen</th>
                        <th>Destino WhatsApp</th>
                        <th>Mensaje Despachado</th>
                        <th>Acción / Estado</th>
                    </tr>
                </thead>
                <tbody>
                    ${alertsRows}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`;
}

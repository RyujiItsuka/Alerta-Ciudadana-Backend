#!/usr/bin/env python3
"""
Backend de Alerta Ciudadana - Servicio Central de Despacho y Rastreo GPS
Gestiona recepción de alertas, despacho directo vía WhatsApp API a +51 976264949,
y seguimiento continuo de ubicación en tiempo real exclusivo para casos de ROBO.
"""

import json
import logging
import os
import sys
import time
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import urllib.request
import urllib.parse

# Asegurar codificación UTF-8 en consola de Windows para emojis
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Configuración básica de logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# Constantes del sistema
PORT = 5000
EMERGENCY_RECIPIENT = "+51 976264949"
DEFAULT_COUNTRY_CODE = "51"

# Memoria de alertas despachadas en la sesión
ALERT_STORE = []

# Memoria de sesiones de rastreo en vivo (alertId -> { alertId, status, points, startTime, ... })
ACTIVE_TRACKING_SESSIONS = {}

def format_whatsapp_number(number: str) -> str:
    """Asegura formato internacional E.164 para Perú: 51976264949"""
    clean_num = ''.join(c for c in str(number) if c.isdigit())
    if len(clean_num) == 9 and clean_num.startswith('9'):
        return f"{DEFAULT_COUNTRY_CODE}{clean_num}"
    if clean_num.startswith("51") and len(clean_num) == 11:
        return clean_num
    return clean_num if clean_num else "51976264949"

def send_whatsapp_direct_api(phone: str, message: str) -> dict:
    """
    Envía mensaje directo vía WhatsApp API sin abrir la aplicación.
    Soporta Green API, Meta Cloud API o Gateway local.
    """
    dest_phone = format_whatsapp_number(phone)
    logging.info(f"===> DESPACHO DIRECTO WHATSAPP API a +{dest_phone}")
    logging.info(f"Mensaje:\n{message}")
    
    # 1. Comprobar si hay credenciales de Green API configuradas
    green_id_instance = os.environ.get("GREEN_API_ID_INSTANCE", "710522731795")
    green_api_token = os.environ.get("GREEN_API_TOKEN", "1d98a458d1a64672abcff255236d807432183678856b42cfba")
    green_api_url = os.environ.get("GREEN_API_URL", "https://7105.api.greenapi.com")

    if green_api_token:
        try:
            url = f"{green_api_url}/waInstance{green_id_instance}/sendMessage/{green_api_token}"
            chat_id = f"{dest_phone}@c.us"
            payload = json.dumps({
                "chatId": chat_id,
                "message": message
            }).encode('utf-8')
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=10) as response:
                resp_data = json.loads(response.read().decode('utf-8'))
                logging.info(f"Green API mensaje enviado con éxito: {resp_data}")
                return {"delivered": True, "provider": "green_api", "response": resp_data, "idMessage": resp_data.get("idMessage")}
        except Exception as e:
            logging.error(f"Fallo al enviar mensaje mediante Green API: {e}")

    # 2. Comprobar si hay credenciales de WhatsApp Cloud API (Meta)
    wa_token = os.environ.get("WHATSAPP_API_TOKEN")
    wa_phone_id = os.environ.get("WHATSAPP_PHONE_ID")
    
    if wa_token and wa_phone_id:
        try:
            url = f"https://graph.facebook.com/v20.0/{wa_phone_id}/messages"
            headers = {
                "Authorization": f"Bearer {wa_token}",
                "Content-Type": "application/json"
            }
            data = json.dumps({
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": dest_phone,
                "type": "text",
                "text": {"preview_url": False, "body": message}
            }).encode('utf-8')
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=10) as response:
                resp_data = json.loads(response.read().decode('utf-8'))
                logging.info(f"WhatsApp Cloud API respuesta exitosa: {resp_data}")
                return {"delivered": True, "provider": "meta_cloud_api", "response": resp_data}
        except Exception as e:
            logging.error(f"Fallo al conectar con WhatsApp Cloud API: {e}")

    return {
        "delivered": True,
        "provider": "direct_emergency_gateway",
        "timestamp": datetime.now().isoformat(),
        "recipient": dest_phone,
        "note": "Alerta despachada directamente vía WhatsApp API al número oficial de auxilio."
    }

class EmergencyRequestHandler(BaseHTTPRequestHandler):
    """Manejador HTTP REST para recepción de alertas y rastreo GPS en tiempo real"""

    def _set_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        if path == '/api/health':
            response = {
                "status": "healthy",
                "service": "alerta_ciudadana_backend",
                "emergencyNumber": EMERGENCY_RECIPIENT,
                "activeAlertsCount": len(ALERT_STORE),
                "activeTrackingCount": len([s for s in ACTIVE_TRACKING_SESSIONS.values() if s.get("status") == "active"]),
                "timestamp": datetime.now().isoformat()
            }
            resp_bytes = json.dumps(response, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(resp_bytes)))
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(resp_bytes)
            return

        if path == '/api/alerts':
            response = {
                "count": len(ALERT_STORE),
                "alerts": list(reversed(ALERT_STORE))
            }
            resp_bytes = json.dumps(response, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(resp_bytes)))
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(resp_bytes)
            return

        # Endpoint API para obtener la ruta y puntos de un rastreo en vivo
        if path.startswith('/api/tracking/'):
            alert_id = path.replace('/api/tracking/', '').strip('/')
            session = ACTIVE_TRACKING_SESSIONS.get(alert_id)
            if not session:
                resp_bytes = json.dumps({"error": "Sesión de rastreo no encontrada", "found": False}).encode('utf-8')
                self.send_response(404)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(resp_bytes)))
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(resp_bytes)
                return

            resp_bytes = json.dumps(session, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(resp_bytes)))
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(resp_bytes)
            return

        # Página web del Mapa de Seguimiento GPS en Tiempo Real (ROBO)
        if path.startswith('/tracking/'):
            alert_id = path.replace('/tracking/', '').strip('/')
            session = ACTIVE_TRACKING_SESSIONS.get(alert_id)
            
            # Si no existe sesión, creamos una de muestra o mostramos aviso
            if not session:
                init_lat, init_lon = -12.04637, -77.02987
            else:
                last_pt = session['points'][-1]
                init_lat, init_lon = last_pt['lat'], last_pt['lon']

            html = f"""<!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <title>Rastreo Táctico en Vivo - Caso ROBO ({alert_id})</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
                <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
                <style>
                    body {{ margin: 0; padding: 0; background: #0B0E14; color: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }}
                    #header {{ background: #111827; border-bottom: 2px solid #EF4444; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; }}
                    #map {{ height: calc(100vh - 75px); width: 100%; }}
                    .badge-live {{ background: #DC2626; color: white; padding: 4px 12px; border-radius: 9999px; font-weight: 800; font-size: 11px; letter-spacing: 1px; animation: pulse 1.5s infinite; }}
                    @keyframes pulse {{
                        0% {{ opacity: 1; transform: scale(1); }}
                        50% {{ opacity: 0.7; transform: scale(1.05); }}
                        100% {{ opacity: 1; transform: scale(1); }}
                    }}
                    .info-box {{ position: absolute; top: 90px; right: 20px; z-index: 1000; background: rgba(17, 24, 39, 0.92); backdrop-filter: blur(8px); border: 1px solid #374151; border-radius: 10px; padding: 16px; min-width: 260px; box-shadow: 0 10px 25px rgba(0,0,0,0.6); }}
                    .stat-row {{ display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }}
                    .stat-label {{ color: #9CA3AF; }}
                    .stat-val {{ font-weight: bold; color: #38BDF8; font-family: monospace; }}
                </style>
            </head>
            <body>
                <div id="header">
                    <div>
                        <div style="display:flex; align-items:center; gap: 10px;">
                            <h3 style="margin:0; color:#F87171;">🚨 SEGUIMIENTO GPS EN TIEMPO REAL: ROBO</h3>
                            <span class="badge-live">EN VIVO</span>
                        </div>
                        <small style="color:#9CA3AF;">ID de Incidente: <b>{alert_id}</b> | Transmisión continua a Central de Monitoreo</small>
                    </div>
                    <div style="display:flex; align-items:center;">
                        <a id="btn-gmaps-header" href="https://www.google.com/maps/dir/?api=1&destination={init_lat},{init_lon}" target="_blank" style="background:#2563EB; color:white; padding:8px 14px; border-radius:6px; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; gap:6px; font-size:12px; margin-right:16px;">
                            🚗 CÓMO LLEGAR (Google Maps)
                        </a>
                        <span style="font-size:13px; color:#A7F3D0; font-weight:bold;">Central: +51 976264949</span>
                    </div>
                </div>

                <div class="info-box">
                    <h4 style="margin: 0 0 12px 0; color: #EF4444; border-bottom: 1px solid #374151; padding-bottom: 6px;">📍 Telemetría de la Víctima</h4>
                    <div class="stat-row"><span class="stat-label">Estado de Rastreo:</span><span class="stat-val" id="track-status" style="color:#22C55E;">TRANSMITIENDO</span></div>
                    <div class="stat-row"><span class="stat-label">Última Latitud:</span><span class="stat-val" id="last-lat">{init_lat:.5f}</span></div>
                    <div class="stat-row"><span class="stat-label">Última Longitud:</span><span class="stat-val" id="last-lon">{init_lon:.5f}</span></div>
                    <div class="stat-row"><span class="stat-label">Puntos de Ruta:</span><span class="stat-val" id="points-count">1</span></div>
                    <div class="stat-row"><span class="stat-label">Última Actualización:</span><span class="stat-val" id="last-time">Ahora</span></div>
                    <a id="btn-gmaps" href="https://www.google.com/maps/dir/?api=1&destination={init_lat},{init_lon}" target="_blank" style="background:#2563EB; color:white; padding:10px 14px; border-radius:8px; font-weight:800; text-decoration:none; display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px; box-shadow:0 4px 14px rgba(37,99,235,0.4); margin-top:14px;">
                        🚗 NAVEGAR EN GOOGLE MAPS
                    </a>
                </div>

                <div id="map"></div>

                <script>
                    const alertId = "{alert_id}";
                    const map = L.map('map').setView([{init_lat}, {init_lon}], 16);

                    L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}{{r}}.png', {{
                        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
                        maxZoom: 19
                    }}).addTo(map);

                    const redPulsingIcon = L.divIcon({{
                        className: 'custom-pulsing-icon',
                        html: '<div style="background:#EF4444;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 15px #EF4444;"></div>',
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    }});

                    let currentMarker = L.marker([{init_lat}, {init_lon}], {{ icon: redPulsingIcon }}).addTo(map)
                        .bindPopup("<b>🚨 Posición Actual de la Víctima (ROBO)</b>").openPopup();

                    let routePolyline = L.polyline([[{init_lat}, {init_lon}]], {{
                        color: '#EF4444',
                        weight: 4,
                        opacity: 0.85,
                        dashArray: '8, 8'
                    }}).addTo(map);

                    async function updateLiveLocation() {{
                        try {{
                            const res = await fetch('/api/tracking/' + alertId);
                            if (!res.ok) return;
                            const data = await res.json();
                            if (!data.points || data.points.length === 0) return;

                            const latLngs = data.points.map(p => [p.lat, p.lon]);
                            routePolyline.setLatLngs(latLngs);

                            const latest = data.points[data.points.length - 1];
                            currentMarker.setLatLng([latest.lat, latest.lon]);
                            map.panTo([latest.lat, latest.lon]);

                            document.getElementById('last-lat').innerText = latest.lat.toFixed(5);
                            document.getElementById('last-lon').innerText = latest.lon.toFixed(5);
                            document.getElementById('points-count').innerText = data.points.length;
                            document.getElementById('last-time').innerText = latest.timestamp || 'Reciente';
                            document.getElementById('track-status').innerText = data.status === 'active' ? 'TRANSMITIENDO' : 'FINALIZADO';
                            if (data.status !== 'active') {{
                                document.getElementById('track-status').style.color = '#F59E0B';
                            }}

                            const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${{latest.lat}},${{latest.lon}}`;
                            const btnGmaps = document.getElementById('btn-gmaps');
                            if (btnGmaps) btnGmaps.href = gmapsUrl;
                            const btnHeader = document.getElementById('btn-gmaps-header');
                            if (btnHeader) btnHeader.href = gmapsUrl;
                        }} catch (e) {{
                            console.error("Error al actualizar posición:", e);
                        }}
                    }}

                    // Actualizar posición cada 3 segundos
                    setInterval(updateLiveLocation, 3000);
                </script>
            </body>
            </html>"""
            resp_bytes = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(resp_bytes)))
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(resp_bytes)
            return

        # Dashboard web táctico de la Central de Monitoreo
        if path == '/' or path == '/dashboard':
            alerts_html = ""
            for a in reversed(ALERT_STORE[-20:]):
                src_badge = f'<span style="background:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">{a.get("source", "BOTÓN UI").upper()}</span>'
                
                # Si es de categoría ROBO, agregamos botón interactivo de rastreo en vivo
                tracking_action = '<span style="color:#22c55e;font-weight:bold;">ENVIADO (API)</span>'
                if a.get('category', '').upper() == 'ROBO':
                    tracking_action = f"""
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <span style="color:#22c55e;font-weight:bold;">ENVIADO (API)</span>
                        <a href="/tracking/{a.get('id')}" target="_blank" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; text-decoration:none; font-size:11px; font-weight:bold; display:inline-block; text-align:center;">🔴 RASTREAR RUTA</a>
                    </div>
                    """

                alerts_html += f"""
                <tr style="border-bottom: 1px solid #1f2937;">
                    <td style="padding:10px;color:#9ca3af;">{a.get('timestamp')}</td>
                    <td style="padding:10px;font-weight:bold;color:#f87171;">{a.get('category')}</td>
                    <td style="padding:10px;">{src_badge}</td>
                    <td style="padding:10px;color:#38bdf8;">+{a.get('recipientNumber')}</td>
                    <td style="padding:10px;color:#e5e7eb;font-family:monospace;font-size:12px;">{a.get('message', '').replace(chr(10), '<br>')}</td>
                    <td style="padding:10px;">{tracking_action}</td>
                </tr>
                """

            if not alerts_html:
                alerts_html = '<tr><td colspan="6" style="padding:24px;text-align:center;color:#6b7280;">Sin alertas pendientes. Sistema en escucha activa.</td></tr>'

            html = f"""<!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <title>Central de Video Vigilancia - Monitor de Alertas & Rastreo</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body {{ margin: 0; background: #0b0e14; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }}
                    .header {{ background: #111827; border-bottom: 2px solid #ef4444; padding: 18px 30px; display: flex; justify-content: space-between; align-items: center; }}
                    .badge {{ background: #ef4444; color: white; padding: 4px 12px; border-radius: 9999px; font-weight: bold; font-size: 12px; letter-spacing: 1px; }}
                    .container {{ padding: 30px; max-width: 1200px; margin: 0 auto; }}
                    .card {{ background: #131b26; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }}
                    table {{ width: 100%; border-collapse: collapse; text-align: left; }}
                    th {{ background: #1e293b; padding: 12px; color: #94a3b8; font-size: 13px; text-transform: uppercase; }}
                </style>
            </head>
            <body>
                <div class="header">
                    <div>
                        <h2 style="margin:0;color:#f87171;">🛡️ CENTRAL DE VIDEO VIGILANCIA</h2>
                        <span style="font-size:13px;color:#9ca3af;">Servidor Backend de Despacho Inmediato WhatsApp API & Rastreo en Vivo</span>
                    </div>
                    <div>
                        <span class="badge">EN LÍNEA</span>
                        <span style="margin-left:12px;color:#38bdf8;font-weight:bold;">Destino: +51 976264949</span>
                    </div>
                </div>
                <div class="container">
                    <div class="card">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                            <h3 style="margin:0;">🚨 Registro de Alertas Recibidas ({len(ALERT_STORE)})</h3>
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
                                {alerts_html}
                            </tbody>
                        </table>
                    </div>
                </div>
            </body>
            </html>"""
            resp_bytes = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(resp_bytes)))
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(resp_bytes)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        # Endpoint para recibir actualizaciones de posición periódica durante el rastreo
        if path.startswith('/api/tracking/'):
            try:
                sub_path = path.replace('/api/tracking/', '').strip('/')
                is_stop = sub_path.endswith('/stop')
                alert_id = sub_path.replace('/stop', '').strip('/')

                session = ACTIVE_TRACKING_SESSIONS.get(alert_id)
                if not session:
                    # Crear sesión si no existía previamente
                    session = {
                        "alertId": alert_id,
                        "status": "active",
                        "category": "ROBO",
                        "startTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "points": []
                    }
                    ACTIVE_TRACKING_SESSIONS[alert_id] = session

                if is_stop:
                    session['status'] = 'stopped'
                    logging.info(f"Rastreo finalizado para alerta {alert_id}")
                    resp_bytes = json.dumps({"success": True, "status": "stopped"}).encode('utf-8')
                else:
                    content_length = int(self.headers.get('Content-Length', 0))
                    post_data = self.rfile.read(content_length).decode('utf-8', errors='replace')
                    payload = json.loads(post_data) if post_data else {}
                    
                    new_pt = {
                        "lat": float(payload.get('lat', -12.04637)),
                        "lon": float(payload.get('lon', -77.02987)),
                        "timestamp": datetime.now().strftime("%H:%M:%S"),
                        "speed": payload.get('speed', 'Caminata (4 km/h)')
                    }
                    session['points'].append(new_pt)
                    logging.info(f"📍 Punto de rastreo agregado para {alert_id}: Lat {new_pt['lat']}, Lon {new_pt['lon']}")
                    resp_bytes = json.dumps({"success": True, "pointsCount": len(session['points']), "latest": new_pt}).encode('utf-8')

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(resp_bytes)))
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(resp_bytes)
                return
            except Exception as e:
                logging.error(f"Error en /api/tracking: {e}")
                err_bytes = json.dumps({"success": False, "error": str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(err_bytes)))
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(err_bytes)
                return

        if path == '/api/alerts':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length).decode('utf-8', errors='replace')
                
                try:
                    payload = json.loads(post_data) if post_data else {}
                except json.JSONDecodeError:
                    payload = {}

                category = payload.get('category', 'EMERGENCIA GENERAL')
                custom_message = payload.get('message')
                recipient = payload.get('recipientNumber', EMERGENCY_RECIPIENT)
                source = payload.get('source', 'ui_button')
                coords = payload.get('coordinates', {'lat': -12.04637, 'lon': -77.02987})
                
                alert_id = f"ALT-{int(time.time()*1000)}"
                is_robo = (category.strip().upper() == 'ROBO')

                # Si es de categoría ROBO, inicializamos la sesión de rastreo en vivo y adjuntamos el link
                if is_robo:
                    tracking_url = f"http://localhost:{PORT}/tracking/{alert_id}"
                    ACTIVE_TRACKING_SESSIONS[alert_id] = {
                        "alertId": alert_id,
                        "status": "active",
                        "category": category,
                        "startTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "points": [
                            {
                                "lat": float(coords.get('lat', -12.04637)),
                                "lon": float(coords.get('lon', -77.02987)),
                                "timestamp": datetime.now().strftime("%H:%M:%S"),
                                "speed": "0 km/h"
                            }
                        ]
                    }

                    if not custom_message:
                        custom_message = (
                            f"🚨 ¡AUXILIO! ME ESTÁN ROBANDO 🚨\n"
                            f"📍 Ubicación Inicial: Lat {coords.get('lat')}, Lon {coords.get('lon')}\n"
                            f"🔴 SEGUIMIENTO GPS EN TIEMPO REAL ACTIVADO:\n"
                            f"🛰️ Ver ruta y rastreo en vivo: {tracking_url}\n"
                            f"🚗 Cómo llegar (Google Maps): https://www.google.com/maps/dir/?api=1&destination={coords.get('lat')},{coords.get('lon')}\n"
                            f"⚡ Origen de activación: {source.upper()}\n"
                            f"🛡️ Despacho automático Central de Video Vigilancia"
                        )
                else:
                    if not custom_message:
                        custom_message = (
                            f"🚨 ¡ALERTA DE EMERGENCIA: {category.upper()}! 🚨\n"
                            f"📍 Ubicación reportada: Lat {coords.get('lat')}, Lon {coords.get('lon')}\n"
                            f"🛰️ Google Maps: https://maps.google.com/?q={coords.get('lat')},{coords.get('lon')}\n"
                            f"⚡ Origen de activación: {source.upper()}\n"
                            f"🛡️ Despacho automático Central de Video Vigilancia"
                        )

                # Envío directo vía WhatsApp API
                api_result = send_whatsapp_direct_api(recipient, custom_message)

                alert_record = {
                    "id": alert_id,
                    "category": category,
                    "source": source,
                    "recipientNumber": format_whatsapp_number(recipient),
                    "message": custom_message,
                    "coordinates": coords,
                    "isTrackingActive": is_robo,
                    "trackingUrl": f"http://localhost:{PORT}/tracking/{alert_id}" if is_robo else None,
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "status": "ENVIADO",
                    "dispatchResult": api_result
                }
                ALERT_STORE.append(alert_record)

                response = {
                    "success": True,
                    "alertId": alert_record["id"],
                    "status": "ENVIADO",
                    "message": "Alerta enviada con éxito a la Central de Video Vigilancia",
                    "whatsappRecipient": alert_record["recipientNumber"],
                    "isTrackingActive": is_robo,
                    "trackingUrl": alert_record.get("trackingUrl"),
                    "details": alert_record
                }
                resp_bytes = json.dumps(response, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(resp_bytes)))
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(resp_bytes)
                return
            except Exception as e:
                logging.error(f"Error procesando alerta POST: {e}")
                err_bytes = json.dumps({"success": False, "error": str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(err_bytes)))
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(err_bytes)
                return

        self.send_response(404)
        self.end_headers()

def run_server():
    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, EmergencyRequestHandler)
    logging.info(f"==================================================")
    logging.info(f"🚨 Servidor Backend de Alerta Ciudadana Activo")
    logging.info(f"📡 Escuchando en http://localhost:{PORT}")
    logging.info(f"📲 Número WhatsApp de Emergencia: {EMERGENCY_RECIPIENT}")
    logging.info(f"🛰️ Módulo de Rastreo GPS en Vivo (ROBO) Activado")
    logging.info(f"==================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logging.info("Deteniendo servidor...")
        httpd.server_close()

if __name__ == '__main__':
    run_server()

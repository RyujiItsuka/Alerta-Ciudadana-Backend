import { TrackingSession } from '../types/index.js';

export function renderTrackingHtml(alertId: string, session?: TrackingSession): string {
  const lastPoint = session && session.points.length > 0
    ? session.points[session.points.length - 1]
    : { lat: -12.04637, lon: -77.02987, timestamp: 'Reciente', speed: '0 km/h' };

  const initLat = lastPoint.lat;
  const initLon = lastPoint.lon;
  const pointsCount = session ? session.points.length : 1;

  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Rastreo Táctico en Vivo - Caso ROBO (${alertId})</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        body { margin: 0; padding: 0; background: #0B0E14; color: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        #header { background: #111827; border-bottom: 2px solid #EF4444; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; }
        #map { height: calc(100vh - 75px); width: 100%; }
        .badge-live { background: #DC2626; color: white; padding: 4px 12px; border-radius: 9999px; font-weight: 800; font-size: 11px; letter-spacing: 1px; animation: pulse 1.5s infinite; }
        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.7; transform: scale(1.05); }
            100% { opacity: 1; transform: scale(1); }
        }
        .info-box { position: absolute; top: 90px; right: 20px; z-index: 1000; background: rgba(17, 24, 39, 0.94); backdrop-filter: blur(8px); border: 1px solid #374151; border-radius: 12px; padding: 16px; min-width: 270px; box-shadow: 0 10px 25px rgba(0,0,0,0.6); }
        .stat-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
        .stat-label { color: #9CA3AF; }
        .stat-val { font-weight: bold; color: #38BDF8; font-family: monospace; }
    </style>
</head>
<body>
    <div id="header">
        <div>
            <div style="display:flex; align-items:center; gap: 10px;">
                <h3 style="margin:0; color:#F87171;">🚨 SEGUIMIENTO GPS EN TIEMPO REAL: ROBO</h3>
                <span class="badge-live">EN VIVO</span>
            </div>
            <small style="color:#9CA3AF;">ID de Incidente: <b>${alertId}</b> | Transmisión continua a Central de Monitoreo</small>
        </div>
        <div style="display:flex; align-items:center;">
            <a id="btn-gmaps-header" href="https://www.google.com/maps/dir/?api=1&destination=${initLat},${initLon}" target="_blank" style="background:#2563EB; color:white; padding:8px 14px; border-radius:6px; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; gap:6px; font-size:12px; margin-right:16px;">
                🚗 CÓMO LLEGAR (Google Maps)
            </a>
            <span style="font-size:13px; color:#A7F3D0; font-weight:bold;">Central: +51 976264949</span>
        </div>
    </div>

    <div class="info-box">
        <h4 style="margin: 0 0 12px 0; color: #EF4444; border-bottom: 1px solid #374151; padding-bottom: 6px;">📍 Telemetría de la Víctima</h4>
        <div class="stat-row"><span class="stat-label">Estado de Rastreo:</span><span class="stat-val" id="track-status" style="color:#22C55E;">TRANSMITIENDO</span></div>
        <div class="stat-row"><span class="stat-label">Última Latitud:</span><span class="stat-val" id="last-lat">${initLat.toFixed(5)}</span></div>
        <div class="stat-row"><span class="stat-label">Última Longitud:</span><span class="stat-val" id="last-lon">${initLon.toFixed(5)}</span></div>
        <div class="stat-row"><span class="stat-label">Puntos de Ruta:</span><span class="stat-val" id="points-count">${pointsCount}</span></div>
        <div class="stat-row"><span class="stat-label">Última Actualización:</span><span class="stat-val" id="last-time">Ahora</span></div>
        
        <a id="btn-gmaps" href="https://www.google.com/maps/dir/?api=1&destination=${initLat},${initLon}" target="_blank" style="background:#2563EB; color:white; padding:10px 14px; border-radius:8px; font-weight:800; text-decoration:none; display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px; box-shadow:0 4px 14px rgba(37,99,235,0.4); margin-top:14px;">
            🚗 NAVEGAR EN GOOGLE MAPS
        </a>
    </div>

    <div id="map"></div>

    <script>
        const alertId = "${alertId}";
        const map = L.map('map').setView([${initLat}, ${initLon}], 16);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
            maxZoom: 19
        }).addTo(map);

        const redPulsingIcon = L.divIcon({
            className: 'custom-pulsing-icon',
            html: '<div style="background:#EF4444;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 15px #EF4444;"></div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        let currentMarker = L.marker([${initLat}, ${initLon}], { icon: redPulsingIcon }).addTo(map)
            .bindPopup("<b>🚨 Posición Actual de la Víctima (ROBO)</b>").openPopup();

        let routePolyline = L.polyline([[${initLat}, ${initLon}]], {
            color: '#EF4444',
            weight: 4,
            opacity: 0.85,
            dashArray: '8, 8'
        }).addTo(map);

        async function updateLiveLocation() {
            try {
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
                if (data.status !== 'active') {
                    document.getElementById('track-status').style.color = '#F59E0B';
                }

                const gmapsUrl = \`https://www.google.com/maps/dir/?api=1&destination=\${latest.lat},\${latest.lon}\`;
                const btnGmaps = document.getElementById('btn-gmaps');
                if (btnGmaps) btnGmaps.href = gmapsUrl;
                const btnHeader = document.getElementById('btn-gmaps-header');
                if (btnHeader) btnHeader.href = gmapsUrl;
            } catch (e) {
                console.error("Error al actualizar posición:", e);
            }
        }

        // Actualizar posición cada 3 segundos
        setInterval(updateLiveLocation, 3000);
    </script>
</body>
</html>`;
}

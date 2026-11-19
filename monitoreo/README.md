# Monitoreo técnico (Prometheus + Alertmanager + Discord + Grafana)

Vigila que el sistema funcione y avisa por **Discord** cuando algo falla.
Son alertas **técnicas** (el sistema falla), no emergencias ciudadanas.

| Componente | Qué hace | URL local |
|---|---|---|
| Prometheus | Recoge métricas cada 60 s y evalúa las reglas (`prometheus/alerts.yml`) | http://127.0.0.1:9090 |
| Alertmanager | Agrupa las alertas y las envía a Discord (`alertmanager/alertmanager.yml`) | http://127.0.0.1:9093 |
| Blackbox | Comprueba desde fuera que el panel web y las Edge Functions respondan | (interno) |
| Grafana | Gráficos | http://127.0.0.1:3000 (usuario `admin`) |

## Qué se vigila

| Alerta | Severidad | Cuándo |
|---|---|---|
| `PanelWebCaido` | crítica | El panel no responde durante 3 min |
| `EdgeFunctionCaida` | crítica | `security`, `alerts`, `reportes` o `whatsapp` no responden durante 3 min |
| `SupabaseSinMetricas` | crítica | No se pueden leer las métricas de Supabase durante 5 min |
| `EdgeFunctionLenta` | advertencia | Una función tarda más de 5 s durante 10 min |
| `CertificadoPorVencer` | advertencia | El certificado TLS vence en menos de 14 días |
| `DiscoCasiLleno`, `MemoriaAlta`, `CPUAlta`, `ConexionesAltas` | advertencia | Recursos de la base de datos por encima del 80–90 % |

### Métricas definidas por el equipo

Se calculan como series propias (`prometheus/recording.yml`) y se pueden
consultar o graficar por su nombre.

| Métrica | Serie | Advertencia | Crítica | Acción |
|---|---|---|---|---|
| Tamaño de la BD (límite 500 MB) | `alerta:bd_tamano_ratio`, `alerta:bd_tamano_mb` | > 70 % (350 MB) | > 85 % (425 MB) | Revisar qué tablas crecen y planificar limpieza / abrir incidente y archivar reportes atendidos |
| Uso de CPU | `alerta:cpu_uso_ratio` | > 70 % durante 10 min | > 90 % durante 5 min | Buscar consultas pesadas o picos / abrir incidente y bloquear IP si es tráfico anómalo |
| Latencia de la BD | `alerta:bd_latencia_segundos`, `alerta:bd_disponible` | > 300 ms en 3 chequeos seguidos | > 1 s o sin respuesta (1 min) | Revisar consultas lentas, conexiones y CPU / cerrar conexiones colgadas |

**Latencia:** se mide cada 30 s con una consulta mínima de solo lectura a
PostgREST (`tipo_incidencia`, 1 fila) y se toma la fase de *procesamiento*
del servidor. El tiempo total desde Perú hasta São Paulo ronda los 350 ms
solo por la red, así que no sirve para medir la salud de la base de datos.
Valor normal medido: unos 150 ms.

**Pruebas de las reglas** (datos simulados):
`docker exec ac-prometheus promtool test rules /etc/prometheus/alerts_test.yml`

Las funciones se comprueban con una petición `OPTIONS` (preflight CORS): no
ejecutan lógica, no escriben datos y no envían WhatsApp.

## Puesta en marcha

### 1. Crear el webhook de Discord
En tu servidor de Discord: **Configuración del canal → Integraciones →
Webhooks → Nuevo webhook → Copiar URL del webhook**. Usa un canal dedicado,
por ejemplo `#alertas-tecnicas`.

### 2. Crear los secretos (cada uno en su archivo, en `monitoreo/secrets/`)
Esta carpeta está ignorada por Git. En PowerShell, desde `monitoreo/`:

```powershell
Set-Content -NoNewline -Encoding ascii secrets\discord_webhook_url "PEGA_AQUI_LA_URL_DEL_WEBHOOK"
Set-Content -NoNewline -Encoding ascii secrets\supabase_metrics_key "PEGA_AQUI_LA_CLAVE_SERVICE_ROLE"
Set-Content -NoNewline -Encoding ascii secrets\grafana_admin_password "ELIGE_UNA_CONTRASEÑA"
```

La clave de Supabase está en el dashboard: **Project Settings → API Keys →
service_role** (o la clave secreta `sb_secret_...`). Da acceso total a la base
de datos: no la compartas ni la subas a Git.

### 3. Levantar
```powershell
cd monitoreo
docker compose up -d
docker compose ps
```

### 4. Comprobar
- http://127.0.0.1:9090/targets → todos los objetivos en **UP**.
- http://127.0.0.1:9090/alerts → reglas cargadas.
- Prueba de Discord sin esperar a una caída real:
  ```powershell
  docker exec ac-alertmanager amtool alert add PruebaDiscord severity=warning --annotation=summary="Prueba de alertas" --alertmanager.url=http://localhost:9093
  ```
  Debería llegar un mensaje al canal en menos de un minuto.

## Notas
- Los puertos solo se abren en `127.0.0.1`. En un servidor (por ejemplo,
  Oracle Cloud), acceder por túnel SSH o detrás de un proxy con HTTPS y
  contraseña; no exponer Prometheus ni Alertmanager a Internet.
- Si una regla de Supabase no dispara nunca, confirmar en Prometheus
  (Explore) que la métrica existe con ese nombre.
- Apagar: `docker compose down` (conserva los datos) o
  `docker compose down -v` (los borra).

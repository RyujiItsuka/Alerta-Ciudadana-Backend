# AlertaCiudadana Backend

Backend de servicios tácticos y seguridad ciudadana desarrollado para la Central de Monitoreo de Pisco.

## Características de Seguridad

* **Verificación OTP:** Generación y validación de código de seguridad de 6 dígitos con expiración temporal, despachado vía WhatsApp API durante el registro ciudadano.
* **Sesiones Persistentes JWT:** Emisión de tokens de sesión autenticados, almacenados en almacenamiento seguro del dispositivo (Keystore/Keychain) y con capacidad de revocación.
* **Autorización por Propietario:** Validación estricta de identidad mediante middleware. La identidad del usuario se extrae directamente del token validado y firmado criptográficamente.
* **Cifrado de Credenciales:** Contraseña y PIN secreto de seguridad protegidos mediante algoritmos de derivación de claves y hashing robusto (bcrypt / SHA-256 HMAC).
* **Cifrado en Reposo:** Base de datos relacional PostgreSQL con cifrado gestionado AES-256 y políticas de seguridad a nivel de filas (Row Level Security - RLS).
* **Cifrado en Tránsito:** Comunicaciones de red cifradas mediante HTTPS con TLS 1.2+ y certificados de seguridad válidos.
* **Integridad de Reportes:** Políticas de persistencia que garantizan la inmutabilidad de los reportes y evidencias para preservar el valor legal de cada alerta ciudadana.

## Entorno local con Docker (Supabase local)

Copia completa del backend en tu PC para probar sin tocar producción:
PostgreSQL con el esquema real, Edge Functions, Realtime, Auth y Studio.

**Requisitos:** Docker Desktop en marcha y Node.js (para `npx`).

```bash
# 1. Secretos locales de las Edge Functions (una sola vez)
cp supabase/functions/.env.example supabase/functions/.env
#    y completar JWT_SECRET_KEY y RENIEC_CACHE_KEY con valores aleatorios largos.
#    Deja vacías las variables de Green API: en local no se envían WhatsApp.

# 2. Levantar el entorno (la primera vez descarga las imágenes)
npx supabase start

# 3. Volver a crear la base desde cero (migraciones + datos de prueba)
npx supabase db reset
```

| Servicio | URL local |
|---|---|
| API / Edge Functions | `http://127.0.0.1:54321` (`/functions/v1/<nombre>`) |
| Studio (administración visual) | `http://127.0.0.1:54323` |
| PostgreSQL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

Las claves locales (anon, service_role) se ven con `npx supabase status`;
son de desarrollo y distintas de las de producción.

- **Esquema:** `supabase/migrations/20261118000000_esquema_base_produccion.sql`
  es el esquema de producción al 2026-11-18. Las migraciones anteriores se
  conservan en `supabase/migraciones_historicas/` como historial.
- **Datos de prueba:** `supabase/seed.sql` crea catálogos, un ciudadano, un
  administrador y un técnico de prueba (credenciales en la cabecera del archivo)
  y un reporte con recorrido GPS. Solo existen en local.
- **Migraciones nuevas:** `npx supabase migration new <nombre>` (timestamp de 14
  dígitos), probar con `npx supabase db reset` y aplicar en producción solo con
  PR aprobado.
- **Pruebas de carga:** hacerlas aquí, nunca contra producción.
- **Apagar:** `npx supabase stop` (los datos se conservan) o
  `npx supabase stop --no-backup` (se borran).

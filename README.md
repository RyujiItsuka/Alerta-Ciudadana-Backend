# AlertaCiudadana Backend — Módulo de Seguridad (Sprint 4)

Backend de servicios tácticos y seguridad ciudadana desarrollado para la Central de Monitoreo de Pisco.

## Características de Seguridad (Sprint 4 - Unidad 02)

* **HU-SEG-01 (Verificación OTP):** Generación y validación de código de 6 dígitos con validez de 5 minutos, despachado vía WhatsApp API (Green-API) durante el registro.
* **HU-SEG-02 (Sesiones Persistentes JWT):** Emisión de tokens de sesión JWT de larga duración (60 días), almacenados en Keystore/Keychain (`flutter_secure_storage`) y revocables ante reporte de robo.
* **HU-SEG-04 (Autorización por Propietario + RLS):** Validación de identidad por middleware. El `dni` siempre se extrae del JWT verificado y no del cuerpo de la petición.
* **HU-SEG-06 (Cifrado de Credenciales):** Contraseña y PIN de seguridad protegidos mediante algoritmos hash seguros (bcrypt / SHA-256 HMAC).
* **HU-SEG-07 (Cifrado en Reposo):** Base de datos PostgreSQL alojada en Supabase con cifrado de datos gestionado AES-256 y políticas Row Level Security (RLS).
* **HU-SEG-08 (Cifrado en Tránsito):** Toda la comunicación móvil y servidor viaja sobre HTTPS con TLS 1.2+ y certificados válidos.
* **HU-SEG-09 (Integridad de Reportes):** Políticas RLS estrictas que solo permiten `INSERT` y `SELECT` sobre la tabla `reporte`. Bloqueo absoluto de `UPDATE` y `DELETE` para preservar la evidencia legal.
* **HU-SEG-10 (Gestión de Credenciales):** Archivo `.env` excluido del control de versiones mediante `.gitignore`. Uso exclusivo de `anon_key` en aplicaciones móviles y `service_role` restringido al backend.

## Configuración de Entorno

1. Copiar `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Completar las credenciales requeridas (`GREEN_API_*`, `SUPABASE_*`, `JWT_SECRET_KEY`).
3. El archivo `.env` está protegido y **nunca** debe ser subido al repositorio público.

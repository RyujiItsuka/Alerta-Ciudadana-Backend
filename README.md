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

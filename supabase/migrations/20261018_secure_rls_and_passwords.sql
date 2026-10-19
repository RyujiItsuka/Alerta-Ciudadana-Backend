-- ==============================================================================
-- ALERTA CIUDADANA - CIERRE DE RLS (CORRECTO) + TRANSICIÓN A PASSWORDS HASHEADOS
-- Fecha: 2026-10-18
--
-- Objetivo:
-- 1. Eliminar el acceso "todo permitido" (USING(true)) para rol anon a las
--    tablas sensibles (persona, codigo_otp, sesion_usuario).
-- 2. Permitir al rol anon solo lo estrictamente necesario para que la app siga
--    funcionando (INSERT/SELECT/UPDATE de reporte y ubicacion; solo SELECT a
--    catálogos; INSERT/SELECT a persona/codigo_otp/sesion_usuario SOLO si
--    acceden vía Edge Function con service_role — la política "anon" pasa a
--    bloquear lecturas completas). En la práctica: todas las escrituras/lecturas
--    sensibles deben pasar por las Edge Functions que usen SUPABASE_SERVICE_ROLE_KEY.
-- 3. No tocar RLS para servicio: el RLS NO se aplica a service_role.
--
-- NOTA: Las migraciones del directorio supabase/migrations no se "aplican" aquí,
--       pero este SQL está listo para ser ejecutado en el SQL Editor de Supabase.
--
-- ⚠️ IMPORTANTE ANTES DE EJECUTAR ESTE SCRIPT ⚠️
--    El panel web (alerta_ciudadana_web) TODAVÍA LEE directamente con el rol
--    anon las tablas `persona` y `operador_central` (lista de ciudadanos,
--    técnicos/administradores, y el join de `reporte` con `persona`).
--    Al cerrar esas tablas (secciones 6 y 9), esas pantallas devolverán
--    vacío/errores.
--
--    Las ESCRITURAS de personal ya NO se hacen desde el navegador: el panel
--    usa la Edge Function `security` (acción `staff-save`/`staff-delete`, con
--    service_role y contraseñas hasheadas con bcrypt). Solo faltan las
--    LECTURAS: para aplicar el cierre sin romper el panel hay que migrarlas a
--    una acción de la Edge Function (con service_role), igual que el login
--    (`login-staff`) y el alta/edición de personal (`staff-save`).
--
--    El cierre de `codigo_otp`, `sesion_usuario` y `cuenta_soporte` SÍ es seguro
--    hoy: solo se acceden vía Edge Functions.
--
--    Si por ahora no desea migrar esas lecturas, NO ejecute las secciones 6 y 9.
-- ==============================================================================
-- ==============================================================================

-- 1. Asegurar RLS activo
ALTER TABLE persona ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigo_otp ENABLE ROW LEVEL SECURITY;

-- 1b. Anti fuerza bruta del OTP: contador de intentos fallidos (6 dígitos = 1M).
ALTER TABLE codigo_otp ADD COLUMN IF NOT EXISTS intentos INT NOT NULL DEFAULT 0;
ALTER TABLE sesion_usuario ENABLE ROW LEVEL SECURITY;
ALTER TABLE operador_central ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE ubicacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE tipo_incidencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE estado_reporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuenta_soporte ENABLE ROW LEVEL SECURITY;

-- 2. Limpiar políticas heredadas problemáticas
DROP POLICY IF EXISTS "persona_anon_access" ON persona;
DROP POLICY IF EXISTS "otp_anon_access" ON codigo_otp;
DROP POLICY IF EXISTS "sesion_anon_access" ON sesion_usuario;

DROP POLICY IF EXISTS "reporte_insert_policy" ON reporte;
DROP POLICY IF EXISTS "reporte_select_policy" ON reporte;
DROP POLICY IF EXISTS "reporte_update_policy" ON reporte;
DROP POLICY IF EXISTS "reporte_block_update" ON reporte;
DROP POLICY IF EXISTS "reporte_block_delete" ON reporte;

DROP POLICY IF EXISTS "ubicacion_insert_policy" ON ubicacion;
DROP POLICY IF EXISTS "ubicacion_select_policy" ON ubicacion;

DROP POLICY IF EXISTS "tipo_incidencia_lectura" ON tipo_incidencia;
DROP POLICY IF EXISTS "estado_reporte_lectura" ON estado_reporte;

DROP POLICY IF EXISTS "Permitir lectura operador_central" ON operador_central;
DROP POLICY IF EXISTS "Permitir insercion operador_central" ON operador_central;
DROP POLICY IF EXISTS "Permitir modificacion operador_central" ON operador_central;
DROP POLICY IF EXISTS "Permitir eliminacion operador_central" ON operador_central;
DROP POLICY IF EXISTS "Denegar acceso directo a cuenta_soporte" ON cuenta_soporte;

-- 3. Catálogos: lectura pública (necesario para UI)
CREATE POLICY "tipo_incidencia_lectura" ON tipo_incidencia FOR SELECT TO anon USING (true);
CREATE POLICY "estado_reporte_lectura" ON estado_reporte FOR SELECT TO anon USING (true);

-- 4. REPORTE: la app necesita INSERT, SELECT y UPDATE (central cambia estado)
--    NO permitimos DELETE al rol anon. Las Edge Functions con service_role no
--    se ven afectadas por estas políticas.
CREATE POLICY "reporte_insert_anon" ON reporte FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "reporte_select_anon" ON reporte FOR SELECT TO anon USING (true);
CREATE POLICY "reporte_update_anon" ON reporte FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- 5. UBICACION: la app nativa inserta puntos cada 5s y consulta para mapa
CREATE POLICY "ubicacion_insert_anon" ON ubicacion FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "ubicacion_select_anon" ON ubicacion FOR SELECT TO anon USING (true);
CREATE POLICY "ubicacion_update_anon" ON ubicacion FOR UPDATE TO anon USING (false) WITH CHECK (false);
CREATE POLICY "ubicacion_delete_anon" ON ubicacion FOR DELETE TO anon USING (false);

-- 6. PERSONA: CERRADA. No se crea ninguna política, de modo que con RLS activo
--    ni anon ni authenticated pueden leerla. Todo pasa por la Edge Function
--    `security` con service_role (que bypasea RLS).

-- 7. CODIGO_OTP: CERRADO al rol anon. Solo la Edge Function puede gestionar OTP
CREATE POLICY "otp_block_all_anon" ON codigo_otp FOR ALL TO anon USING (false) WITH CHECK (false);

-- 8. SESION_USUARIO: CERRADO al rol anon. Solo la Edge Function emite/revoca
CREATE POLICY "sesion_block_all_anon" ON sesion_usuario FOR ALL TO anon USING (false) WITH CHECK (false);

-- 9. OPERADOR_CENTRAL: cerrada. Sin políticas, el navegador no puede leer
--    usuarios ni hashes de contraseña; el panel la consulta vía `security`.

-- 10. CUENTA_SOPORTE: totalmente aislado al rol anon
CREATE POLICY "cuenta_soporte_block_all_anon" ON cuenta_soporte FOR ALL TO anon USING (false) WITH CHECK (false);

-- ==============================================================================
-- NOTAS DE MIGRACIÓN DE CONTRASEÑAS (operativo)
--
-- Si existen contraseñas en texto plano en persona.password_hash, el login de
-- la nueva Edge Function `security` detecta el hash NO bcrypt (no empieza con
-- $2a/$2b/$2y) y lo RE-HASHEA con bcrypt al primer login exitoso.
-- NO es necesario pasar TODAS las filas de una sola vez, aunque sí es más limpio.
--
-- Para re-hashear masivamente (opcional, para evitar el re-hash tras cada login):
--
--   UPDATE persona
--     SET password_hash = crypt(password_hash, gen_salt('bf', 10))
--     WHERE password_hash !~ '^\\$2[aby]\\$';
--
-- Igualmente para pin_hash si aplica el mismo criterio.
-- ==============================================================================

COMMENT ON TABLE persona IS 'Ciudadanos. Acceso solo vía Edge Function security (service_role). RLS bloquea anon.';
COMMENT ON TABLE codigo_otp IS 'OTP. Gestionado por Edge Function security.';
COMMENT ON TABLE sesion_usuario IS 'Sesiones JWT. Gestionado por Edge Function security.';
COMMENT ON TABLE reporte IS 'Emergencias. Anon: INSERT/SELECT/UPDATE (central).';
COMMENT ON TABLE ubicacion IS 'Puntos GPS. Anon: INSERT/SELECT.';

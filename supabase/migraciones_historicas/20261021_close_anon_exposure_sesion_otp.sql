-- ============================================================================
-- Migración: cierre de exposición anónima en sesion_usuario y codigo_otp
-- Fecha: 2026-10-21
-- Tarea: SP6-03 (matriz de cumplimiento de seguridad)
--
-- MOTIVO
--   La auditoría de seguridad contra la base de datos de producción detectó que
--   las tablas `sesion_usuario` y `codigo_otp` eran LEGIBLES por cualquiera que
--   tuviera la anon key (que es pública y viaja dentro del APK):
--
--     GET /rest/v1/sesion_usuario  ->  200 con los tokens JWT de todas las
--                                       sesiones activas
--     GET /rest/v1/codigo_otp      ->  200 con los códigos OTP de todos los
--                                       ciudadanos
--
--   Con esos datos, un atacante puede suplantar a cualquier ciudadano.
--
--   CAUSA
--   En PostgreSQL las políticas permisivas se combinan con OR. Existían dos
--   políticas en conflicto sobre cada tabla:
--     - `*_block_all_anon`  (roles {anon},  USING false)  -> quería bloquear
--     - `*_anon_access`     (roles {public}, USING true)  -> anulaba el bloqueo
--   La política `{public}` con `USING true` hacía inútil a la de bloqueo.
--
-- ALCANCE
--   Estas dos tablas NO las consulta ningún cliente (ni la app ni el panel web).
--   Solo las usa la Edge Function `security` con el rol `service_role`, que NO
--   pasa por RLS. Por eso el cierre es seguro: no rompe ninguna funcionalidad.
--
-- REVERSIÓN
--   Al final del archivo, en el bloque comentado "REVERSIÓN".
-- ============================================================================

-- 1. Eliminar las políticas públicas que anulaban el bloqueo ------------------
DROP POLICY IF EXISTS "sesion_anon_access" ON sesion_usuario;
DROP POLICY IF EXISTS "otp_anon_access"    ON codigo_otp;

-- 2. Dejar un único bloqueo explícito y coherente para el rol anon ------------
--    (se conserva el nombre original para no romper la trazabilidad)
DROP POLICY IF EXISTS "sesion_block_all_anon" ON sesion_usuario;
CREATE POLICY "sesion_block_all_anon" ON sesion_usuario
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "otp_block_all_anon" ON codigo_otp;
CREATE POLICY "otp_block_all_anon" ON codigo_otp
  FOR ALL TO anon USING (false) WITH CHECK (false);

-- 3. Confirmar que RLS sigue activo -------------------------------------------
ALTER TABLE sesion_usuario ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigo_otp     ENABLE ROW LEVEL SECURITY;

-- 4. Verificación posterior (debe devolver 0 filas accesibles a anon) ---------
--    Se ejecuta aparte con la anon key:
--      GET /rest/v1/sesion_usuario  ->  []
--      GET /rest/v1/codigo_otp      ->  []

-- ============================================================================
-- REVERSIÓN (ejecutar solo si hiciera falta volver atrás)
-- ============================================================================
-- CREATE POLICY "sesion_anon_access" ON sesion_usuario
--   FOR ALL TO public USING (true) WITH CHECK (true);
-- CREATE POLICY "otp_anon_access" ON codigo_otp
--   FOR ALL TO public USING (true) WITH CHECK (true);
-- ============================================================================

-- ============================================================================
-- Migración: retirar EXECUTE público de funciones SECURITY DEFINER del personal
-- Fecha: 2026-11-13
--
-- MOTIVO
--   El advisor de seguridad de Supabase (anon_security_definer_function_executable)
--   detectó que `anon` y `authenticated` podían ejecutar por RPC:
--
--     POST /rest/v1/rpc/crear_operador_seguro
--     POST /rest/v1/rpc/login_personal
--
--   Ambas son SECURITY DEFINER (corren con permisos del propietario y saltan
--   RLS). Como la anon key es pública (va en la web y en el APK):
--
--   - crear_operador_seguro permitía a cualquiera crear un operador ACTIVO con
--     el rol que quisiera (p. ej. administrador) y luego entrar por login-staff.
--   - login_personal permitía probar contraseñas sin los controles de la Edge
--     Function y enumerar usuarios de soporte por la diferencia de mensajes.
--
--   Ningún cliente (web, app) ni Edge Function las invoca por RPC: el login y la
--   gestión del personal pasan por la Edge Function `security` con service_role.
--
-- CAMBIO
--   Se retira EXECUTE a PUBLIC, anon y authenticated. service_role y el
--   propietario (postgres) lo conservan.
--
-- REVERSIÓN (estado previo: EXECUTE para PUBLIC, anon, authenticated, service_role)
--   GRANT EXECUTE ON FUNCTION public.crear_operador_seguro(text, text, text, text, text, text, text, text)
--     TO PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.login_personal(text, text)
--     TO PUBLIC, anon, authenticated;
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.crear_operador_seguro(text, text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.login_personal(text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.crear_operador_seguro(text, text, text, text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.login_personal(text, text)
  TO service_role;

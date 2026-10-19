-- =============================================================================
-- ALERTA CIUDADANA - CIERRE DE ACCESO ANÓNIMO A persona / operador_central
-- Fecha: 2026-10-19
--
-- Contexto: el panel web consultaba esas dos tablas directamente desde el
-- navegador con la clave `anon`, por lo que había que mantener permisos
-- amplios. Todas esas lecturas migraron a la Edge Function `security`
-- (acciones list-operadores, list-personas, list-reportes y db-health), que
-- usa la service_role key dentro del servidor.
--
-- Con este script:
--   * El navegador ya NO puede leer nombres, teléfonos, DNI ni hashes.
--   * La app móvil no se ve afectada: nunca consultó esas tablas directamente
--     (su registro y su login pasan por la Edge Function `security`).
--   * Se eliminan también las políticas "block_all": eran PERMISSIVES, es
--     decir, no denegaban nada (una política permisiva sólo concede).
--
-- Resultado: RLS habilitado y SIN políticas. Únicamente la service_role
-- (bypassrls), usada por las Edge Functions, puede leer o escribir.
-- =============================================================================

-- 1) Eliminar TODAS las políticas existentes sobre esas dos tablas.
DO $$
DECLARE p RECORD;
BEGIN
    FOR p IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'persona'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.persona', p.policyname);
    END LOOP;

    FOR p IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'operador_central'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.operador_central', p.policyname);
    END LOOP;
END $$;

-- 2) RLS habilitado sin políticas => el rol "anon" queda sin acceso alguno.
ALTER TABLE public.persona ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operador_central ENABLE ROW LEVEL SECURITY;

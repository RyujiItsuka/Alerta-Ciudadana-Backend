-- ============================================================================
-- Migración: limpieza de avisos del advisor de Supabase (sin cambio funcional)
-- Fecha: 2026-11-13
--
-- 1) duplicate_index: índices idénticos a otros existentes. Se conservan los
--    que respaldan restricciones (PK / UNIQUE) y uno por columna indexada.
--      persona.dni           -> se conserva persona_dni_key (UNIQUE constraint)
--      operador_central.usuario -> se conserva operador_central_usuario_key (UNIQUE)
--      reporte.fecha_hora    -> se conserva idx_reporte_fecha
--    Nota: supabase/schema.sql, operador_central.sql y sprint4_security.sql
--    crean algunos de estos índices con IF NOT EXISTS; si se re-ejecutan, se
--    recrean (inofensivo, solo vuelve el aviso).
--
-- 2) multiple_permissive_policies: políticas repetidas. Las políticas para el
--    rol {public} ya cubren a anon con la MISMA condición, así que las copias
--    {anon} no aportan nada. En cuenta_soporte había dos políticas idénticas
--    "false" (una política permisiva false no concede nada; el bloqueo real lo
--    da RLS activo sin políticas que concedan acceso).
--    Resultado efectivo de acceso: IDÉNTICO al anterior.
--
-- 3) function_search_path_mutable: se fija search_path en las funciones
--    SECURITY DEFINER (pgcrypto vive en el esquema extensions).
--
-- REVERSIÓN: recrear los índices/políticas con las definiciones del final.
-- ============================================================================

-- 1) Índices duplicados
DROP INDEX IF EXISTS public.idx_persona_dni;
DROP INDEX IF EXISTS public.persona_dni_uidx;
DROP INDEX IF EXISTS public.idx_operador_central_usuario;
DROP INDEX IF EXISTS public.idx_operador_usuario;
DROP INDEX IF EXISTS public.idx_reporte_fecha_hora;

-- 2) Políticas duplicadas
DROP POLICY IF EXISTS reporte_insert_anon ON public.reporte;
DROP POLICY IF EXISTS reporte_select_anon ON public.reporte;
DROP POLICY IF EXISTS ubicacion_insert_anon ON public.ubicacion;
DROP POLICY IF EXISTS ubicacion_select_anon ON public.ubicacion;
DROP POLICY IF EXISTS "Denegar acceso directo a cuenta_soporte" ON public.cuenta_soporte;

-- 3) search_path fijo
ALTER FUNCTION public.crear_operador_seguro(text, text, text, text, text, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.login_personal(text, text)
  SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Definiciones previas (para reversión)
--   CREATE INDEX idx_persona_dni ON public.persona USING btree (dni);
--   CREATE UNIQUE INDEX persona_dni_uidx ON public.persona USING btree (dni);
--   CREATE INDEX idx_operador_central_usuario ON public.operador_central USING btree (usuario);
--   CREATE INDEX idx_operador_usuario ON public.operador_central USING btree (usuario);
--   CREATE INDEX idx_reporte_fecha_hora ON public.reporte USING btree (fecha_hora DESC);
--   CREATE POLICY reporte_insert_anon ON public.reporte FOR INSERT TO anon WITH CHECK (true);
--   CREATE POLICY reporte_select_anon ON public.reporte FOR SELECT TO anon USING (true);
--   CREATE POLICY ubicacion_insert_anon ON public.ubicacion FOR INSERT TO anon WITH CHECK (true);
--   CREATE POLICY ubicacion_select_anon ON public.ubicacion FOR SELECT TO anon USING (true);
--   CREATE POLICY "Denegar acceso directo a cuenta_soporte" ON public.cuenta_soporte FOR ALL TO anon USING (false);
--   ALTER FUNCTION ... RESET search_path;
-- ----------------------------------------------------------------------------

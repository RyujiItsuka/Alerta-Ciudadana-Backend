-- ============================================================================
-- Migración: fase 1 del cierre de acceso anónimo a reporte / ubicacion
-- Fecha: 2026-11-14
--
-- Todo es ADITIVO o de defensa: los clientes actuales (APK y panel) siguen
-- funcionando igual. Ver el documento de diseño, secciones 3.2, 4.4 y 6.
--
-- 1) Columnas de servidor: creado_en (hora real del servidor), origen
--    ('directo' = REST con anon key, 'edge' = Edge Function `reportes`),
--    id_idempotencia (evita duplicados en reintentos) y token_vencido.
-- 2) Límites para inserciones ANÓNIMAS (solo cuando current_user = 'anon';
--    service_role y las Edge Functions no se ven afectados). Habrían frenado
--    los ~90 000 inserts de la prueba de carga de octubre y noviembre.
--    Los umbrales son holgados para no bloquear una emergencia real.
-- 3) Avisos de Realtime Broadcast SIN datos (solo id_reporte / evento) para
--    que el panel deje de depender de postgres_changes. Si el envío falla,
--    NUNCA se bloquea la inserción.
-- ============================================================================

-- 1) Columnas e índices -------------------------------------------------------
-- creado_en se añade SIN default primero y se rellena con la fecha original de
-- cada fila: si las filas existentes recibieran now(), los límites por
-- frecuencia las contarían como recientes y bloquearían inserciones legítimas.
ALTER TABLE public.reporte
  ADD COLUMN IF NOT EXISTS creado_en timestamptz,
  ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'directo',
  ADD COLUMN IF NOT EXISTS id_idempotencia uuid,
  ADD COLUMN IF NOT EXISTS token_vencido boolean NOT NULL DEFAULT false;
UPDATE public.reporte
   SET creado_en = least(coalesce(fecha_hora, now() - interval '1 day'), now() - interval '1 hour')
 WHERE creado_en IS NULL;
ALTER TABLE public.reporte
  ALTER COLUMN creado_en SET DEFAULT now(),
  ALTER COLUMN creado_en SET NOT NULL;

ALTER TABLE public.ubicacion
  ADD COLUMN IF NOT EXISTS creado_en timestamptz;
UPDATE public.ubicacion
   SET creado_en = least(coalesce(fecha_hora, now() - interval '1 day'), now() - interval '1 hour')
 WHERE creado_en IS NULL;
ALTER TABLE public.ubicacion
  ALTER COLUMN creado_en SET DEFAULT now(),
  ALTER COLUMN creado_en SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reporte_id_idempotencia_uidx
  ON public.reporte (id_idempotencia) WHERE id_idempotencia IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reporte_persona_creado
  ON public.reporte (id_persona, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_reporte_origen_creado
  ON public.reporte (origen, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_ubicacion_reporte_creado
  ON public.ubicacion (id_reporte, creado_en DESC);

-- 2) Límites para inserciones anónimas ---------------------------------------
CREATE OR REPLACE FUNCTION public.limitar_insert_anon_reporte()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF current_user <> 'anon' THEN
    RETURN NEW;
  END IF;

  -- Campos que el cliente anónimo no puede fijar.
  NEW.origen := 'directo';
  NEW.id_estado := 1;
  NEW.creado_en := now();
  NEW.token_vencido := false;
  NEW.id_idempotencia := NULL;

  IF NEW.fecha_hora IS NULL OR NEW.fecha_hora > now() + interval '15 minutes' THEN
    NEW.fecha_hora := now();
  END IF;
  IF length(coalesce(NEW.descripcion, '')) > 4000 THEN
    RAISE EXCEPTION 'Descripción demasiado larga' USING ERRCODE = '22001';
  END IF;

  -- Por persona: como máximo 10 reportes cada 10 minutos.
  IF NEW.id_persona IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.reporte
     WHERE id_persona = NEW.id_persona AND creado_en > now() - interval '10 minutes';
    IF v_n >= 10 THEN
      RAISE EXCEPTION 'Demasiados reportes. Espere unos minutos.' USING ERRCODE = 'P0429';
    END IF;
  END IF;

  -- Corte global para inserciones anónimas: 60 por minuto.
  SELECT count(*) INTO v_n FROM public.reporte
   WHERE origen = 'directo' AND creado_en > now() - interval '1 minute';
  IF v_n >= 60 THEN
    RAISE EXCEPTION 'Servicio saturado. Intente nuevamente.' USING ERRCODE = 'P0429';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.limitar_insert_anon_ubicacion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_creado timestamptz;
  v_n integer;
BEGIN
  IF current_user <> 'anon' THEN
    RETURN NEW;
  END IF;

  NEW.creado_en := now();

  IF NEW.latitud IS NULL OR NEW.longitud IS NULL
     OR abs(NEW.latitud) > 90 OR abs(NEW.longitud) > 180 THEN
    RAISE EXCEPTION 'Coordenadas inválidas' USING ERRCODE = '22023';
  END IF;

  SELECT creado_en INTO v_creado FROM public.reporte WHERE id_reporte = NEW.id_reporte;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reporte inexistente' USING ERRCODE = '23503';
  END IF;
  IF v_creado < now() - interval '12 hours' THEN
    RAISE EXCEPTION 'Rastreo vencido para este reporte' USING ERRCODE = 'P0429';
  END IF;

  -- Como máximo 5 puntos cada 5 segundos por reporte (el GPS envía cada ~3 s).
  SELECT count(*) INTO v_n FROM public.ubicacion
   WHERE id_reporte = NEW.id_reporte AND creado_en > now() - interval '5 seconds';
  IF v_n >= 5 THEN
    RAISE EXCEPTION 'Demasiados puntos GPS' USING ERRCODE = 'P0429';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_limitar_insert_anon_reporte ON public.reporte;
CREATE TRIGGER trg_limitar_insert_anon_reporte
  BEFORE INSERT ON public.reporte
  FOR EACH ROW EXECUTE FUNCTION public.limitar_insert_anon_reporte();

DROP TRIGGER IF EXISTS trg_limitar_insert_anon_ubicacion ON public.ubicacion;
CREATE TRIGGER trg_limitar_insert_anon_ubicacion
  BEFORE INSERT ON public.ubicacion
  FOR EACH ROW EXECUTE FUNCTION public.limitar_insert_anon_ubicacion();

-- 3) Avisos de Realtime Broadcast sin datos ----------------------------------
CREATE OR REPLACE FUNCTION public.aviso_realtime_reporte()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('id_reporte', NEW.id_reporte),
      CASE WHEN TG_OP = 'INSERT' THEN 'reporte_nuevo' ELSE 'reporte_actualizado' END,
      'central',
      false
    );
  EXCEPTION WHEN others THEN
    -- Un fallo de Realtime nunca debe impedir registrar una emergencia.
    RAISE WARNING 'aviso_realtime_reporte: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.aviso_realtime_ubicacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      '{}'::jsonb,
      'punto',
      'rastreo:' || NEW.id_reporte::text,
      false
    );
  EXCEPTION WHEN others THEN
    RAISE WARNING 'aviso_realtime_ubicacion: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_aviso_realtime_reporte_ins ON public.reporte;
CREATE TRIGGER trg_aviso_realtime_reporte_ins
  AFTER INSERT ON public.reporte
  FOR EACH ROW EXECUTE FUNCTION public.aviso_realtime_reporte();

DROP TRIGGER IF EXISTS trg_aviso_realtime_reporte_upd ON public.reporte;
CREATE TRIGGER trg_aviso_realtime_reporte_upd
  AFTER UPDATE OF id_estado ON public.reporte
  FOR EACH ROW WHEN (OLD.id_estado IS DISTINCT FROM NEW.id_estado)
  EXECUTE FUNCTION public.aviso_realtime_reporte();

DROP TRIGGER IF EXISTS trg_aviso_realtime_ubicacion ON public.ubicacion;
CREATE TRIGGER trg_aviso_realtime_ubicacion
  AFTER INSERT ON public.ubicacion
  FOR EACH ROW EXECUTE FUNCTION public.aviso_realtime_ubicacion();

-- Las funciones de trigger no deben poder invocarse por RPC.
REVOKE EXECUTE ON FUNCTION public.limitar_insert_anon_reporte() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.limitar_insert_anon_ubicacion() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.aviso_realtime_reporte() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.aviso_realtime_ubicacion() FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- REVERSIÓN
--   DROP TRIGGER trg_aviso_realtime_ubicacion ON public.ubicacion;
--   DROP TRIGGER trg_aviso_realtime_reporte_upd ON public.reporte;
--   DROP TRIGGER trg_aviso_realtime_reporte_ins ON public.reporte;
--   DROP TRIGGER trg_limitar_insert_anon_ubicacion ON public.ubicacion;
--   DROP TRIGGER trg_limitar_insert_anon_reporte ON public.reporte;
--   DROP FUNCTION public.aviso_realtime_ubicacion(), public.aviso_realtime_reporte(),
--                 public.limitar_insert_anon_ubicacion(), public.limitar_insert_anon_reporte();
--   (Las columnas e índices nuevos pueden quedarse: no afectan a los clientes.)
-- ----------------------------------------------------------------------------

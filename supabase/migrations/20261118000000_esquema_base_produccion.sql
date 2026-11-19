-- ============================================================================
-- Migración base: esquema `public` de producción al 2026-11-18
--
-- Generada con:
--   supabase db dump --remote=emtzprcntefzkvvzmhfk --schema public
-- Solo ESTRUCTURA (tablas, funciones, triggers, políticas RLS, permisos).
-- No contiene datos. Los datos de prueba para el entorno local están en
-- supabase/seed.sql.
--
-- Reúne el efecto de todas las migraciones anteriores, que se conservan como
-- historial en supabase/migraciones_historicas/ (no se pueden reaplicar sobre
-- una base vacía: suponían tablas ya existentes y repetían números de versión).
-- Las migraciones nuevas deben llevar timestamp de 14 dígitos posterior a este.
-- ============================================================================




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."aviso_realtime_reporte"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."aviso_realtime_reporte"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."aviso_realtime_ubicacion"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."aviso_realtime_ubicacion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."crear_operador_seguro"("p_usuario" "text", "p_nombres" "text", "p_apellidos" "text", "p_dni" "text", "p_telefono" "text", "p_password" "text", "p_rol" "text", "p_turno" "text" DEFAULT 'Mañana'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
    v_new_id bigint;
BEGIN
    INSERT INTO operador_central (
        usuario,
        nombres,
        apellidos,
        dni,
        telefono,
        password_hash,
        rol,
        turno,
        estado
    ) VALUES (
        TRIM(p_usuario),
        TRIM(p_nombres),
        TRIM(p_apellidos),
        p_dni,
        p_telefono,
        crypt(p_password, gen_salt('bf', 10)),
        p_rol,
        p_turno,
        'activo'
    )
    RETURNING id_operador INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'id_operador', v_new_id);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'El nombre de usuario ya existe');
END;
$$;


ALTER FUNCTION "public"."crear_operador_seguro"("p_usuario" "text", "p_nombres" "text", "p_apellidos" "text", "p_dni" "text", "p_telefono" "text", "p_password" "text", "p_rol" "text", "p_turno" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."limitar_insert_anon_reporte"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."limitar_insert_anon_reporte"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."limitar_insert_anon_ubicacion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."limitar_insert_anon_ubicacion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."login_personal"("p_usuario" "text", "p_password" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
DECLARE
    v_soporte cuenta_soporte%ROWTYPE;
    v_operador operador_central%ROWTYPE;
BEGIN
    -- Fase A: Verificar si es Superadmin en cuenta_soporte
    SELECT * INTO v_soporte
    FROM cuenta_soporte
    WHERE LOWER(usuario) = LOWER(TRIM(p_usuario));

    IF FOUND THEN
        IF v_soporte.password_hash LIKE '$2%'
           AND v_soporte.password_hash = crypt(p_password, v_soporte.password_hash) THEN
            
            UPDATE cuenta_soporte 
            SET ultimo_acceso = NOW() 
            WHERE id_soporte = v_soporte.id_soporte;

            RETURN jsonb_build_object(
                'success', true,
                'id', 'SA-' || v_soporte.id_soporte,
                'usuario', v_soporte.usuario,
                'nombre', v_soporte.nombres || ' ' || v_soporte.apellidos,
                'rol', 'superadmin',
                'cargo', 'Soporte Técnico & Desarrollador'
            );
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'Contraseña de soporte incorrecta');
        END IF;
    END IF;

    -- Fase B: Verificar si es Administrador o Técnico en operador_central
    SELECT * INTO v_operador
    FROM operador_central
    WHERE LOWER(usuario) = LOWER(TRIM(p_usuario));

    IF FOUND THEN
        IF v_operador.estado = 'suspendido' OR v_operador.estado = 'inactivo' THEN
            RETURN jsonb_build_object('success', false, 'error', 'Tu cuenta se encuentra suspendida o inactiva');
        END IF;

        IF v_operador.password_hash LIKE '$2%'
           AND v_operador.password_hash = crypt(p_password, v_operador.password_hash) THEN

            UPDATE operador_central SET ultimo_acceso = NOW() WHERE id_operador = v_operador.id_operador;

            RETURN jsonb_build_object(
                'success', true,
                'id', 'OP-' || v_operador.id_operador,
                'usuario', v_operador.usuario,
                'nombre', v_operador.nombres || ' ' || v_operador.apellidos,
                'rol', v_operador.rol,
                'cargo', CASE WHEN v_operador.rol = 'administrador' THEN 'Administrador General de Central' ELSE 'Técnico de Central de Alertas' END,
                'turno', v_operador.turno
            );
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'Contraseña incorrecta');
        END IF;
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'Usuario no registrado en el sistema');
END;
$_$;


ALTER FUNCTION "public"."login_personal"("p_usuario" "text", "p_password" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."codigo_otp" (
    "id_otp" bigint NOT NULL,
    "dni" character varying(15) NOT NULL,
    "telefono" character varying(20) NOT NULL,
    "codigo" character varying(6) NOT NULL,
    "expira_en" timestamp with time zone NOT NULL,
    "usado" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "intentos" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."codigo_otp" OWNER TO "postgres";


COMMENT ON TABLE "public"."codigo_otp" IS 'OTP. Gestionado por Edge Function security.';



ALTER TABLE "public"."codigo_otp" ALTER COLUMN "id_otp" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."codigo_otp_id_otp_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."configuracion_sistema" (
    "clave" character varying(64) NOT NULL,
    "valor" "text" DEFAULT ''::"text" NOT NULL,
    "descripcion" "text",
    "actualizado_por" character varying(50),
    "actualizado_en" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."configuracion_sistema" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cuenta_soporte" (
    "id_soporte" bigint NOT NULL,
    "usuario" character varying(50) NOT NULL,
    "nombres" character varying(100) NOT NULL,
    "apellidos" character varying(100) NOT NULL,
    "email" character varying(100),
    "password_hash" character varying(255) NOT NULL,
    "rol" character varying(20) DEFAULT 'superadmin'::character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "ultimo_acceso" timestamp with time zone,
    CONSTRAINT "cuenta_soporte_rol_check" CHECK ((("rol")::"text" = 'superadmin'::"text"))
);


ALTER TABLE "public"."cuenta_soporte" OWNER TO "postgres";


ALTER TABLE "public"."cuenta_soporte" ALTER COLUMN "id_soporte" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."cuenta_soporte_id_soporte_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."estado_reporte" (
    "id_estado" integer NOT NULL,
    "nombre" character varying(50) NOT NULL,
    "descripcion" character varying(255)
);


ALTER TABLE "public"."estado_reporte" OWNER TO "postgres";


ALTER TABLE "public"."estado_reporte" ALTER COLUMN "id_estado" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."estado_reporte_id_estado_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."operador_central" (
    "id_operador" bigint NOT NULL,
    "usuario" character varying(50) NOT NULL,
    "nombres" character varying(100) NOT NULL,
    "apellidos" character varying(100) NOT NULL,
    "telefono" character varying(20),
    "password_hash" character varying(255) NOT NULL,
    "rol" character varying(20) NOT NULL,
    "turno" character varying(30) DEFAULT 'Mañana'::character varying,
    "estado" character varying(20) DEFAULT 'activo'::character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "ultimo_acceso" timestamp with time zone,
    "dni" character varying(15),
    CONSTRAINT "operador_central_estado_check" CHECK ((("estado")::"text" = ANY ((ARRAY['activo'::character varying, 'inactivo'::character varying, 'suspendido'::character varying])::"text"[]))),
    CONSTRAINT "operador_central_rol_check" CHECK ((("rol")::"text" = ANY ((ARRAY['administrador'::character varying, 'tecnico'::character varying])::"text"[])))
);


ALTER TABLE "public"."operador_central" OWNER TO "postgres";


ALTER TABLE "public"."operador_central" ALTER COLUMN "id_operador" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."operador_central_id_operador_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."persona" (
    "id_persona" bigint NOT NULL,
    "dni" character varying(15) NOT NULL,
    "nombres" character varying(100) NOT NULL,
    "apellidos" character varying(100) NOT NULL,
    "telefono" character varying(20) NOT NULL,
    "pin_hash" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "password_hash" character varying(255),
    "rol" character varying(20) DEFAULT 'ciudadano'::character varying,
    "intentos_fallidos" integer DEFAULT 0,
    "bloqueado_hasta" timestamp with time zone,
    "direccion" character varying(255)
);


ALTER TABLE "public"."persona" OWNER TO "postgres";


COMMENT ON TABLE "public"."persona" IS 'Ciudadanos. Acceso solo vía Edge Function security (service_role). RLS bloquea anon.';



ALTER TABLE "public"."persona" ALTER COLUMN "id_persona" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."persona_id_persona_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."reniec_cache" (
    "dni" "text" NOT NULL,
    "payload" "jsonb",
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reniec_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reporte" (
    "id_reporte" bigint NOT NULL,
    "id_persona" bigint,
    "id_tipo" integer,
    "id_estado" integer DEFAULT 1,
    "fecha_hora" timestamp with time zone DEFAULT "now"(),
    "descripcion" "text",
    "direccion_texto" character varying(255),
    "fotos" "jsonb" DEFAULT '[]'::"jsonb",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "origen" "text" DEFAULT 'directo'::"text" NOT NULL,
    "id_idempotencia" "uuid",
    "token_vencido" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."reporte" OWNER TO "postgres";


COMMENT ON TABLE "public"."reporte" IS 'Emergencias. Anon: INSERT/SELECT/UPDATE (central).';



ALTER TABLE "public"."reporte" ALTER COLUMN "id_reporte" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."reporte_id_reporte_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."sesion_usuario" (
    "id_sesion" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "id_persona" bigint,
    "dni" character varying(15) NOT NULL,
    "token_jwt" "text" NOT NULL,
    "dispositivo_info" character varying(255),
    "revocado" boolean DEFAULT false NOT NULL,
    "expira_en" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sesion_usuario" OWNER TO "postgres";


COMMENT ON TABLE "public"."sesion_usuario" IS 'Sesiones JWT. Gestionado por Edge Function security.';



CREATE TABLE IF NOT EXISTS "public"."tipo_incidencia" (
    "id_tipo" integer NOT NULL,
    "nombre" character varying(50) NOT NULL,
    "descripcion" character varying(255)
);


ALTER TABLE "public"."tipo_incidencia" OWNER TO "postgres";


ALTER TABLE "public"."tipo_incidencia" ALTER COLUMN "id_tipo" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."tipo_incidencia_id_tipo_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."ubicacion" (
    "id_ubicacion" bigint NOT NULL,
    "id_reporte" bigint,
    "latitud" double precision NOT NULL,
    "longitud" double precision NOT NULL,
    "fecha_hora" timestamp with time zone DEFAULT "now"(),
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ubicacion" OWNER TO "postgres";


COMMENT ON TABLE "public"."ubicacion" IS 'Puntos GPS. Anon: INSERT/SELECT.';



ALTER TABLE "public"."ubicacion" ALTER COLUMN "id_ubicacion" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."ubicacion_id_ubicacion_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."codigo_otp"
    ADD CONSTRAINT "codigo_otp_pkey" PRIMARY KEY ("id_otp");



ALTER TABLE ONLY "public"."configuracion_sistema"
    ADD CONSTRAINT "configuracion_sistema_pkey" PRIMARY KEY ("clave");



ALTER TABLE ONLY "public"."cuenta_soporte"
    ADD CONSTRAINT "cuenta_soporte_pkey" PRIMARY KEY ("id_soporte");



ALTER TABLE ONLY "public"."cuenta_soporte"
    ADD CONSTRAINT "cuenta_soporte_usuario_key" UNIQUE ("usuario");



ALTER TABLE ONLY "public"."estado_reporte"
    ADD CONSTRAINT "estado_reporte_nombre_key" UNIQUE ("nombre");



ALTER TABLE ONLY "public"."estado_reporte"
    ADD CONSTRAINT "estado_reporte_pkey" PRIMARY KEY ("id_estado");



ALTER TABLE ONLY "public"."operador_central"
    ADD CONSTRAINT "operador_central_pkey" PRIMARY KEY ("id_operador");



ALTER TABLE ONLY "public"."operador_central"
    ADD CONSTRAINT "operador_central_usuario_key" UNIQUE ("usuario");



ALTER TABLE ONLY "public"."persona"
    ADD CONSTRAINT "persona_dni_key" UNIQUE ("dni");



ALTER TABLE ONLY "public"."persona"
    ADD CONSTRAINT "persona_pkey" PRIMARY KEY ("id_persona");



ALTER TABLE ONLY "public"."reniec_cache"
    ADD CONSTRAINT "reniec_cache_pkey" PRIMARY KEY ("dni");



ALTER TABLE ONLY "public"."reporte"
    ADD CONSTRAINT "reporte_pkey" PRIMARY KEY ("id_reporte");



ALTER TABLE ONLY "public"."sesion_usuario"
    ADD CONSTRAINT "sesion_usuario_pkey" PRIMARY KEY ("id_sesion");



ALTER TABLE ONLY "public"."tipo_incidencia"
    ADD CONSTRAINT "tipo_incidencia_nombre_key" UNIQUE ("nombre");



ALTER TABLE ONLY "public"."tipo_incidencia"
    ADD CONSTRAINT "tipo_incidencia_pkey" PRIMARY KEY ("id_tipo");



ALTER TABLE ONLY "public"."ubicacion"
    ADD CONSTRAINT "ubicacion_pkey" PRIMARY KEY ("id_ubicacion");



CREATE INDEX "idx_cuenta_soporte_usuario" ON "public"."cuenta_soporte" USING "btree" ("usuario");



CREATE INDEX "idx_operador_rol" ON "public"."operador_central" USING "btree" ("rol");



CREATE INDEX "idx_otp_dni_tel" ON "public"."codigo_otp" USING "btree" ("dni", "telefono", "expira_en");



CREATE INDEX "idx_reporte_fecha" ON "public"."reporte" USING "btree" ("fecha_hora" DESC);



CREATE INDEX "idx_reporte_origen_creado" ON "public"."reporte" USING "btree" ("origen", "creado_en" DESC);



CREATE INDEX "idx_reporte_persona_creado" ON "public"."reporte" USING "btree" ("id_persona", "creado_en" DESC);



CREATE INDEX "idx_sesion_dni" ON "public"."sesion_usuario" USING "btree" ("dni", "revocado", "expira_en");



CREATE INDEX "idx_sesion_usuario_token_jwt" ON "public"."sesion_usuario" USING "btree" ("token_jwt");



CREATE INDEX "idx_ubicacion_id_reporte" ON "public"."ubicacion" USING "btree" ("id_reporte");



CREATE INDEX "idx_ubicacion_reporte" ON "public"."ubicacion" USING "btree" ("id_reporte", "fecha_hora" DESC);



CREATE INDEX "idx_ubicacion_reporte_creado" ON "public"."ubicacion" USING "btree" ("id_reporte", "creado_en" DESC);



CREATE UNIQUE INDEX "reporte_id_idempotencia_uidx" ON "public"."reporte" USING "btree" ("id_idempotencia") WHERE ("id_idempotencia" IS NOT NULL);



CREATE OR REPLACE TRIGGER "trg_aviso_realtime_reporte_ins" AFTER INSERT ON "public"."reporte" FOR EACH ROW EXECUTE FUNCTION "public"."aviso_realtime_reporte"();



CREATE OR REPLACE TRIGGER "trg_aviso_realtime_reporte_upd" AFTER UPDATE OF "id_estado" ON "public"."reporte" FOR EACH ROW WHEN (("old"."id_estado" IS DISTINCT FROM "new"."id_estado")) EXECUTE FUNCTION "public"."aviso_realtime_reporte"();



CREATE OR REPLACE TRIGGER "trg_aviso_realtime_ubicacion" AFTER INSERT ON "public"."ubicacion" FOR EACH ROW EXECUTE FUNCTION "public"."aviso_realtime_ubicacion"();



CREATE OR REPLACE TRIGGER "trg_limitar_insert_anon_reporte" BEFORE INSERT ON "public"."reporte" FOR EACH ROW EXECUTE FUNCTION "public"."limitar_insert_anon_reporte"();



CREATE OR REPLACE TRIGGER "trg_limitar_insert_anon_ubicacion" BEFORE INSERT ON "public"."ubicacion" FOR EACH ROW EXECUTE FUNCTION "public"."limitar_insert_anon_ubicacion"();



ALTER TABLE ONLY "public"."reporte"
    ADD CONSTRAINT "reporte_id_estado_fkey" FOREIGN KEY ("id_estado") REFERENCES "public"."estado_reporte"("id_estado");



ALTER TABLE ONLY "public"."reporte"
    ADD CONSTRAINT "reporte_id_persona_fkey" FOREIGN KEY ("id_persona") REFERENCES "public"."persona"("id_persona") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reporte"
    ADD CONSTRAINT "reporte_id_tipo_fkey" FOREIGN KEY ("id_tipo") REFERENCES "public"."tipo_incidencia"("id_tipo");



ALTER TABLE ONLY "public"."sesion_usuario"
    ADD CONSTRAINT "sesion_usuario_id_persona_fkey" FOREIGN KEY ("id_persona") REFERENCES "public"."persona"("id_persona") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ubicacion"
    ADD CONSTRAINT "ubicacion_id_reporte_fkey" FOREIGN KEY ("id_reporte") REFERENCES "public"."reporte"("id_reporte") ON DELETE CASCADE;



ALTER TABLE "public"."codigo_otp" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."configuracion_sistema" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cuenta_soporte" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cuenta_soporte_block_all_anon" ON "public"."cuenta_soporte" TO "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."estado_reporte" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "estado_reporte_lectura" ON "public"."estado_reporte" FOR SELECT USING (true);



ALTER TABLE "public"."operador_central" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "otp_block_all_anon" ON "public"."codigo_otp" TO "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."persona" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reniec_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reporte" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reporte_insert_policy" ON "public"."reporte" FOR INSERT WITH CHECK (true);



CREATE POLICY "reporte_select_policy" ON "public"."reporte" FOR SELECT USING (true);



CREATE POLICY "sesion_block_all_anon" ON "public"."sesion_usuario" TO "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."sesion_usuario" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tipo_incidencia" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tipo_incidencia_lectura" ON "public"."tipo_incidencia" FOR SELECT USING (true);



ALTER TABLE "public"."ubicacion" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ubicacion_delete_anon" ON "public"."ubicacion" FOR DELETE TO "anon" USING (false);



CREATE POLICY "ubicacion_insert_policy" ON "public"."ubicacion" FOR INSERT WITH CHECK (true);



CREATE POLICY "ubicacion_select_policy" ON "public"."ubicacion" FOR SELECT USING (true);



CREATE POLICY "ubicacion_update_anon" ON "public"."ubicacion" FOR UPDATE TO "anon" USING (false) WITH CHECK (false);



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."aviso_realtime_reporte"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."aviso_realtime_reporte"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."aviso_realtime_ubicacion"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."aviso_realtime_ubicacion"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."crear_operador_seguro"("p_usuario" "text", "p_nombres" "text", "p_apellidos" "text", "p_dni" "text", "p_telefono" "text", "p_password" "text", "p_rol" "text", "p_turno" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."crear_operador_seguro"("p_usuario" "text", "p_nombres" "text", "p_apellidos" "text", "p_dni" "text", "p_telefono" "text", "p_password" "text", "p_rol" "text", "p_turno" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."limitar_insert_anon_reporte"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."limitar_insert_anon_reporte"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."limitar_insert_anon_ubicacion"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."limitar_insert_anon_ubicacion"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."login_personal"("p_usuario" "text", "p_password" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."login_personal"("p_usuario" "text", "p_password" "text") TO "service_role";



GRANT ALL ON TABLE "public"."codigo_otp" TO "anon";
GRANT ALL ON TABLE "public"."codigo_otp" TO "authenticated";
GRANT ALL ON TABLE "public"."codigo_otp" TO "service_role";



GRANT ALL ON SEQUENCE "public"."codigo_otp_id_otp_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."codigo_otp_id_otp_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."codigo_otp_id_otp_seq" TO "service_role";



GRANT ALL ON TABLE "public"."configuracion_sistema" TO "anon";
GRANT ALL ON TABLE "public"."configuracion_sistema" TO "authenticated";
GRANT ALL ON TABLE "public"."configuracion_sistema" TO "service_role";



GRANT ALL ON TABLE "public"."cuenta_soporte" TO "anon";
GRANT ALL ON TABLE "public"."cuenta_soporte" TO "authenticated";
GRANT ALL ON TABLE "public"."cuenta_soporte" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cuenta_soporte_id_soporte_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cuenta_soporte_id_soporte_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cuenta_soporte_id_soporte_seq" TO "service_role";



GRANT ALL ON TABLE "public"."estado_reporte" TO "anon";
GRANT ALL ON TABLE "public"."estado_reporte" TO "authenticated";
GRANT ALL ON TABLE "public"."estado_reporte" TO "service_role";



GRANT ALL ON SEQUENCE "public"."estado_reporte_id_estado_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."estado_reporte_id_estado_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."estado_reporte_id_estado_seq" TO "service_role";



GRANT ALL ON TABLE "public"."operador_central" TO "anon";
GRANT ALL ON TABLE "public"."operador_central" TO "authenticated";
GRANT ALL ON TABLE "public"."operador_central" TO "service_role";



GRANT ALL ON SEQUENCE "public"."operador_central_id_operador_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."operador_central_id_operador_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."operador_central_id_operador_seq" TO "service_role";



GRANT ALL ON TABLE "public"."persona" TO "anon";
GRANT ALL ON TABLE "public"."persona" TO "authenticated";
GRANT ALL ON TABLE "public"."persona" TO "service_role";



GRANT ALL ON SEQUENCE "public"."persona_id_persona_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."persona_id_persona_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."persona_id_persona_seq" TO "service_role";



GRANT ALL ON TABLE "public"."reniec_cache" TO "anon";
GRANT ALL ON TABLE "public"."reniec_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."reniec_cache" TO "service_role";



GRANT ALL ON TABLE "public"."reporte" TO "anon";
GRANT ALL ON TABLE "public"."reporte" TO "authenticated";
GRANT ALL ON TABLE "public"."reporte" TO "service_role";



GRANT ALL ON SEQUENCE "public"."reporte_id_reporte_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."reporte_id_reporte_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."reporte_id_reporte_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sesion_usuario" TO "anon";
GRANT ALL ON TABLE "public"."sesion_usuario" TO "authenticated";
GRANT ALL ON TABLE "public"."sesion_usuario" TO "service_role";



GRANT ALL ON TABLE "public"."tipo_incidencia" TO "anon";
GRANT ALL ON TABLE "public"."tipo_incidencia" TO "authenticated";
GRANT ALL ON TABLE "public"."tipo_incidencia" TO "service_role";



GRANT ALL ON SEQUENCE "public"."tipo_incidencia_id_tipo_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tipo_incidencia_id_tipo_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tipo_incidencia_id_tipo_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ubicacion" TO "anon";
GRANT ALL ON TABLE "public"."ubicacion" TO "authenticated";
GRANT ALL ON TABLE "public"."ubicacion" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ubicacion_id_ubicacion_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ubicacion_id_ubicacion_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ubicacion_id_ubicacion_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";









-- Realtime: el panel usa postgres_changes sobre estas tablas durante la
-- transición (fase 2). En producción ya están en la publicación.
ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."reporte", "public"."ubicacion";

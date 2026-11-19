-- ============================================================================
-- Datos de prueba SOLO para el entorno local (supabase start / db reset).
-- Nunca se aplican a producción.
--
-- Cuentas de prueba (solo existen en tu Supabase local):
--   Ciudadano  -> DNI 00000001, contraseña "AlertaLocal-2026!", PIN 1234,
--                 teléfono 51900000001 (ficticio)
--   Operador   -> usuario "admin.local", contraseña "AlertaLocal-2026!",
--                 rol administrador
--   Técnico    -> usuario "tecnico.local", contraseña "AlertaLocal-2026!"
--
-- El número de la Central es ficticio: en local no se envían WhatsApp reales
-- (ver supabase/functions/.env.example).
-- ============================================================================

-- Catálogos (mismos valores que producción) ---------------------------------
INSERT INTO public.tipo_incidencia (id_tipo, nombre, descripcion) VALUES
  (1, 'ROBO', 'Asaltos, robos a mano armada o botón de pánico SOS'),
  (2, 'ACCIDENTE', 'Accidentes vehiculares, atropellos o impacto detectado'),
  (3, 'INCENDIO', 'Incendios, fugas de gas o fuego activo'),
  (4, 'GRESCA', 'Peleas callejeras, disturbios o desorden público'),
  (5, 'ASESINATO', 'Atentados, homicidios o violencia extrema'),
  (6, 'SECUESTRO', 'Privación de la libertad o rapto (alta prioridad y GPS en vivo)'),
  (7, 'PERSONALIZADO', 'Reporte con descripción libre y fotos/evidencias')
ON CONFLICT (id_tipo) DO NOTHING;

INSERT INTO public.estado_reporte (id_estado, nombre, descripcion) VALUES
  (1, 'Pendiente', 'Alerta recibida y pendiente de despacho por la Central de Monitoreo'),
  (2, 'En camino', 'Unidad de serenazgo despachada y en camino al lugar de la emergencia'),
  (3, 'Atendida', 'Incidencia atendida y cerrada por la Central'),
  (4, 'Falsa alarma', 'Alerta descartada: activación accidental o sin emergencia real')
ON CONFLICT (id_estado) DO NOTHING;

SELECT setval('public.estado_reporte_id_estado_seq', (SELECT max(id_estado) FROM public.estado_reporte));

INSERT INTO public.configuracion_sistema (clave, valor, descripcion, actualizado_por) VALUES
  ('whatsapp_central', '51900000000',
   'Número de WhatsApp de la Central (FICTICIO en local)', 'seed')
ON CONFLICT (clave) DO NOTHING;

-- Cuentas de prueba ---------------------------------------------------------
INSERT INTO public.persona (dni, nombres, apellidos, telefono, pin_hash, password_hash, rol)
VALUES (
  '00000001', 'Ciudadano', 'Prueba Local', '51900000001',
  extensions.crypt('1234', extensions.gen_salt('bf', 10)),
  extensions.crypt('AlertaLocal-2026!', extensions.gen_salt('bf', 10)),
  'ciudadano'
);

INSERT INTO public.operador_central (usuario, nombres, apellidos, dni, telefono, password_hash, rol, turno, estado)
VALUES
  ('admin.local', 'Admin', 'Prueba Local', '00000002', '51900000002',
   extensions.crypt('AlertaLocal-2026!', extensions.gen_salt('bf', 10)),
   'administrador', 'Mañana', 'activo'),
  ('tecnico.local', 'Técnico', 'Prueba Local', '00000003', '51900000003',
   extensions.crypt('AlertaLocal-2026!', extensions.gen_salt('bf', 10)),
   'tecnico', 'Tarde', 'activo');

-- Un reporte de ejemplo con recorrido GPS (Plaza de Armas de Pisco) ----------
WITH r AS (
  INSERT INTO public.reporte (id_persona, id_tipo, id_estado, descripcion, direccion_texto,
                              fecha_hora, creado_en, origen)
  SELECT id_persona, 1, 1, 'Reporte de ejemplo del entorno local', 'Plaza de Armas, Pisco',
         now() - interval '20 minutes', now() - interval '20 minutes', 'edge'
    FROM public.persona WHERE dni = '00000001'
  RETURNING id_reporte
)
INSERT INTO public.ubicacion (id_reporte, latitud, longitud, fecha_hora, creado_en)
SELECT r.id_reporte, -13.7102 + g * 0.0003, -76.2051 + g * 0.0002,
       now() - interval '20 minutes' + g * interval '1 minute',
       now() - interval '20 minutes' + g * interval '1 minute'
  FROM r, generate_series(0, 9) AS g;

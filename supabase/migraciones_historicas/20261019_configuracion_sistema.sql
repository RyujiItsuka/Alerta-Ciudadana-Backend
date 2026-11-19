-- ==============================================================================
-- ALERTA CIUDADANA - CONFIGURACIÓN DEL SISTEMA (PARÁMETROS EDITABLES)
-- Fecha: 2026-10-19
--
-- Permite que el panel web (superadmin / administrador) modifique parámetros
-- de despacho SIN recompilar la app. Primer uso: el número de WhatsApp al que
-- se envían las alertas, en caso de que la Central cambie de número.
--
-- Diseño:
--   * Tabla clave/valor con RLS habilitado y SIN políticas para `anon`.
--     Por eso sólo la Edge Function `security` (service_role) puede leerla o
--     escribirla. El destino del WhatsApp lo resuelve SIEMPRE el servidor, así
--     que el APK nunca conoce ni el número configurado.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS configuracion_sistema (
    clave           VARCHAR(64) PRIMARY KEY,
    valor           TEXT NOT NULL DEFAULT '',
    descripcion     TEXT,
    actualizado_por VARCHAR(50),
    actualizado_en  TIMESTAMPTZ DEFAULT NOW()
);

-- RLS activo SIN políticas => el rol "anon" NO puede leer ni escribir.
ALTER TABLE configuracion_sistema ENABLE ROW LEVEL SECURITY;

-- Dato inicial: número de WhatsApp de la Central (destino de las alertas).
-- Formato: solo dígitos, con código de país (51 + 9 dígitos).
INSERT INTO configuracion_sistema (clave, valor, descripcion)
VALUES (
    'whatsapp_central',
    '51976264949',
    'Número de WhatsApp de la Central (destino de las alertas de emergencia)'
)
ON CONFLICT (clave) DO NOTHING;

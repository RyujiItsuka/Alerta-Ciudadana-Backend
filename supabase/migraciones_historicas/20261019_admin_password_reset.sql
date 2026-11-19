-- =============================================================================
-- ALERTA CIUDADANA - CONTRASEÑA DEL ADMINISTRADOR EN FORMATO BCRYPT
-- Fecha: 2026-10-19
--
-- El seed de operador_central usaba `ON CONFLICT (usuario) DO NOTHING`, por lo
-- que la fila de "admin" conservó la contraseña legada en TEXTO PLANO y nunca
-- se re-hasheó con bcrypt. Este script la deja en formato seguro.
--
-- IMPORTANTE: la contraseña real NO se versiona. Ejecute el script con la
-- clave definitiva generando el hash con:
--
--   SELECT crypt('TU_CLAVE_AQUI', gen_salt('bf', 10));
--
-- Requiere la extensión pgcrypto (ya instalada en este proyecto).
-- =============================================================================

UPDATE public.operador_central
SET password_hash = crypt(
    'CAMBIAR_ESTA_CLAVE_ANTES_DE_EJECUTAR',
    gen_salt('bf', 10)
)
WHERE usuario = 'admin';

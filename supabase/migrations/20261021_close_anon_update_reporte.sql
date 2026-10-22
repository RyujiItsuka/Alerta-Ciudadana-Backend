-- ============================================================================
-- Migración: cierre de la actualización anónima de reportes
-- Fecha: 2026-10-21
-- Tarea: SP6-03 (matriz de cumplimiento de seguridad)
--
-- MOTIVO
--   La auditoría de seguridad contra la base de datos de producción detectó que
--   la tabla `reporte` tenía DOS políticas de UPDATE permisivas para el rol anon
--   (y para public), ambas con USING (true) WITH CHECK (true):
--
--     reporte_update_anon    (roles {anon})
--     reporte_update_policy  (roles {anon})
--
--   Con la anon key (que es pública y viaja dentro del APK), cualquiera podía
--   MODIFICAR CUALQUIER REPORTE: cambiar su estado, su descripción o su tipo.
--   En un sistema de emergencias esto permitía, por ejemplo, marcar una alerta
--   real como "Falsa alarma" o reasignar su estado.
--
--   CAUSA
--   La actualización de estado la hacía el panel web DIRECTAMENTE con la anon
--   key (supabase.from('reporte').update(...)), y las políticas se abrieron para
--   que eso funcionara. Esas políticas eran un parche, no un diseño.
--
-- SOLUCIÓN (sin romper el panel)
--   La actualización de estado se movió al servidor: nueva acción
--   `update-reporte-estado` en la Edge Function `security`, que exige un token
--   de staff válido (`requireStaff`) y valida el rango de estados (1..4).
--   El panel web (App.tsx -> handleUpdateStatus) ya usa esa acción.
--
--   Verificación previa a este cierre (con el token real del staff):
--     update-reporte-estado  id_estado=2   -> 200 {"success":true}
--     update-reporte-estado  id_estado=99  -> 400 "id_estado inválido."
--     update-reporte-estado  sin token     -> 401 "No autorizado"
--
--   Por lo tanto, las políticas de UPDATE anónimo ya NO son necesarias.
--
-- ALCANCE
--   Solo se eliminan las políticas de UPDATE de `reporte`.
--   NO se tocan las de INSERT y SELECT:
--     - `reporte_insert_*`: la app móvil inserta alertas directo (anon).
--     - `reporte_select_*`: el panel web lee las alertas (anon).
--   `ubicacion` no se toca: su UPDATE/DELETE ya estaban bloqueados (false) y
--   solo conserva INSERT/SELECT para el rastreo GPS de la app.
--
-- REVERSIÓN
--   Al final del archivo, en el bloque comentado "REVERSIÓN".
-- ============================================================================

-- 1. Eliminar las dos políticas de UPDATE anónimo sobre reporte ---------------
DROP POLICY IF EXISTS "reporte_update_anon"   ON reporte;
DROP POLICY IF EXISTS "reporte_update_policy" ON reporte;

-- 2. Confirmar que RLS sigue activo ------------------------------------------
ALTER TABLE reporte ENABLE ROW LEVEL SECURITY;

-- 3. Estado esperado de las políticas de reporte tras esta migración ---------
--    reporte_insert_anon / reporte_insert_policy   (INSERT, anon/public)
--    reporte_select_anon / reporte_select_policy   (SELECT, anon/public)
--    (sin políticas de UPDATE para anon)

-- ============================================================================
-- REVERSIÓN (ejecutar solo si hiciera falta volver atrás)
-- ============================================================================
-- CREATE POLICY "reporte_update_anon" ON reporte
--   FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- ============================================================================

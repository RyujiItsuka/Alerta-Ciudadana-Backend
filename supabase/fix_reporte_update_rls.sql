-- ==============================================================================
-- ALERTA CIUDADANA - CORRECCIÓN DE PERSISTENCIA Y RLS PARA ESTADO DE REPORTES
-- Permite que los cambios de estado (Pendiente -> En camino -> Atendida)
-- se guarden de forma definitiva en la base de datos de Supabase.
-- ==============================================================================

-- 1. Asegurar catálogo de estados con sus IDs oficiales
INSERT INTO estado_reporte (id_estado, nombre, descripcion) VALUES 
(1, 'Pendiente', 'Alerta en espera de despacho en central'),
(2, 'En camino', 'Patrulla o sereno asignado y en ruta'),
(3, 'Atendida', 'Incidencia resuelta y archivada'),
(4, 'Falsa alarma', 'Alerta descartada o activación accidental')
ON CONFLICT (id_estado) DO UPDATE 
SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion;

-- 2. Habilitar política de UPDATE en la tabla reporte
-- Sin esta política, PostgreSQL con RLS bloquea silenciosamente cualquier actualización de estado.
DROP POLICY IF EXISTS "reporte_update_policy" ON reporte;
CREATE POLICY "reporte_update_policy" ON reporte 
    FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- 3. Confirmar que la tabla reporte tenga RLS activo con permisos completos para la aplicación
ALTER TABLE reporte ENABLE ROW LEVEL SECURITY;

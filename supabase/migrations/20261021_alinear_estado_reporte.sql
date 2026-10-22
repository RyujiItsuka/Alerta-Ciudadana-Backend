-- ============================================================================
-- Migración: alinear los nombres de estado_reporte con el panel web
-- Fecha: 2026-10-21
-- Tarea: SP6-03 (matriz de cumplimiento de seguridad)
--
-- MOTIVO
--   La auditoría detectó que el panel web y la base de datos usaban nombres
--   distintos para los mismos estados, con un efecto real en la operación:
--
--     id_estado | Base de datos (antes) | Panel web (etiqueta mostrada)
--     ----------+-----------------------+------------------------------
--         1     | Enviado               | PENDIENTE
--         2     | No enviado            | EN CAMINO     <-- INCORRECTO
--         3     | Atendida              | ATENDIDA
--         4     | Falsa alarma          | FALSA ALARMA
--
--   El operador veía "EN CAMINO" cuando en realidad el estado significaba
--   "No enviado" (la alerta falló por corte de red). Los nombres en conflicto
--   provienen de definiciones de seed contradictorias en el repositorio.
--
-- DECISIÓN
--   Se adopta el esquema que el panel y la operación ya usan (4 estados), y se
--   actualizan los nombres y descripciones en la base de datos para que digan
--   lo mismo. No se cambian los identificadores (1 a 4), por lo que ningún dato
--   existente se ve afectado: solo se corrigen las etiquetas.
--
-- REVERSIÓN
--   Al final del archivo, en el bloque comentado "REVERSIÓN".
-- ============================================================================

UPDATE estado_reporte SET
  nombre = 'Pendiente',
  descripcion = 'Alerta recibida y pendiente de despacho por la Central de Monitoreo'
WHERE id_estado = 1;

UPDATE estado_reporte SET
  nombre = 'En camino',
  descripcion = 'Unidad de serenazgo despachada y en camino al lugar de la emergencia'
WHERE id_estado = 2;

UPDATE estado_reporte SET
  nombre = 'Atendida',
  descripcion = 'Incidencia atendida y cerrada por la Central'
WHERE id_estado = 3;

UPDATE estado_reporte SET
  nombre = 'Falsa alarma',
  descripcion = 'Alerta descartada: activación accidental o sin emergencia real'
WHERE id_estado = 4;

-- ============================================================================
-- REVERSIÓN (ejecutar solo si hiciera falta volver atrás)
-- ============================================================================
-- UPDATE estado_reporte SET nombre='Enviado',
--   descripcion='Alerta procesada y despachada a la central de monitoreo' WHERE id_estado=1;
-- UPDATE estado_reporte SET nombre='No enviado',
--   descripcion='Alerta fallida por corte de red o error de conexión' WHERE id_estado=2;
-- UPDATE estado_reporte SET nombre='Atendida',
--   descripcion='Incidencia resuelta y cerrada' WHERE id_estado=3;
-- UPDATE estado_reporte SET nombre='Falsa alarma',
--   descripcion='Alerta descartada' WHERE id_estado=4;
-- ============================================================================

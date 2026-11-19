# Migraciones históricas

Migraciones aplicadas en producción entre el 2026-10-18 y el 2026-11-14. Se
conservan como historial y documentación (motivo, cambio y reversión de cada
una).

**No se aplican automáticamente.** Su efecto completo está incluido en
`supabase/migrations/20261118000000_esquema_base_produccion.sql`, generado a
partir del esquema real de producción. No pueden reaplicarse sobre una base
vacía porque suponen tablas ya existentes y varias comparten número de
versión (por ejemplo, tres archivos `20261019_*`), que la CLI de Supabase no
admite.

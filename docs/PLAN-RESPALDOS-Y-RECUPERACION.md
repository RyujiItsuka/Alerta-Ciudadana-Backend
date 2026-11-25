# Plan de respaldos y recuperación ante desastres

Proyecto: **Alerta Ciudadana Pisco**
Versión: 1.0 — 2026-11-25
Alcance: base de datos (Supabase/PostgreSQL), Edge Functions, panel web,
aplicación móvil, secretos y monitoreo.

> **Paso 1 de la actividad "Implementación de alta disponibilidad y
> respaldos":** objetivos (RTO/RPO), estrategia, frecuencia, retención y plan
> de recuperación. Los pasos 2 (automatización) y 3 (prueba de restauración)
> se documentan en las secciones 8 y 9 cuando se ejecuten.

---

## 1. Situación de partida (verificada el 2026-11-25)

| Hecho | Consecuencia |
|---|---|
| Supabase en **plan gratuito** (`tier_free`) | No hay respaldos descargables ni PITR: `supabase backups list` devuelve `backups: null`, `pitr_enabled: false`. **Los respaldos tienen que ser propios.** |
| El plan gratuito **pausa el proyecto tras ~7 días sin actividad** | Riesgo de indisponibilidad total. Ocurrió el 2026-11-25 (ver sección 7). |
| Base de datos pequeña: **78,6 MB** (15,7 % del límite de 500 MB); 70 reportes, 1 894 puntos GPS | Un respaldo completo es rápido (segundos) y ocupa pocos MB comprimido: se puede respaldar con frecuencia sin coste. |
| Código de Edge Functions, migraciones, panel web y app en **GitHub** con PR y CI | El código ya tiene RPO ≈ 0: se recupera desde Git. |
| La app tiene **la URL y la anon key del proyecto escritas en el código** (Dart y Kotlin) | Si hubiera que mover la base a **otro** proyecto de Supabase, haría falta publicar un **APK nuevo**: es el punto que más alarga el RTO de un desastre total. |
| Monitoreo (Prometheus + Alertmanager → Discord) corre en el **PC de un integrante** | Si el PC o Docker están apagados no hay alertas. El 2026-11-25 la pausa no se notificó por esto. |

---

## 2. Objetivos de recuperación (RTO y RPO)

- **RPO** (Recovery Point Objective): cuántos datos, medidos en tiempo, se
  acepta perder como máximo.
- **RTO** (Recovery Time Objective): cuánto tiempo puede estar el servicio
  sin funcionar hasta que se recupera.

El sistema registra **emergencias ciudadanas**: perder un reporte o tener la
Central sin datos es grave. **Además, todo el camino crítico depende de
Supabase:** el aviso de emergencia por WhatsApp a la Central sale desde las Edge
Functions `alerts` y `whatsapp` (app y servicio nativo las llaman), así que
si el proyecto está caído o pausado **la emergencia no llega a la Central por
ningún canal automático**. Por eso los RTO de la base y de las funciones son
los más exigentes, y la mejora 1 de la sección 10 (canal de respaldo en la
app) es prioritaria.

| Componente | Criticidad | RPO | RTO | Cómo se cumple |
|---|---|---|---|---|
| **Base de datos** (reportes, ubicaciones, personas, sesiones) | Crítica | **6 h** | **1 h** | Respaldo lógico automático cada 6 h; restauración probada (sección 9). |
| **Proyecto pausado** (plan gratuito) | Crítica | 0 (no se pierden datos) | **30 min** | Reactivar desde el dashboard; alerta en Discord + actividad periódica para evitar la pausa. |
| **Edge Functions** (`security`, `alerts`, `reportes`, `whatsapp`, `reniec`) | Crítica | 0 (Git) | **30 min** | `supabase functions deploy` desde `main`. |
| **Panel web** (Cloudflare Pages) | Alta | 0 (Git) | **30 min** | Reversión a un despliegue anterior en Cloudflare o nuevo despliegue desde `main`. |
| **Secretos** (`JWT_SECRET_KEY`, Green API, `RENIEC_CACHE_KEY`) | Crítica | 0 | **30 min** | Copia en un gestor de contraseñas del equipo (nunca en Git). |
| **App móvil** (APK) | Alta | 0 (Git) | **4 h** (APK nuevo) | Compilar desde `main`; publicar APK. Solo hace falta si cambia la URL del proyecto. |
| **Monitoreo** | Media | 0 (Git) | **1 h** | `docker compose up -d` en `monitoreo/` con los secretos. |
| **Desastre total** (pérdida del proyecto de Supabase) | — | **6 h** | **6 h** | Nuevo proyecto + restaurar respaldo + secretos + funciones + APK nuevo (sección 6, escenario E). |

**Por qué RPO de 6 h y no menos:** el plan gratuito no tiene PITR. Bajar a
minutos exige el plan Pro con el complemento de PITR (de pago). Con el volumen
actual (pocos reportes al día), 6 h es un compromiso razonable; si el uso
crece, la sección 10 propone cómo bajarlo.

---

## 3. Qué se respalda

| Qué | Cómo | Dónde vive la fuente |
|---|---|---|
| Esquema `public` (tablas, funciones, triggers, RLS, permisos) | `supabase db dump --schema public` | Producción; también versionado en `supabase/migrations/` |
| Datos de `public` | `supabase db dump --data-only --schema public` | Producción |
| Roles de la base | `supabase db dump --role-only` | Producción |
| Código (funciones, panel, app, monitoreo, migraciones) | Ya está en GitHub (3 repositorios) | GitHub |
| Configuración de funciones (`verify_jwt`) | `supabase/config.toml` en Git | GitHub |
| Nombres de los secretos | `supabase secrets list` (solo nombres) en este documento | Supabase |
| Valores de los secretos | Gestor de contraseñas del equipo | Fuera de Git |

**No se respalda** la caché `reniec_cache` (se regenera sola) ni las tablas de
Supabase gestionadas por la plataforma (`auth`, `storage`, `realtime`), que el
proyecto no usa para sus datos.

---

## 4. Frecuencia y retención

| Tipo | Frecuencia | Retención | Copias |
|---|---|---|---|
| Respaldo de la base (esquema + datos + roles) | Cada **6 h** (00:00, 06:00, 12:00, 18:00 hora de Lima) | **7 días** (28 copias) | 2 ubicaciones |
| Respaldo semanal | Domingo 00:00 | **4 semanas** | 2 ubicaciones |
| Respaldo mensual | Día 1, 00:00 | **6 meses** | 2 ubicaciones |
| Código | Cada PR (GitHub) | Indefinida | GitHub + clones locales |

**Reglas de los respaldos de la base:**
1. **Cifrados** antes de guardarse (contienen DNI, teléfonos y ubicaciones de
   ciudadanos). La clave de cifrado se guarda en el gestor de contraseñas.
2. **Dos ubicaciones** (regla 3-2-1 simplificada): el equipo que ejecuta el
   respaldo y un almacenamiento externo (por ejemplo, una carpeta de nube
   privada del equipo).
3. **Verificación** en cada ejecución: el script comprueba que el archivo no
   esté vacío y registra tamaño y duración; si falla, avisa por Discord.
4. **Acceso restringido** al responsable de respaldos y al responsable técnico.

Con 78,6 MB de base, 28 + 4 + 6 = 38 copias comprimidas ocupan del orden de
cientos de MB: el coste de almacenamiento es despreciable.

---

## 5. Roles

| Rol | Responsabilidad |
|---|---|
| **Responsable de respaldos** | Mantiene el script y el cron/programador, revisa que se ejecuten y custodia la clave de cifrado. |
| **Responsable de recuperación** | Ejecuta este plan ante un incidente y registra tiempos reales (RTO/RPO obtenidos). |
| **Responsable técnico** | Decide el escenario, autoriza restaurar en producción y comunica a la Central. |
| **Central de monitoreo** | Durante la caída, difunde a la ciudadanía el canal alternativo (llamada directa a la Central / 105) mientras no exista un respaldo automático en la app. |

Los incidentes técnicos se registran en Jira Service Management (proyecto
**SUP**) y se diferencian de las emergencias ciudadanas.

---

## 6. Plan de recuperación por escenario

Antes de cualquier restauración: **registrar hora de detección** (inicio del
RTO), **abrir ticket en SUP** y **avisar a la Central** de que, mientras dure la
incidencia, las alertas de la app **no le llegan** (ni al panel ni por
WhatsApp) y debe activar el canal alternativo (llamadas directas).

### A. Proyecto pausado por inactividad (plan gratuito)
Síntoma: API y base no responden; el dashboard muestra el proyecto "Paused".
1. Dashboard de Supabase → proyecto → **Restore project** (o API de gestión).
2. Esperar estado `ACTIVE_HEALTHY` (minutos).
3. Verificar: consulta a `tipo_incidencia` responde 200; `login-staff` responde;
   el panel carga alertas.
4. Prevención: actividad periódica (el propio respaldo cada 6 h ya genera
   actividad) y alerta `SupabaseSinMetricas` en Discord.

### B. Borrado o corrupción de datos (error humano, script, prueba de carga)
1. Identificar qué tablas y desde cuándo están afectadas.
2. Restaurar el último respaldo **sano** en el entorno local
   (`supabase start` + restauración) y comprobarlo.
3. Recuperar solo lo necesario (filas o tablas) hacia producción con un script
   revisado en PR, en una transacción.
4. RPO real = hora del incidente − hora del respaldo usado.

### C. Fallo de una Edge Function tras un despliegue
1. `git revert` del cambio en una rama `hotfix/...` → PR → redeploy de la
   función, o redeploy del último `main` estable.
2. Verificar con las sondas del monitoreo (`EdgeFunctionCaida`).

### D. Fallo del panel web
1. Cloudflare Pages → **rollback** al despliegue anterior, o nuevo despliegue
   desde `main`.

### E. Pérdida total del proyecto de Supabase (desastre)
1. Crear un proyecto nuevo de Supabase (misma región si está disponible).
2. Restaurar roles, esquema y datos del último respaldo.
3. Cargar los secretos desde el gestor de contraseñas
   (`supabase secrets set ...`) y desplegar las 5 funciones con
   `supabase/config.toml`.
4. Actualizar URL y claves del proyecto en el panel web (variables de
   Cloudflare) y **compilar y distribuir un APK nuevo** (la URL está en el
   código de la app).
5. Verificar extremo a extremo con cuentas de prueba.

### F. Pérdida de secretos
1. Recuperar del gestor de contraseñas y volver a cargarlos.
2. Si un secreto se filtró: **rotarlo** (por ejemplo, `JWT_SECRET_KEY` invalida
   todas las sesiones: avisar a usuarios).

---

## 7. Incidente de referencia: pausa del proyecto (2026-11-25)

| Dato | Valor |
|---|---|
| Detección | 2026-11-25 05:31 (hora de Lima), al revisar el estado para este plan |
| Estado | `INACTIVE` (pausado por inactividad del plan gratuito) |
| Impacto | API, base de datos y Edge Functions sin respuesta (`HTTP 000`): la app no registra reportes, **el aviso por WhatsApp a la Central tampoco sale** (pasa por las Edge Functions) y el panel no carga datos |
| Por qué no hubo alerta | El monitoreo corre en un PC que tenía Docker apagado |
| Recuperación | Reactivación manual desde el dashboard (pendiente de registrar hora de fin y RTO real) |
| Lecciones | 1) El plan gratuito no garantiza disponibilidad. 2) Todo el camino de la emergencia depende de Supabase: hace falta un canal de respaldo en la app. 3) El monitoreo debe correr en un equipo siempre encendido. 4) Hace falta actividad periódica o plan de pago. |

---

## 8. Automatización (Paso 2)

*Pendiente.* Script con `supabase db dump` (roles, esquema, datos), compresión
y cifrado, rotación según la sección 4, ejecutado por cron (Linux) o el
Programador de tareas (Windows) cada 6 h, con aviso a Discord si falla.

## 9. Prueba de restauración (Paso 3)

*Pendiente.* Restaurar un respaldo en el entorno local de Supabase (Docker),
medir el tiempo real de cada etapa y compararlo con el RTO; verificar conteos
de filas frente a producción. Segunda instancia: el entorno local (o una
máquina en Oracle Cloud) con el último respaldo.

Plantilla de registro:

| Fecha | Respaldo usado (hora) | Inicio | Fin | Tiempo real | RTO objetivo | ¿Cumple? | Filas verificadas |
|---|---|---|---|---|---|---|---|
| | | | | | 1 h | | |

## 10. Mejoras propuestas

| Mejora | Efecto |
|---|---|
| **1. Canal de respaldo en la app** (prioritaria): si el envío a Supabase falla, ofrecer llamada directa a la Central y abrir WhatsApp/SMS del propio teléfono con la ubicación ya escrita | La emergencia llega aunque Supabase esté caído. |
| Plan Pro de Supabase | Sin pausas por inactividad; respaldos diarios gestionados (7 días). |
| Complemento PITR | RPO de minutos. |
| Monitoreo en un servidor siempre encendido (p. ej. Oracle Cloud) | Alertas aunque los PC del equipo estén apagados. |
| URL del proyecto configurable en la app (no fija en el código) | Bajar el RTO del escenario E: no haría falta un APK nuevo. |
| Pruebas de restauración mensuales | Confirmar que los respaldos sirven y que el RTO se cumple. |

## 11. Revisión del plan

Revisar este plan cada 3 meses, después de cada incidente y cuando cambie la
arquitectura (por ejemplo, al cambiar de plan en Supabase).

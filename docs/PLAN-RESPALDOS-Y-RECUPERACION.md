# Plan de respaldos y recuperación ante desastres

Proyecto: **Alerta Ciudadana Pisco**
Versión: 1.1 — 2026-11-25 (pasos 2 y 3 ejecutados)
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
| **Base de datos** (reportes, ubicaciones, personas, sesiones) | Crítica | **7 días** | **1 h** | Respaldo lógico automático semanal (sección 8); restauración probada en **7,7 s** (sección 9). |
| **Proyecto pausado** (plan gratuito) | Crítica | 0 (no se pierden datos) | **30 min** | Reactivar desde el dashboard; alerta en Discord + actividad periódica para evitar la pausa. |
| **Edge Functions** (`security`, `alerts`, `reportes`, `whatsapp`, `reniec`) | Crítica | 0 (Git) | **30 min** | `supabase functions deploy` desde `main`. |
| **Panel web** (Cloudflare Pages) | Alta | 0 (Git) | **30 min** | Reversión a un despliegue anterior en Cloudflare o nuevo despliegue desde `main`. |
| **Secretos** (`JWT_SECRET_KEY`, Green API, `RENIEC_CACHE_KEY`) | Crítica | 0 | **30 min** | Copia en un gestor de contraseñas del equipo (nunca en Git). |
| **App móvil** (APK) | Alta | 0 (Git) | **4 h** (APK nuevo) | Compilar desde `main`; publicar APK. Solo hace falta si cambia la URL del proyecto. |
| **Monitoreo** | Media | 0 (Git) | **1 h** | `docker compose up -d` en `monitoreo/` con los secretos. |
| **Desastre total** (pérdida del proyecto de Supabase) | — | **7 días** | **6 h** | Nuevo proyecto + restaurar respaldo + secretos + funciones + APK nuevo (sección 6, escenario E). |

**Por qué RPO de 7 días:** el plan gratuito no tiene PITR ni respaldos
gestionados, y el equipo decidió un respaldo **semanal** por el bajo volumen de
datos del proyecto académico. Para bajar el RPO basta con cambiar el cron del
flujo (p. ej. diario → RPO 24 h; el tráfico seguiría muy por debajo del límite
gratuito) o, en producción real, usar el plan Pro con PITR (RPO de minutos).

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

| Tipo | Frecuencia | Retención | Dónde |
|---|---|---|---|
| Respaldo semanal de la base (roles + esquema + datos) | Cada **domingo 00:00** hora de Lima (cron `0 5 * * 0`) | **35 días** (5 copias) | Artefactos de GitHub Actions en un repositorio **privado** |
| Respaldo mensual | El **primer domingo** de cada mes | **90 días** | Ídem |
| Respaldo manual (antes de un cambio importante) | A demanda | **35 días** | Ídem |
| Código | Cada PR (GitHub) | Indefinida | GitHub + clones locales |

**Reglas de los respaldos de la base:**
1. **Cifrados** antes de guardarse (contienen DNI, teléfonos y ubicaciones de
   ciudadanos). La clave de cifrado se guarda en el gestor de contraseñas.
2. **Ubicación:** hoy los respaldos están en **una sola ubicación** (artefactos
   del repositorio privado de GitHub). Lo recomendable (regla 3-2-1) es una
   segunda copia fuera de GitHub, p. ej. una carpeta privada en la nube del
   equipo; queda como mejora.
3. **Verificación** en cada ejecución: el script comprueba que existan las
   tablas principales y los datos de `reporte`, genera sumas SHA-256 y un
   manifiesto; si falla, avisa por Discord.
4. **Acceso restringido** al responsable de respaldos y al responsable técnico.

Cada respaldo ocupa **2,2 MB cifrado** (21,7 MB sin comprimir): con la
retención anterior se guardan menos de 20 MB.

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
4. Prevención: actividad periódica (el respaldo semanal genera actividad, pero
   queda justo en el límite de ~7 días: conviene un ping diario) y alerta
   `SupabaseSinMetricas` en Discord.

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
| Detección | 2026-11-25 00:31 hora de Lima (05:31 UTC), al revisar el estado para este plan |
| Estado | `INACTIVE` (pausado por inactividad del plan gratuito) |
| Impacto | API, base de datos y Edge Functions sin respuesta (`HTTP 000`): la app no registra reportes, **el aviso por WhatsApp a la Central tampoco sale** (pasa por las Edge Functions) y el panel no carga datos |
| Por qué no hubo alerta | El monitoreo corre en un PC que tenía Docker apagado |
| Recuperación | Reactivación manual desde el dashboard (pendiente de registrar hora de fin y RTO real) |
| Lecciones | 1) El plan gratuito no garantiza disponibilidad. 2) Todo el camino de la emergencia depende de Supabase: hace falta un canal de respaldo en la app. 3) El monitoreo debe correr en un equipo siempre encendido. 4) Hace falta actividad periódica o plan de pago. |

---

## 8. Automatización (Paso 2) — implementado

Repositorio **privado** `RyujiItsuka/Alerta-Ciudadana-Respaldos`.

| Pieza | Archivo | Qué hace |
|---|---|---|
| Cron | `.github/workflows/respaldo-semanal.yml` | `cron: "0 5 * * 0"` → cada domingo 00:00 hora de Lima; también ejecución manual. Calcula la retención, guarda el artefacto y avisa a Discord si falla. |
| Script | `scripts/respaldo-bd.sh` | `supabase db dump` de roles, esquema y datos (con reintentos), controles de contenido, SHA-256, compresión y **cifrado GPG AES-256**, manifiesto. |
| Restauración | `scripts/restaurar-bd.sh` | Descifra, verifica, restaura y mide cada etapa. |

Secretos (GitHub): token de Supabase limitado al proyecto (Project Settings y
Connection Pooling: lectura; Database: escritura, necesaria porque la CLI crea
un usuario temporal para volcar), frase de cifrado y webhook de Discord.

**Evidencia (2026-11-25):**

| Ejecución | Resultado |
|---|---|
| [Run 45742614499](https://github.com/RyujiItsuka/Alerta-Ciudadana-Respaldos/actions/runs/45742614499) | ❌ Falló (token sin `database_write`). **El aviso de fallo llegó a Discord**, validando la alerta. |
| [Run 45743269580](https://github.com/RyujiItsuka/Alerta-Ciudadana-Respaldos/actions/runs/45743269580) | ✅ Respaldo de 2,2 MB cifrado, 100 s, artefacto con caducidad automática a 35 días. Descifrado y SHA-256 verificados. |

## 9. Prueba de restauración (Paso 3) — ejecutada

**Ambiente de prueba / segunda instancia:** Supabase completo en Docker
(entorno local del repositorio), con el esquema `public` vaciado para simular
un proyecto nuevo (preparación fuera del tiempo medido).

**Procedimiento:** descargar el artefacto del run 45743269580 → descifrar y
verificar SHA-256 → restaurar roles, esquema y datos → contar filas.

| Fecha | Respaldo usado | Inicio | Fin | Tiempo real | RTO objetivo | ¿Cumple? |
|---|---|---|---|---|---|---|
| 2026-11-25 | 21:34:16 (hora de Lima) | 21:48:28 | 21:48:36 | **7,7 s** | 1 h | ✅ |

Desglose: descarga 2,5 s · descifrado y verificación ~1 s · restauración de
roles, esquema y datos ~3 s · conteo ~1 s.

**Verificación de datos** (filas restauradas = filas del respaldo = filas en
producción al momento de la prueba): `reporte` 70 · `ubicacion` 1 894 ·
`persona` 3 · `sesion_usuario` 67 748 · `codigo_otp` 4 · `tipo_incidencia` 7 ·
`estado_reporte` 4 · `operador_central` 2 · `reniec_cache` 3 ·
`cuenta_soporte` 1 · `configuracion_sistema` 1. **Pérdida de datos real: 0**
(sin cambios en producción entre el respaldo y la prueba).

**Segunda instancia funcionando con los datos restaurados:**
- API REST: devuelve los 70 reportes y los 7 tipos de incidencia.
- Edge Function `security`: con un DNI que no existe responde "DNI no
  encontrado"; con un DNI **restaurado** responde "Contraseña incorrecta"
  (encuentra a la persona en los datos restaurados).

**Observaciones:**
- El RTO medido cubre solo la base de datos. En un desastre real se suman
  crear el proyecto, cargar secretos, desplegar funciones y, si cambia la URL,
  publicar un APK nuevo (escenario E, RTO 6 h).
- `sesion_usuario` tiene 67 748 filas, casi todo el tamaño del respaldo:
  parecen sesiones de las pruebas de carga. Conviene limpiarlas.
- Las tablas vacías de `storage` y `auth` se omiten al restaurar (sin pérdida
  de datos), porque el entorno local no tiene Storage activado.

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

# Guía de ramas, control de cambios e integración continua

Proyecto: **Alerta Ciudadana — Backend (Supabase + Edge Functions)**
Repositorio: `RyujiItsuka/Alerta-Ciudadana-Backend`

Esta guía describe cómo se aplica el procedimiento de control de cambios de la
Semana 11 en este repositorio. Es de cumplimiento obligatorio: el pipeline y la
protección de rama impiden que un cambio llegue a producción sin pasar por aquí.

---

## 1. Modelo de ramas

| Rama | Para qué sirve | ¿Admite push directo? |
|---|---|---|
| `main` | Versión estable / entregable. Solo recibe merges desde `develop`. | No (bloqueado) |
| `develop` | Integración continua del trabajo del sprint. | No (bloqueado) |
| `feature/<id>-<descripcion>` | Un cambio concreto (una historia o tarea). | Sí, es de trabajo |
| `hotfix/<id>-<descripcion>` | Corrección urgente que nace de `main`. | Sí, es de trabajo |

Regla de oro: **un cambio = una solicitud = una rama = un pull request**.
Ningún cambio se escribe directamente sobre `main` ni sobre `develop`.

---

## 2. Flujo obligatorio

1. **Solicitud.** Se registra el cambio (plantilla de solicitud del plan) y se
   abre/usa el issue del sprint con su etiqueta de prioridad.
2. **Rama.** Se crea desde `develop`:
   `git checkout develop && git pull && git checkout -b feature/S6-xx-descripcion`
3. **Desarrollo.** Commits pequeños con la convención de la sección 5.
4. **Push de la rama.** `git push -u origin feature/S6-xx-descripcion`
5. **Pull request a `develop`.** El PR describe qué cambia, por qué, cómo se
   probó y cómo se revierte. El CI corre automáticamente.
6. **Revisión.** El PR se aprueba y se fusiona solo con el CI en verde.
7. **Integración a `main`.** Cuando `develop` está estable se abre un PR
   `develop` → `main` (requiere revisión) y se fusiona.
8. **Cierre.** Se cierra el issue y se registra el cambio en el control de
   versiones del plan.

### Reversión

- Antes del merge: se cierra el PR (no deja rastro en `main`).
- Después del merge: `git revert <commit>` en una rama `hotfix/...` y PR a
  `main` y `develop`. Nunca se reescribe el historial (`--force`) en ramas
  protegidas.
- Base de datos / Edge Functions: se conserva el script SQL y la versión
  anterior de la función; el rollback se ejecuta en la ventana de cambio.

---

## 3. Protección de rama configurada

| Regla | `main` | `develop` |
|---|---|---|
| Cambios solo por pull request | Sí | Sí |
| Revisión obligatoria | 1 aprobación | No |
| Estado de CI obligatorio antes del merge | Sí (`Compilar TypeScript`) | Sí (`Compilar TypeScript`) |
| Push forzado | Bloqueado | Bloqueado |
| Borrado de la rama | Bloqueado | Bloqueado |
| Aplicable también a administradores | No (ver nota) | Sí |

**Nota sobre `main`:** el repositorio tiene un único mantenedor con permisos de
administración. Si la regla se aplicara también al administrador, ningún PR
podría fusionarse (GitHub no permite aprobar el propio PR). Por eso en `main` la
exigencia de aprobación rige para todos los colaboradores, pero la cuenta
administradora conserva la capacidad de fusionar. En cuanto se incorpore un
segundo revisor con permisos, se activa la opción *"Do not allow bypassing the
above settings"* y la regla pasa a ser total.

---

## 4. Integración continua

Archivo: `.github/workflows/ci.yml`

| Elemento | Valor |
|---|---|
| Workflow | `CI` |
| Job | `Compilar TypeScript` |
| Se ejecuta en | `pull_request` y `push` a `main` y `develop` |
| Qué valida | `npm ci` (dependencias reproducibles) + `npm run build` (`tsc`: type-check y compilación) + existencia de `dist/server.js` |
| Efecto | Si falla, el PR queda bloqueado y no se puede fusionar |

**Edge Functions (`supabase/functions`).** Se despliegan con
`supabase functions deploy`, que publica el código tal cual. No se incluyen en
el job de compilación porque sus dependencias se importan por URL (`esm.sh`,
`deno.land`) y el chequeo de tipos de Deno reporta hoy dos incompatibilidades
preexistentes en esas librerías (`bcryptjs` sin export por defecto y tipado de
`Uint8Array` en WebCrypto) que no afectan al runtime. Su verificación es el
despliegue más la prueba funcional de los endpoints (`login`, `verify-token`,
`update-pin`, `update-reporte-estado`).

---

## 5. Convención de commits

```
tipo(alcance): descripción breve en imperativo

Cuerpo opcional: qué cambia y por qué.
Refs #<issue>
```

Tipos: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
Ejemplo real de este repositorio:

```
fix(seguridad): hacer efectiva la revocacion de sesiones del ciudadano
```

---

## 6. Roles del proceso (CAB)

| Rol | Responsabilidad |
|---|---|
| Responsable del cambio (desarrollador) | Abre la solicitud, la rama y el PR; documenta pruebas y reversión |
| Responsable técnico del componente | Revisa el PR y aprueba el cambio |
| Responsable de operaciones / Central | Autoriza la ventana, verifica el servicio después del despliegue |

Para un cambio **urgente** (emergencia en producción) se permite la rama
`hotfix/...`, merge directo a `main` con el CI en verde y aprobación
retroactiva del CAB en la siguiente reunión.

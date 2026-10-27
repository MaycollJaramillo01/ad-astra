# Registro de decisiones (ADR) — Ad Astra

Formato: cada decisión tiene estado (**Propuesta**, **Aceptada**, **Sustituida por ADR-xxx** o **Rechazada**), contexto, decisión, alternativas, consecuencias y condición de revisión. Las decisiones no se borran: se sustituyen.

El responsable aprobó el plan maestro el **2026-10-23**: las decisiones pasan a **Aceptada**, salvo las marcadas con *(validar en F0)*, que dependen del spike.

| ADR | Título | Estado |
|---|---|---|
| 001 | Monolito modular en TypeScript | Aceptada (revisada el 2026-10-23 por ADR-022) |
| 002 | PostgreSQL como único almacén | Aceptada |
| 003 | pg-boss para colas y programación | **Sustituida por ADR-022** |
| 004 | Cliente propio y delgado para la API de Meta | Aceptada |
| 005 | Versión de la API de Meta fijada en v26.0, con runbook de actualización | Aceptada |
| 006 | Acceso a Meta con usuario del sistema de la agencia (MVP); FLfB en SaaS | Propuesta *(validar en F0)* |
| 007 | Aislamiento multi-tenant con `tenant_id` + RLS | Aceptada |
| 008 | Cifrado de credenciales con AES-256-GCM y clave maestra versionada | Aceptada |
| 009 | Modelo de hechos de insights | Propuesta *(validar en F0)* |
| 010 | Separación entre cálculo determinista e interpretación generativa | Aceptada |
| 011 | Interfaz LLM delgada; proveedor inicial Anthropic | Aceptada |
| 012 | Recuperación documental con FTS de Postgres primero | Aceptada |
| 013 | Escrituras en Meta solo mediante flujo de aprobación con guardrails | Aceptada |
| 014 | Reutilización open source: portar ideas, no depender de los repositorios candidatos | Aceptada |
| 015 | Servidor MCP y CLI oficiales de Meta fuera del núcleo | Aceptada |
| 016 | Frontend SPA con React + Vite | Aceptada |
| 017 | Contrato REST `/v1` con OpenAPI 3.1 generado desde zod | Aceptada |
| 018 | Estadística simple y explicable en TypeScript | Aceptada (revisada el 2026-10-26: ETS en TS, ADR-025) |
| 019 | Autenticación del personal con Better Auth y Google Workspace | Aceptada (revisada el 2026-10-23, PQ-05) |
| 020 | No agregar monedas distintas sin conversión explícita | Aceptada |
| 021 | Estados de dato explícitos | Aceptada |
| 022 | Despliegue en Vercel Pro + Neon; trabajo en segundo plano con un tick programado | Aceptada (PQ-04) |
| 023 | Motor de auditoría: función pura, cinco subíndices y una sola configuración | Aceptada |
| 024 | Asistente de IA: respuesta estructurada verificable, herramientas de lectura y presupuestos por configuración | Aceptada |
| 025 | Pronóstico y simulación: modelos simples validados, calculados al pedirlos | Aceptada |
| 026 | Action Center: aprobación explícita y reconciliación de envíos ambiguos | Implementada; pendiente de sandbox autorizado |

---

## ADR-001 — Monolito modular en TypeScript

- **Contexto:** equipo pequeño (SUP-04), dominio amplio y el encargo pide evitar arquitecturas excesivamente complejas. Hay trabajo síncrono (UI y API) y asíncrono (sincronización y cálculo).
- **Decisión:** un repositorio con el código de servidor organizado en módulos con fronteras explícitas (ARCHITECTURE §4), verificadas por un test de arquitectura. El trabajo asíncrono lo ejecuta un *worker* lógico del mismo código; desde ADR-022 es una función programada, no un proceso permanente. Cada dependencia nueva se justifica en el PR.
- **Revisión 2026-10-23 (F0):** el repositorio arranca como **un solo paquete** (`src/`, `scripts/`). La web y los tipos compartidos se añaden en F1, con su primer uso, y entonces se decide entre carpetas del mismo paquete o workspaces de pnpm, según lo que pida el despliegue en Vercel (ADR-022). Así se evita crear paquetes vacíos.
- **Alternativas:** microservicios por dominio (más operación, despliegues y contratos internos sin beneficio con este volumen); servicios separados en Python para los datos (dos lenguajes y tipos duplicados).
- **Consecuencias:** despliegue y depuración simples; hay que vigilar el acoplamiento entre módulos (test de dependencias). Un módulo puede extraerse más adelante sin reescribirlo.
- **Revisar si:** un módulo necesita escalar o desplegarse con un ritmo muy distinto, o el equipo supera unas 8 personas.

## ADR-002 — PostgreSQL como único almacén

- **Contexto:** se necesitan datos transaccionales, hechos analíticos (< 10 GB/año, ver DATABASE_SCHEMA §8), cola de trabajos, búsqueda de texto y aislamiento por tenant.
- **Decisión:** PostgreSQL 17+ gestionado con PITR para todo: tablas, particiones de hechos, cola (ADR-003), FTS y, solo si F4 lo justifica, pgvector.
- **Alternativas:** Redis para las colas (otra pieza que operar); ClickHouse o TimescaleDB (innecesarios con este volumen); una base vectorial dedicada (innecesaria con un corpus pequeño).
- **Consecuencias:** una sola tecnología que respaldar y proteger. Se pierde rendimiento analítico extremo, que no se necesita.
- **Revisar si:** el p95 de los dashboards supera el objetivo con índices y agregados, o los hechos superan unos 100 M de filas.

## ADR-003 — pg-boss para colas y programación

> **Sustituida por ADR-022 (2026-10-23).** pg-boss necesita un proceso permanente para su cron y su mantenimiento, y Vercel ejecuta funciones bajo demanda.

- **Contexto:** la sincronización periódica, los reintentos, el retraso por cuotas y el post-proceso requieren una cola con cron.
- **Decisión:** pg-boss sobre la misma BD: cron, reintentos con backoff, `startAfter` para respetar `blocked_until`, trabajos singleton por cuenta y concurrencia configurable.
- **Alternativas:** BullMQ (requiere Redis); Temporal (potente, pero pesado para este caso); cron del sistema operativo (sin reintentos ni visibilidad).
- **Consecuencias:** sin infraestructura nueva; la cola consume conexiones de la BD (pool dimensionado). Requiere conexiones en modo sesión o transacción compatibles si se usa un pooler.
- **Revisar si:** la latencia de la cola o la carga de la BD por sondeo se convierten en un cuello de botella.

## ADR-004 — Cliente propio y delgado para la API de Meta

- **Contexto:** el SDK oficial de Node (`facebook-nodejs-business-sdk`) tiene la versión 24.0.1 como `latest` en npm (dirigida a v24, que expira en noviembre de 2026), aunque GitHub tiene etiquetas v26.0.2; es JavaScript con tipos Flow (`@types` en 24.0.0) y licencia propia de Meta. Se necesita control fino sobre reintentos, cabeceras de uso, redacción y versión.
- **Decisión:** cliente propio sobre el `fetch` nativo de Node: autenticación con `appsecret_proof`, paginación por cursor, lotes, informes asíncronos, taxonomía de errores, parseo de cabeceras de uso y esquemas zod **solo** de los campos que usamos. Un test de contrato compara los campos pedidos con un snapshot de las specs oficiales de `facebook-business-sdk-codegen/api_specs` para la versión fijada (idea tomada de `test_requested_fields.py` de arcbaslow).
- **Alternativas:** SDK oficial (desfasado en npm; estado global; menos control de la redacción); instalar el SDK desde una etiqueta de GitHub (frágil); generar un cliente completo desde las specs (1000 objetos: excesivo).
- **Consecuencias:** unas pocas centenas de líneas que mantener; la actualización de versión exige revisar campos con el test de contrato.
- **Revisar si:** el número de objetos usados crece mucho (más de unos 15), lo que haría rentable generar los tipos a partir de las specs.

## ADR-005 — Versión de la API de Meta fijada en v26.0, con runbook de actualización

- **Contexto:** las versiones de Marketing API duran unos 12 meses (v24 hasta 2026-11-10; v25 hasta 2027-02-23; v26 desde 2026-07-29) y hay cambios fuera de ciclo quincenales.
- **Decisión:** constante única `META_API_VERSION = "v26.0"`, registrada en cada `sync_run`. Runbook por versión nueva: leer el changelog → actualizar el snapshot de specs → tests de contrato → sync completo en staging → despliegue. Revisión trimestral de los cambios fuera de ciclo.
- **Alternativas:** llamadas sin versión (cambian sin aviso); varias versiones a la vez (complejidad sin beneficio).
- **Consecuencias:** actualizaciones planificadas al menos una vez al año, antes de cada expiración.
- **Revisar si:** Meta publica v27 o anuncia la fecha de fin de v26.

## ADR-006 — Acceso a Meta con usuario del sistema de la agencia (MVP); FLfB en SaaS

- **Contexto:** la agencia gestiona cuentas de clientes compartidas con su portafolio. Meta recomienda los tokens de usuario del sistema para servidor a servidor (no expiran). Los tokens de usuario expiran a los ~60 días y dependen de una persona.
- **Decisión:** MVP con una conexión por portafolio de la agencia mediante un token de usuario del sistema, con tareas mínimas por cuenta (ANALYZE; ADVERTISE o MANAGE solo en F5) y permisos mínimos (`ads_read`; `business_management` solo si el inventario lo exige). El token se introduce una vez como secreto de solo escritura. En F7, Facebook Login for Business (*configuration ID*) para el autoservicio de los clientes.
- **Alternativas:** OAuth de usuario desde el principio (tokens que caducan y atados a personas); el servidor MCP oficial como capa de acceso (ADR-015).
- **Consecuencias:** onboarding manual de cada cliente (compartir la cuenta como socio) y dependencia de App Review para cuentas de terceros (RSK-01). Las acciones de Meta no quedan vinculadas a una persona: Ad Astra registra al aprobador humano.
- **Revisar si:** V-01 muestra que el acceso de socio no funciona con este modelo, o al iniciar F7.

## ADR-007 — Aislamiento multi-tenant con `tenant_id` + RLS

- **Contexto:** el requisito exige multi-tenancy **verificable** y evolución a SaaS.
- **Decisión:** base de datos compartida, `tenant_id` en todas las tablas de datos, RLS forzado con `current_setting('app.tenant_id')` fijado por transacción (fallo cerrado), rol de la aplicación sin `BYPASSRLS` y tests de aislamiento automáticos (DATABASE_SCHEMA §4).
- **Alternativas:** esquema por tenant (migraciones multiplicadas); BD por tenant (costo y operación; se puede ofrecer más adelante a clientes enterprise); filtrado solo en la aplicación (un olvido = fuga).
- **Consecuencias:** cada consulta debe ejecutarse dentro de una transacción con contexto; los jobs fijan el tenant del trabajo.
- **Revisar si:** un cliente enterprise exige aislamiento físico.
- **Revisión 2026-10-23 (implementación):** además de RLS, (1) **FK compuestas** `(tenant_id, id)` en todas las referencias internas de un tenant, porque Postgres valida las FK sin aplicar RLS; (2) políticas específicas para `tenants`, `memberships`, `invitations` y `audit_log` (DATABASE_SCHEMA §0); (3) el contexto se fija con `set_config(..., true)` dentro de cada transacción (`withContext`), para que no se filtre entre peticiones del pool; (4) la cabecera `x-tenant-id` solo elige entre las membresías verificadas del usuario. Probado en `test/rls.test.ts` y `test/api-security.test.ts`, con pruebas de mutación.

## ADR-008 — Cifrado de credenciales con AES-256-GCM y clave maestra versionada

- **Contexto:** los tokens de usuario del sistema no expiran: una fuga es grave. No pueden estar en texto claro en la BD ni en los backups.
- **Decisión:** AES-256-GCM con `node:crypto`, nonce aleatorio de 12 bytes, AAD = `tenant_id || connection_id`, `key_version` por fila y clave maestra en el gestor de secretos. Rotación con recifrado. KMS con claves de datos por tenant en F7. Además: `appsecret_proof` y Require App Secret, para que un token sin el app secret no sirva.
- **Alternativas:** `pgcrypto` en la BD (la clave tendría que llegar a la BD y aparecer en las consultas); KMS desde el MVP (dependencia de proveedor antes de elegir la nube).
- **Consecuencias:** si se pierde la clave maestra, los tokens son irrecuperables (se reconecta); la clave se respalda aparte.
- **Revisar si:** se elige proveedor de nube (adoptar su KMS antes de F7 si es sencillo).

## ADR-009 — Modelo de hechos de insights

- **Contexto:** las métricas de Meta cambian durante 28 días, el alcance no es aditivo, los días son locales de cada cuenta, hay que recalcular KPIs sin volver a pedir datos y el volumen es moderado.
- **Decisión:** tabla `insights_daily` con grano (nivel, entidad, día) para los cuatro niveles consultados por separado; columnas canónicas de KPI extraídas de un único `action_type` por perfil, con `extraction_version`, más `actions` en JSONB crudo para recalcular; `attribution_setting` como columna (no forma parte de la clave); reexpresión nocturna de 28 días e `is_final`; ratios calculados en la consulta como cocientes de sumas; particionado mensual desde el inicio; alcance de periodos estándar en una tabla aparte.
- **Alternativas:** solo nivel de anuncio y agregación hacia arriba (el alcance sería incorrecto); tabla larga normalizada de acciones (unas 10 veces más filas sin una necesidad clara); JSONB sin columnas canónicas (consultas lentas y propensas a contar dos veces).
- **Consecuencias:** unas 4 veces más llamadas que pidiendo solo el nivel de anuncio, a cambio de exactitud. El particionado añade un job de mantenimiento.
- **Revisar si:** V-04 cambia la forma de `results`, o el costo de las llamadas por nivel resulta prohibitivo.

## ADR-010 — Separación entre cálculo determinista e interpretación generativa

- **Contexto:** el encargo prohíbe inventar métricas y exige justificar con cifras verificables.
- **Decisión:** métricas, reglas, salud, descomposiciones y pronósticos son funciones puras y versionadas. La IA solo accede mediante herramientas de solo lectura que devuelven resultados ya calculados con `evidence_id`; un verificador comprueba que cada cifra de la respuesta procede de esos resultados; la IA no tiene herramientas de escritura ni de red y el módulo `ai` no puede importar `meta` ni `optimization` (test de arquitectura).
- **Alternativas:** dejar que el LLM consulte SQL libremente (riesgo de cifras erróneas y de fugas); que el LLM calcule (no determinista).
- **Consecuencias:** cada pregunta nueva puede requerir una herramienta nueva; a cambio, las respuestas son auditables.
- **Revisar si:** los evals muestran que el catálogo de herramientas no cubre preguntas frecuentes (se amplía el catálogo, no la libertad del modelo).

## ADR-011 — Interfaz LLM delgada; proveedor inicial Anthropic

- **Contexto:** el encargo pide uno o más proveedores tras una interfaz desacoplada. Se necesitan herramientas, salidas estructuradas, caché de prompts y procesamiento por lotes.
- **Decisión:** interfaz `LlmProvider` (API_INTEGRATIONS §2.1) con una implementación inicial sobre `@anthropic-ai/sdk` y el modelo por defecto `claude-opus-5-5`, con pensamiento adaptativo y esfuerzo ajustado por ruta. Prompts y esquemas de herramientas independientes del proveedor. Cualquier cambio de modelo por ruta se decide con evals y lo aprueba el responsable. Un segundo proveedor se añade solo cuando haya un motivo (costo medido, residencia, contrato).
- **Alternativas:** LangChain u otros orquestadores (capas extra y depuración más difícil); varios proveedores desde el día uno (doble trabajo de evals sin necesidad demostrada).
- **Consecuencias:** las particularidades del proveedor (sin parámetros de muestreo, sin uso forzado de herramientas en Opus 5.5, citas incompatibles con salidas estructuradas) quedan dentro del adaptador.
- **Revisar si:** cambian los precios, las condiciones de retención o la revisión legal (SUP-08).

## ADR-012 — Recuperación documental con FTS de Postgres primero

- **Contexto:** el contexto documental aprobado (playbooks, briefs, benchmarks) será pequeño al principio.
- **Decisión:** búsqueda de texto completo de Postgres (`tsvector`, configuración en español) sobre fragmentos de documentos `approved`. Eval de recuperación con preguntas reales; si no alcanza el umbral (p. ej. recall@5 < 0,8), se añade pgvector y un proveedor de embeddings.
- **Alternativas:** base vectorial dedicada; embeddings desde el inicio.
- **Consecuencias:** cero dependencias nuevas en F4; posible menor recall semántico, que se mide antes de decidir.
- **Revisar si:** el eval de recuperación queda por debajo del umbral o el corpus supera unos 5000 fragmentos.

## ADR-013 — Escrituras en Meta solo mediante flujo de aprobación con guardrails

- **Contexto:** los requisitos 7.2 y 7.3; impacto económico directo (RSK-09); límites de Meta en las escrituras.
- **Decisión:** toda escritura es una `action_proposal` que pasa por la máquina de estados de ARCHITECTURE §6.9 con previsualización en vivo, guardrails, aprobación por rol (doble por encima del umbral), ejecución idempotente en el worker, verificación por relectura, reversión cuando el tipo de acción lo permite y kill switch. Ningún otro camino del código puede llamar a los métodos de escritura de `meta` (test de arquitectura).
- **Alternativas:** ejecución automática por umbrales (prohibida por el requisito); escrituras desde el copiloto con confirmación conversacional (sin trazabilidad ni guardrails).
- **Consecuencias:** más fricción en cada cambio, por diseño. Las reglas automáticas de Meta (*automated rules*) quedan fuera; si la agencia las usa, se muestran pero no se gestionan.
- **Revisar si:** la agencia pide automatizaciones con preaprobación (por ejemplo, "pausar si el gasto sin resultados supera X") en F5+, que requerirían un ADR nuevo.

## ADR-014 — Reutilización open source: portar ideas, no depender de los repositorios candidatos

- **Contexto:** el encargo pide verificar la existencia, licencia, mantenimiento, calidad, dependencias, seguridad y compatibilidad de 6 repositorios y justificar si se reutilizan, adaptan, bifurcan o se construye. Evaluación hecha el 2026-10-23 leyendo el código y los metadatos de GitHub.

**Evaluación:**

| Criterio | curtiskline/meta-ads-manager | soyalvaropareja/dashboard-meta-ads | fortytwode/meta-ads-account-audit |
|---|---|---|---|
| Existe | Sí | Sí | Sí |
| Licencia | MIT | MIT | MIT |
| Actividad | 5 commits, 1 autor; creado el 2026-02-14, último push el 2026-02-15 | 4 commits, 1 autor; 2026-04-05/06; 9★, 4 forks | 2 commits; 2026-06-09; 0★ |
| Qué contiene realmente | Esqueleto de Next.js 16 + Supabase. `src/app/(app)/page.tsx` es la plantilla de create-next-app; **no hay cliente de Meta**, aunque el README describe plantillas, lanzamiento y dashboard | React 18 + Vite + proxy Express a Graph API; tablas, series y auditoría de frontend | Auditoría estructural determinista en Python que genera Markdown |
| Calidad y tests | 1 test trivial (`cn()`) y e2e de login | Sin tests | Solo `smoke_test.py` |
| Dependencias | Next 16.1.6, Supabase, Radix | Express 4, Recharts 3, Radix | `requests`, `python-dotenv` |
| Seguridad | N/A | Token único en `.env` (solo backend, correcto), `appsecret_proof` presente; CORS abierto; un error de paginación corta los resultados en silencio | Token en `.env`; el bucle de reintentos ante 429/5xx no tiene límite efectivo (la condición `backoff > 16` nunca se cumple) |
| Compatibilidad | N/A | API **v21.0** fija (expirada en Marketing API) | API **v21.0** fija |
| Calidad del dominio | N/A | Promedia ratios (CPC medio de filas), `parseFloat(x) \|\| 0` confunde ausencia con cero, umbrales absolutos en MXN | Detección del evento primario desde `optimization_goal` + `promoted_object`; tabla de monedas sin decimales; umbral adaptativo; z-score con línea base mínima; CPA = 0 cuando no hay conversiones (defecto); alcance limitado a apps de suscripción |
| **Veredicto** | **Descartar** | **No reutilizar código**; ideas de UX: panel lateral de detalle, comparación de periodos, modo de datos sensibles | **Portar metodología a TS** (MIT, con atribución): evento primario, monedas, umbral adaptativo (R-CHG-014), cambios de régimen, descomposición del CPA, inventario por debajo del ruido |

| Criterio | arcbaslow/meta-ads-agents | robyroro/meta-ads-portfolio-intelligence | mikusnuz/meta-ads-mcp |
|---|---|---|---|
| Existe | Sí | Sí | Sí |
| Licencia | MIT | MIT | MIT |
| Actividad | 41 commits (37 del autor + 4 de dependabot); releases v1.0.1–v1.1.0; último push el 2026-10-01; 1★ | 1 commit (2026-07-16); 0★ | 23 commits, 1 autor; releases hasta v1.6.1; último push el 2026-10-19; 91★, 23 forks |
| Qué contiene realmente | Toolkit de solo lectura en Python + plugin y skills de Claude Code: rendimiento, fatiga, audiencias, píxel y CAPI, diagnóstico de entrega, cambios, reportes | Script de Python + plantilla HTML de cartera (KPIs agregados, HHI, simulador de reasignación) | Servidor MCP (TypeScript) con 134 herramientas de lectura y escritura sobre Marketing API v26 |
| Calidad y tests | 124+ tests pytest, CI, ruff, dependabot, SECURITY.md, roadmap con fuentes | 1 archivo de tests + CI | 4 archivos de tests (node:test) sobre contratos |
| Dependencias | `facebook-business` 26.x, `fpdf2` | `facebook-business` 25.x | `@modelcontextprotocol/sdk`, `zod` |
| Seguridad | Redacción de tokens en errores de red, `crash_log=False`, token en archivo local o variable de entorno, caché en el directorio temporal sin permisos restrictivos | SDK con el informe de errores activo por defecto (envía trazas a Meta); excepciones genéricas tragadas | Token de entorno en la query string, sin `appsecret_proof`, **sin reintentos ni backoff** (solo parsea cabeceras), **sin anotaciones** `readOnlyHint` ni `destructiveHint` en herramientas que escriben y borran, una sola cuenta |
| Compatibilidad | v26.0 | SDK v25 | v26.0 |
| Calidad del dominio | Fatiga con umbral de impresiones por mitad, diagnóstico de entrega (cap frente al CPA real, aprendizaje), correlación cambios ↔ métricas, taxonomía de errores (4, 17, 613, 80000…) | Suma compras + leads + registros en una sola "conversión" (mezcla objetivos); simulador con CPA constante (supone retornos lineales) | Contratos de parámetros y enums de escritura (presupuestos, estados, controles de conjuntos) |
| **Veredicto** | **Mejor referencia: portar lógica a TS** (MIT, con atribución) y usar su ROADMAP como lista de hechos a verificar. No es un servicio (CLI de una cuenta, sin persistencia): no sirve como dependencia | **Ideas para la vista de cartera** (HHI, chequeos de sanidad del tracking); no reutilizar código | **Referencia de contratos de escritura para F5** y herramienta opcional de exploración en desarrollo con cuentas sandbox. **No usar en producción** ni como capa de acciones de la IA |

**Otros proyectos encontrados durante la investigación:**

| Proyecto | Licencia | Uso |
|---|---|---|
| `facebook/facebook-business-sdk-codegen` (`api_specs`) | Licencia de Meta | **Usar:** snapshot de specs para los tests de contrato |
| `facebook/facebook-nodejs-business-sdk` | Licencia de Meta | No usar (ADR-004) |
| `airbytehq/airbyte` source-facebook-marketing | **ELv2** (no OSI) | Solo estudiar el diseño del gestor de jobs asíncronos (división ante fallos). **No copiar código**: la ELv2 restringe ofrecerlo como servicio gestionado |
| `fivetran/dbt_facebook_ads` | Apache-2.0 | Referencia de modelado de hechos |
| `gomarble-ai/facebook-ads-mcp-server` | MIT | Otro MCP (Python, 366★); no aporta frente a los anteriores |
| Conectores SaaS (p. ej. Supermetrics) | Comercial | **Plan B de solo lectura** si App Review se bloquea (sin escrituras, costo por cuenta, un tercero más en el flujo de datos) |

- **Decisión:** construir el núcleo propio (ADR-001 a ADR-013) y **portar** a TypeScript, con atribución MIT en `NOTICE`, las piezas metodológicas indicadas de fortytwode y arcbaslow. Ningún repositorio candidato es una dependencia ni se bifurca.
- **Alternativas:** bifurcar dashboard-meta-ads como base (habría que reescribir casi todo: v21, single-token, sin BD, errores de dominio); usar meta-ads-mcp como capa de escritura (sin seguridad suficiente ni aprobación).
- **Consecuencias:** más código propio en la ingesta, a cambio de control sobre seguridad y exactitud. Cada pieza portada incluye tests propios y referencia a su origen.
- **Revisar si:** aparece un proyecto mantenido, multi-cuenta y con licencia compatible que cubra la ingesta con calidad equivalente.

## ADR-015 — Servidor MCP y CLI oficiales de Meta fuera del núcleo

- **Contexto:** Meta ofrece desde el 2026-04-29 (beta abierta) un servidor MCP y una CLI que leen y escriben campañas, con reglas de gobierno a nivel de portafolio desde el 2026-07-16.
- **Decisión:** no depender de ellos en el núcleo: sus salidas son conversacionales o de consola, sus límites no están documentados y sus escrituras no pasarían por el flujo de aprobación ni por el registro de auditoría de Ad Astra. Se recomiendan al equipo para exploración puntual fuera de la plataforma.
- **Alternativas:** usar el MCP oficial como herramienta del copiloto (se pierde la trazabilidad de las cifras y el control del alcance); usar la CLI en los jobs (proceso externo, menos control).
- **Consecuencias:** se mantiene el cliente propio. Riesgo estratégico de solapamiento (RSK-11) mitigado con la diferenciación en multi-cuenta y gobierno.
- **Revisar si:** sale de beta con límites documentados y escrituras con aprobación verificable (F6/F7), en cuyo caso podría ser un adaptador opcional de solo lectura para la IA.

## ADR-016 — Frontend SPA con React + Vite

- **Contexto:** herramienta interna autenticada, sin SEO; la lógica vive en la API.
- **Decisión:** SPA con React + Vite, React Router, TanStack Query (caché, reintentos, invalidación), Recharts, Tailwind y componentes copiados de shadcn/ui. La API sirve los estáticos.
- **Alternativas:** Next.js (SSR innecesario y un segundo servidor con lógica); Remix.
- **Consecuencias:** un solo backend; carga inicial algo mayor, irrelevante en uso interno.
- **Revisar si:** F7 requiere páginas públicas (marketing o portal), que pueden ir en un proyecto aparte.

## ADR-017 — Contrato REST `/v1` con OpenAPI 3.1 generado desde zod

- **Contexto:** el encargo exige contratos de API; el SaaS futuro necesitará clientes externos.
- **Decisión:** esquemas zod como única fuente de verdad → validación en Fastify → OpenAPI 3.1 publicado en `/v1/openapi.json` → tipos del cliente web generados. Errores RFC 9457, paginación por cursor e `Idempotency-Key`. La CI detecta cambios incompatibles del contrato.
- **Alternativas:** tRPC (acoplado a TypeScript y sin contrato estándar); escribir el OpenAPI a mano (se desincroniza).
- **Consecuencias:** disciplina de esquemas en cada endpoint.
- **Revisar si:** aparece la necesidad de streaming bidireccional, que se resolvería con SSE en rutas concretas sin cambiar el contrato.
- **Revisión 2026-10-23 (implementación):** los esquemas viven en `src/contracts.ts` y los valores de dominio en `src/domain.ts` (sin dependencias). Como web y servidor comparten paquete, la SPA importa los **tipos** del contrato directamente (`import type`) en lugar de generar un cliente desde el OpenAPI; el OpenAPI se sigue publicando en `/v1/openapi.json` para consumidores externos. El serializador de zod descarta cualquier campo que no esté en el esquema de respuesta, lo que impide filtrar por accidente columnas como el cifrado del token. El test de cambios incompatibles del contrato queda pendiente (TD-09).

## ADR-018 — Estadística simple y explicable en TypeScript

- **Contexto:** se necesitan intervalos, pruebas de Poisson, contracción bayesiana, detección robusta y, en F6, pronósticos y Monte Carlo. Un servicio en Python añadiría un lenguaje y un despliegue.
- **Decisión:** implementar en TS, con tests de recuperación de parámetros, los métodos de forma cerrada o casi: Gamma-Poisson, Beta-Binomial, Wilson, mediana/MAD, CUSUM, regresión log-log por mínimos cuadrados, muestreo Gamma (Marsaglia-Tsang) y Monte Carlo. En F6 se hace un spike de ETS en TS frente a `statsmodels`: si mantener ETS en TS no es razonable, se añade un worker de Python aislado con un contrato de entrada y salida.
- **Alternativas:** servicio de Python desde el inicio; librerías de estadística en JS (se valoran caso a caso; ninguna cubre todo).
- **Consecuencias:** métodos transparentes y fáciles de explicar en la UI; pocos modelos sofisticados al principio, por diseño.
- **Revisar si:** F6 requiere modelos de espacio de estados, jerárquicos o de supervivencia avanzados.
- **Revisión 2026-10-26 (F6):** spike de ETS resuelto en TypeScript: ETS(A,Ad,A) con rejilla de 140 combinaciones, ≈ 20 ms por serie con su backtest; no hace falta un worker de Python ([FORECASTING §3](FORECASTING.md#3-técnicas-evaluadas)). Ver ADR-025.

## ADR-019 — Autenticación del personal con Better Auth y Google Workspace

- **Contexto:** se necesitan sesiones seguras, multi-organización (tenants) y una posible evolución a SSO. PQ-05 (2026-10-23): el personal entra con **Google Workspace**.
- **Decisión:** Better Auth (MIT; ~30 000★; versión estable 1.7.12 del 2026-10-20; proceso público de avisos de seguridad) con **Google como único proveedor**, sin contraseñas locales. Cliente OAuth de Google Cloud con tipo de usuario **"Internal"** (solo cuentas del Workspace de la agencia) y, además, comprobación en el servidor del claim `hd` y de `email_verified`. La verificación en dos pasos la impone la política del Workspace (debe estar obligatoria para los usuarios con rol owner o admin). Sesiones en Postgres; las membresías y roles de Ad Astra se gestionan en `memberships`. La integración con Fastify y RLS se valida al empezar F1.
- **Alternativas:** autenticación propia con OIDC (más código de sesiones sin necesidad); proveedor gestionado (Auth0, WorkOS, Clerk: otro tercero con datos del personal); Keycloak (operación pesada).
- **Consecuencias:** sin contraseñas que custodiar. El alta de usuarios es por invitación en Ad Astra: tener una cuenta del Workspace no da acceso por sí sola. Hay que mantener la librería actualizada por sus avisos de seguridad.
- **Revisar si:** entran usuarios externos al Workspace (portal de clientes, F7), que necesitarían otro método.

## ADR-022 — Despliegue en Vercel Pro + Neon; trabajo en segundo plano con un tick programado

- **Contexto:** PQ-04 (2026-10-23): staging y producción en **Vercel + Neon**. Vercel ejecuta funciones bajo demanda: no hay procesos permanentes. Límites verificados el 2026-10-23: las crons de Hobby solo pueden ejecutarse una vez al día (y con ±59 min de precisión); Pro y Enterprise permiten una por minuto; las funciones duran como máximo 300 s en Hobby y 800 s en Pro (1800 s en beta), con 4,5 MB de cuerpo. Neon: PITR de 6 h en Free, hasta 7 días en Launch y hasta 30 en Scale; escala a cero tras 5 min.
- **Decisión:**
  1. **Vercel Pro** es requisito (la sincronización horaria no es posible en Hobby). La SPA se sirve como estáticos de Vercel y la API como función Node.
  2. **El *worker* es una función `tick`** que Vercel Cron invoca cada 5 minutos (configurable): reclama trabajo vencido con `SELECT … FOR UPDATE SKIP LOCKED` y procesa hasta un plazo interno (p. ej. 700 de los 800 s); lo que no termina queda para el siguiente tick. En local, un bucle ejecuta la misma función.
  3. **Sin pg-boss:** una tabla de sistema `jobs` (DATABASE_SCHEMA §3.5) para el trabajo recurrente por cuenta (incremental, reexpresión, entidades, validación del token) y el puntual (backfill, post-sync, notificaciones), con reintentos, `run_after` para respetar el gobernador y `dedupe_key` para no duplicar. Va **sin RLS** para que el tick vea el trabajo de todos los tenants, y solo guarda identificadores; el tick fija `app.tenant_id` antes de tocar datos. Los informes asíncronos de Meta se guardan con su `report_run_id` y se sondean en ticks sucesivos, sin bloquear una función.
  4. **Neon Launch** como mínimo propuesto; confirmar plan y ventana de PITR antes de contratar. Una ventana de retención no demuestra un RPO de 15 min: este objetivo requiere prueba de recuperación. Conexión por el endpoint con *pooling* desde las funciones (`SET LOCAL` funciona en modo transacción); las migraciones, por el endpoint directo. Postgres 17 también en local (docker compose).
  5. **Región:** las funciones de Vercel y la BD de Neon en la misma región (pendiente de PQ-04b: residencia de datos).
  6. **Secretos** como variables de entorno *Sensitive* de Vercel, separadas por entorno.
- **Alternativas:** un worker permanente en otro proveedor (Fly, Railway): un segundo proveedor que operar; Vercel Queues o Workflows (válidos, pero atan la lógica de negocio a una API propietaria; se reevalúan si el tick se queda corto); pg-boss en modo manual (su cron y su mantenimiento dependen de un proceso vivo).
- **Consecuencias:** costo fijo de Vercel Pro y Neon Launch. Latencia de la sincronización ≤ intervalo del tick + duración. Hay que trocear el trabajo largo (backfill por meses y cuentas) para que quepa en un tick. Las IP de salida de Vercel son dinámicas: la *Server Allow List* de Meta solo es posible con la opción de IPs estáticas de Vercel (plan y costo a verificar; no admite duraciones por encima de 800 s), por lo que en el MVP se confía en Require App Secret + `appsecret_proof`. Los logs de Vercel tienen retención corta: hace falta un *log drain* o los datos operativos en la BD (ya previstos en `sync_runs` y `meta_api_calls`).
- **Revisar si:** un tick no basta para el volumen (más de unas 200 cuentas), o Vercel Workflows encaja mejor para el trabajo largo sin acoplar el dominio.

## ADR-020 — No agregar monedas distintas sin conversión explícita

- **Contexto:** las cuentas pueden tener monedas distintas (SUP-07). Sumar EUR y MXN da cifras falsas.
- **Decisión:** las agregaciones de cartera se agrupan por moneda por defecto. La conversión es opcional, con una fuente declarada (tipos diarios del BCE, propuesta), la fecha del tipo y la etiqueta "convertido (aprox.)". Las conversiones nunca se guardan en los hechos: se aplican al consultar.
- **Alternativas:** convertir todo a una moneda base al ingerir (pierde la exactitud y dificulta conciliar con Ads Manager).
- **Consecuencias:** la UI de cartera muestra varios totales cuando hay varias monedas.
- **Revisar si:** todas las cuentas comparten moneda (se simplifica la UI).

## ADR-021 — Estados de dato explícitos

- **Contexto:** el requisito 1.8 (disponible, estimado o no disponible) y el 4.3 (ausencia de datos ≠ mal rendimiento).
- **Decisión:** cada valor expuesto por la API lleva un estado (`available`, `estimated`, `unavailable`, `not_applicable`, `immature`). `null` en la BD significa no disponible y `0` significa un cero reportado. La UI muestra "No disponible" (con el motivo), un distintivo de "Estimado" y un sombreado de "En maduración". Un test e2e verifica que un valor no disponible nunca se presenta como 0.
- **Alternativas:** devolver `0` o `null` sin semántica (es lo que hacen los repositorios evaluados y produce diagnósticos erróneos).
- **Consecuencias:** las respuestas de la API son algo más verbosas; el catálogo de métricas debe declarar el estado de cada fuente.
- **Revisar si:** nunca: es un principio.

## ADR-023 — Motor de auditoría: función pura, cinco subíndices y una sola configuración

- **Contexto:** F3 pide un motor determinista, configurable y explicable (ARCHITECTURE §6.5 y §6.6), y el encargo fija los subíndices de eficiencia, estabilidad, entrega, medición y fatiga y exige benchmarks internos en lugar de valores universales.
- **Decisión:** el motor es una función pura `runAudit(datos, configuración) → hallazgos + salud`; la BD solo carga y guarda, y cada ejecución guarda la huella de sus entradas. El índice `health-v1` tiene esos cinco subíndices; el volumen y la estructura del diseño inicial pasan a ser reglas (R-PERF-003, R-STR-011). Las referencias son siempre el objetivo del cliente, la línea base propia o la mediana de la cuenta. La configuración (ventanas, umbrales, pesos, objetivos y parámetros por regla) vive en una sola tabla `audit_configs` validada por esquema, con herencia por defecto ← organización ← cliente, en lugar de `rule_configs` y `kpi_targets` separadas.
- **Alternativas:** reglas con acceso directo a la BD (difíciles de probar y de reproducir); siete componentes de salud (volumen y estructura duplican lo que ya dicen dos reglas); umbrales fijos por vertical (no hay datos que los respalden y el encargo los excluye).
- **Consecuencias:** los casos de prueba son datos sintéticos en memoria (rápidos y deterministas); cambiar una fórmula exige subir `formula_version` o la versión de la regla; los objetivos KPI se editan como parte de la configuración (falta su interfaz, TD-21).
- **Revisar si:** el piloto muestra que el volumen o la estructura deberían pesar en la nota, o si hace falta historial de cambios de configuración más fino que el registro de auditoría.

## ADR-024 — Asistente de IA: respuesta estructurada verificable, herramientas de lectura y presupuestos por configuración

- **Contexto:** F4 pide un asistente que responda, explique, compare, proponga hipótesis y recomiende con evidencia, sin inventar cifras, resistente a la inyección, con control de acceso y de costo, y sin ejecutar modificaciones sin aprobación explícita (ARCHITECTURE §6.8).
- **Decisión:** el modelo solo responde con la herramienta `submit_answer` (esquema estricto con evidencia por afirmación, hipótesis y recomendación) y un verificador determinista comprueba cifras, ids, entidades, suficiencia y lenguaje, con un solo turno de corrección; lo que no pasa se muestra marcado. Las herramientas son de solo lectura, corren con el contexto del usuario y exigen `ai_processing`; la prioridad de las recomendaciones la calcula el servidor. El historial es solo de anexar (prompt y herramientas fijos, contexto por mensaje de sistema intermedio). Los presupuestos se configuran por entorno (mismo límite para cada organización) y se contabilizan en `llm_usage`. Las recomendaciones de la IA solo entran a la cola de aprobación si el usuario las propone.
- **Alternativas:** texto libre con extracción de cifras a posteriori (no permite exigir evidencia por afirmación ni rechazar entidades inventadas); salidas estructuradas con `output_config.format` (no combinan con el bucle de herramientas que necesita la consulta); prioridad decidida por el modelo (no reproducible); presupuestos por organización editables (no hacen falta mientras la plataforma es de una sola agencia); insertar automáticamente todas las recomendaciones en la cola (ruido y decisiones sin revisión humana previa).
- **Consecuencias:** un modelo que calcula cifras propias (diferencias, medias) ve su respuesta rechazada: las herramientas devuelven ya las variaciones; los enteros pequeños sin unidad se aceptan como conteos; cambiar el prompt de sistema o las herramientas sube `PROMPT_VERSION` y las conversaciones viejas descartan bloques de pensamiento antiguos (`drop_block`); con dos peticiones simultáneas un usuario puede pasarse ligeramente del presupuesto (sin reserva con bloqueo, TD-28).
- **Revisar si:** las evaluaciones en vivo muestran muchas respuestas correctas rechazadas por el verificador, si se abre a varias agencias (presupuestos por tenant) o si hace falta streaming para la experiencia de uso.

## ADR-025 — Pronóstico y simulación: modelos simples validados, calculados al pedirlos

- **Contexto:** F6 pide pronósticos y escenarios de presupuesto con validación retrospectiva, intervalos calibrados y sin afirmar causalidad (ARCHITECTURE §6.10, CA-F6-01 a 04). La historia real disponible hoy es de 27 días de una cuenta; la mayoría de las cuentas tendrán meses, no años.
- **Decisión:**
  1. **Pronóstico:** dos candidatos (perfil semanal y ETS(A,Ad,A)) frente al ingenuo estacional en un backtest de origen móvil semanal con el hueco de maduración de conversiones. Se publica solo si el MAE relativo al ingenuo, en los mismos puntos, es < 1 (lectura estricta de CA-F6-01; el MASE se informa) y la cobertura diaria del intervalo del 80 % está en [70 %, 90 %] (CA-F6-02).
  2. **Intervalos empíricos conformes en el tiempo:** cuantiles de errores normalizados de orígenes ya observados, con la corrección de muestra finita (m + 1)/m. Para coberturas medidas con pocas evaluaciones (costos derivados, curvas), el rango [70 %, 90 %] se amplía un error típico binomial.
  3. **Escenarios:** curva de respuesta semanal por campaña, Poisson sobredispersa log-lineal con a priori débil N(0,7; 0,25²) sobre la elasticidad y aproximación de Laplace; validación de un paso con PIT aleatorizado; Monte Carlo con 10.000 extracciones y semilla. Marcas de extrapolación (fuera del rango semanal observado) y de cambio grande (> ±30 %).
  4. **Sin persistencia:** se calcula al pedirlo (`POST /v1/forecasts` y `/v1/simulations`, de solo lectura) con versión del motor y huella de las entradas.
  5. **Markov, Kaplan-Meier, ARIMA, Prophet y modelos jerárquicos, fuera:** no se cumplen sus criterios de datos o no mejoran lo necesario (FORECASTING §3).
- **Alternativas:** intervalos analíticos de ETS (suponen normalidad y subestiman la incertidumbre de parámetros); regresión log-log por mínimos cuadrados (sin a priori, b no se identifica cuando el gasto varía poco, y los logaritmos no admiten semanas con 0 eventos); costo por evento constante (supone retornos lineales, el defecto que se señaló en fortytwode, ADR-014); el margen de ±50 % sobre el rango observado para la extrapolación (los experimentos mostraron cobertura real del 50–67 % con +100 % sin que saltara la marca); tablas `forecasts`/`simulations` (nada las necesita aún).
- **Consecuencias:** con la historia actual no se publica ningún pronóstico ni escenario y la interfaz dice cuántos días faltan (199 para 28 días de horizonte; 18 semanas por campaña para un escenario). Tras un cambio de régimen la serie deja de publicarse hasta recalibrarse. Los escenarios lejos del gasto observado quedan marcados, porque la validación de un paso no puede detectar una forma de curva equivocada (FORECASTING §8, E4).
- **Revisar si:** los pronósticos con datos reales no superan al ingenuo, la cobertura real (pronósticos guardados frente a lo ocurrido) se aleja del 80 %, hay campañas con 1–2 años de historia (festivos) o se dispone de experimentos de incrementalidad para estimar efectos causales.
- **Revisión científica 2026-10-26:** `forecast-1.2.0` separa seis orígenes iniciales de selección y la evaluación posterior, y rehace la limpieza dentro del corte. `simulate-2.0.0` controla curvatura, tendencia, eventos y gasto de pares, remuestrea choques conjuntos y bloquea planes fuera del soporte validado. Los intervalos son nominales y condicionales, con limitaciones empíricas visibles (E6 y E7). No se ha demostrado que ARIMA/Prophet rindan peor; se mantienen diferidos. Los efectos de eventos son jerárquicos aproximados; los diseños de experimentos sí se persisten (migraciones 0009/0010), sin cambiar presupuestos publicitarios. La especificación vigente y la evidencia completa están en [FORECASTING.md](FORECASTING.md).


## ADR-026 — Action Center: aprobación explícita, asignaciones absolutas y reconciliación de envíos ambiguos

- **Contexto:** ejecutar recomendaciones aceptadas exige evidencia de lo aprobado, permisos actuales y recuperación tras fallos de red sin duplicar cambios publicitarios.
- **Decisión:** solo campos de estado y presupuesto permitidos, políticas versionadas por cuenta y bloqueo global por defecto; diffs en vivo con TTL, aprobación independiente (doble para activaciones/cambios desde umbral), cola Postgres y advisory lock de cuenta Meta. Confirmar un marcador durable antes del POST; si el resultado es ambiguo, solo releer. Cada transición se guarda en una bitácora de solo inserción. Rollback como propuesta inversa cuando la configuración siga coincidiendo con la verificada.
- **Alternativas:** reintentar POST tras timeout (puede duplicar o pisar un cambio externo), aprobar recomendaciones como permiso de escritura implícito (no fija estado vivo ni diff), compensar automáticamente fallos con cambios inversos (puede deshacer trabajo ajeno), prometer exactly-once remoto (no hay transacción distribuida con Graph).
- **Consecuencias:** puede haber acciones pendientes de reconciliación manual; no se restituye gasto ni aprendizaje. Se usa la cola existente sin una dependencia nueva. La reautenticación reforzada y los webhooks quedan pendientes; no se habilita ninguna regla de escritura automática. [Especificación y pruebas](ACTION_CENTER.md).

## ADR-027 — Operación segura: reservas durables, fencing y recuperación en cuarentena

- **Contexto:** la auditoría integral detectó riesgo de carreras en presupuestos LLM, respuestas de workers vencidos, reutilización accidental de bases y replay de efectos externos tras restaurar. Todavía no existen staging ni producción.
- **Decisión:** reservar cada llamada LLM bajo bloqueo por tenant antes del proveedor; sin retries/fallback automáticos; conservar reservas desconocidas hasta conciliación. Vincular conversaciones a alcance/consentimiento vigente. UUID por lease y confirmación condicionada. Vincular base a APP_ENV, runtime sin owner/BYPASSRLS, cuarentena inicial y permiso operativo separado. Restaurar solo sobre base vacía, autenticar archivo antes del SQL y cancelar jobs/convertir envíos ambiguos sin replay. Publicar una marca de backup solo después del recibo externo y una de simulacro después de validaciones revisadas. Producción de forecasting deshabilitada por defecto.
- **Alternativas:** reintentar POST/cobros ambiguos, asumir presupuesto por una lectura sin bloqueo, confiar en un lease vencido, restaurar y arrancar jobs automáticamente o acreditar RPO/RTO desde CI sintética. Se rechazan por duplicación o por evidencia insuficiente.
- **Consecuencias:** las reservas ambiguas consumen presupuesto hasta revisión; la primera migración requiere mantenimiento y workers anteriores detenidos. La caché acotada de 15 s mejora lecturas repetidas con alcance revalidado, pero no acredita el SLO frío/cloud. Se corrige la consecuencia de ADR-024 sobre sobrepaso concurrente: ahora hay reserva con bloqueo. No habilita recursos cloud ni autorizaciones de proveedor.
- **Evidencia y revisión:** [informe de preparación](PRODUCTION_READINESS_2026-10-26.md), [runbook](OPERATIONS.md), [costos](OPERATING_COSTS.md). Revisar tras siete días de staging y un simulacro cloud; la aprobación de producción permanece bloqueada.

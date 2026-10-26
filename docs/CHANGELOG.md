# Changelog — Ad Astra

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/). Las versiones `0.x` corresponden a las fases del [ROADMAP](ROADMAP.md#1-vista-general).

## [Unreleased] — F1 (base y sincronización con Meta), F2 (analítica), F3 (motor de auditoría), F4 (asistente de IA) y F6 (pronóstico y simulación)

### Añadido
- **Pronóstico y simulación (F6)** en `src/modules/forecasting/`: pronóstico "si nada cambia" (gasto, impresiones, clics, visitas, clientes potenciales, conversaciones, compras e instalaciones, con CPM, CPC y costos por evento) con ingenuo estacional, perfil semanal y ETS(A,Ad,A); backtest de origen móvil con el hueco de maduración; intervalos empíricos conformes en el tiempo; publicación solo con MAE relativo < 1 y cobertura del 80 % calibrada; criterios mínimos de datos, cortes por cambio de atribución y pausa, eventos externos excluibles y picos aislados acotados. Escenarios de presupuesto por campaña con curva de respuesta bayesiana (Poisson sobredispersa, a priori débil sobre la elasticidad, aproximación de Laplace) validada con una predicción de un paso y Monte Carlo de 10.000 extracciones con semilla, cambio esperado frente al gasto actual y marcas de extrapolación y cambio grande. `POST /v1/forecasts` y `POST /v1/simulations` (solo lectura); vista `/prevision` con gráfico de abanico, fichas de modelo, totales y simulador, enlazada desde la analítica; `pnpm forecast:experiments`. Matemáticas y experimentos en [FORECASTING.md](FORECASTING.md); decisión en ADR-025.
- **Pruebas (F6)**: 27 tests nuevos (278 en total): modelos, historia utilizable, backtest y calibración, sin fuga de futuro, recuperación de la elasticidad, muestreadores, Monte Carlo y la API de punta a punta.
- **Asistente de IA (F4)** en `src/modules/ai/`: interfaz `LlmProvider` desacoplada con adaptador Anthropic (`claude-opus-5-5` por defecto, pensamiento adaptativo, esfuerzo configurable, herramientas estrictas, caché de prompts y respaldo del servidor `fallbacks: "default"`); herramientas de solo lectura `get_scope`, `get_metrics`, `decompose_change`, `get_findings` y `get_health` con permisos, esquemas de entrada y salida, RLS, alcance por cliente, consentimiento `ai_processing` y suficiencia de datos; respuesta estructurada con evidencia, hipótesis y recomendaciones priorizadas (impacto como hipótesis, confianza, dependencias, riesgo y acción); verificador determinista de cifras, ids, entidades, suficiencia y lenguaje con un turno de corrección; neutralización de textos de terceros con instrucciones; límites de llamadas, presupuestos por organización, usuario y pregunta, y límite de preguntas por minuto; `POST /v1/ai/ask`, conversaciones, traza, estado y `POST /v1/ai/messages/:id/recommendations/:index/propose` (a la cola de aprobación, sin ejecutar nada); vista `/asistente` y enlace desde el dashboard; `pnpm ai:eval` para la evaluación en vivo (manual y autorizada).
- **Datos (F4)**: migraciones `0007_ai.sql` y `0008_ai_rls.sql` con `ai_conversations` y `ai_messages` (privadas por usuario) y `llm_usage` (solo inserción).
- **Pruebas (F4)**: 47 tests nuevos (251 en total): verificador, proveedor contra un `fetch` falso, asistente de punta a punta con un proveedor guionizado y la suite de evaluaciones contra respuestas inventadas, inyección, aislamiento, presupuestos y privacidad.
- **Motor de auditoría (F3)** en `src/modules/audit/`: función pura y determinista con huella de entradas; 15 reglas en 10 categorías (eficiencia, rendimiento, estabilidad, fatiga, entrega, estructura, atribución, medición, cambios bruscos y calidad de datos) con parámetros validados por esquema, elegibilidad, muestra mínima y tres salidas; perfiles por objetivo (reconocimiento, tráfico, interacción, mensajes, clientes potenciales, ventas, app y otros); referencias internas (objetivo del cliente → línea base propia → mediana de la cuenta); estadística propia (Gamma-Poisson, Beta, dos proporciones, z robusta, Benjamini-Hochberg); severidad por impacto, confianza y prioridad; ciclo de vida con `finding_events`; índice `health-v1` con cinco subíndices (eficiencia, estabilidad, entrega, medición y fatiga), cobertura y "Datos insuficientes"; configuración por organización y cliente (`audit_configs`); ejecución tras cada sincronización y con `POST /v1/ad-accounts/:id/audit`; `GET /v1/audit/entity`, `/v1/audit/catalog` y `/v1/audit/config`; panel de salud y hallazgos en el dashboard.
- **Analítica (F2)**: catálogo único de métricas compartido por la API y la web; `GET /v1/analytics` con vistas de cartera a anuncio, comparación de periodos, monedas separadas, frescura y origen de cada métrica; exportación CSV auditada; dashboard responsive con tendencia (SVG propio, accesible por teclado y con tabla), desglose de resultados, estados de entrega, filtros, columnas configurables y variación para investigar anomalías.
- **Datos**: migraciones `0004_insights_parents.sql` (padres de cada fila de Insights), `0005_audit.sql` y `0006_audit_rls.sql` (ejecuciones, hallazgos, historial, salud y configuración del motor).
- **Sincronización con Meta**: cola de trabajos en Postgres (`jobs`, `FOR UPDATE SKIP LOCKED`, recurrentes, deduplicación, backoff) drenada por un tick (`GET /v1/internal/tick` con `CRON_SECRET`, o `pnpm dev:worker` en local); gobernador de cuotas por app y cuenta (`meta_rate_state`); trabajos de validación del token, descubrimiento de cuentas, entidades (campañas, conjuntos y anuncios), Insights incremental, reexpresión de 28 días y backfill por meses en los 4 niveles; extracción versionada de KPIs con fechas locales de la cuenta; `sync_runs` con versión de API, ventana, llamadas, filas y error redactado.
- **Datos**: migraciones `0002_sync.sql` y `0003_sync_rls.sql` con `adsets`, `ads`, `sync_runs`, `insights_daily` particionada por mes (particiones sin acceso directo para `app_rw`), `jobs` y `meta_rate_state`.
- **API y web**: activar la sincronización de una cuenta (exige el consentimiento `read_insights` de su cliente) encola sus trabajos y desactivarla los cancela; `GET /v1/ad-accounts/:id/sync-runs`; última sincronización en las cuentas y última validación en las conexiones.
- **Pruebas**: Meta simulado (`test/fake-meta.ts`: rutas, paginación, errores, cabeceras de uso, `appsecret_proof`) y 43 tests nuevos (137 en total): cola, gobernador, extracción, sincronización completa y su API, aislamiento de las tablas y particiones nuevas, y la carrera al editar un miembro.
- **Backend** Fastify 5 con zod (validación, serialización y OpenAPI en `/v1/openapi.json`), errores RFC 9457 uniformes, log de acceso estructurado sin query strings, `x-request-id`, helmet, límite de peticiones y CSRF por `Origin`.
- **Configuración** validada con zod al arrancar (`src/platform/config.ts`); `.env.example` con todas las variables.
- **Base de datos**: Drizzle ORM, migraciones `0000_init.sql` (generada y revisada) y `0001_rls.sql` (aislamiento escrito a mano), BD de tests separada (`ad_astra_test`), `pnpm db:migrate`.
- **Modelo**: organizaciones, usuarios y sesiones (Better Auth), membresías, invitaciones, clientes, asignaciones, consentimientos, conexiones Meta, cuentas publicitarias, campañas, ejecuciones de auditoría, hallazgos, recomendaciones y registro de eventos de solo inserción.
- **Aislamiento**: RLS forzado en las 13 tablas de tenant, funciones de contexto, FK compuestas `(tenant_id, id)`, contexto por transacción y verificación de la membresía del tenant activo.
- **Autenticación**: Better Auth con Google Workspace (`hd`), alta solo por invitación, tokens OAuth cifrados; `pnpm admin:bootstrap` para crear la primera organización.
- **Autorización**: RBAC (owner, admin, manager, analyst, viewer), alcance por cliente e invariante de arranque (ninguna ruta sin control de acceso).
- **API v1**: me, miembros, invitaciones, clientes, asignaciones, consentimientos, conexiones Meta (token de solo escritura, cifrado AES-256-GCM con AAD), cuentas, campañas, hallazgos, recomendaciones y registro de eventos.
- **Web**: SPA con React 19, Vite 8, React Router, TanStack Query y Tailwind 4: login con Google, organización activa, clientes, cuentas y conexiones.
- **Pruebas**: 94 tests, incluidos aislamiento en BD, seguridad de la API entre tenants, token canario y Better Auth real; pruebas de mutación de las defensas.
- **CI**: typecheck de servidor y web, lint, tests con Postgres, build de la web, comprobación de documentación, auditoría de dependencias y gitleaks.

### Cambiado
- `findAccount` pasa a `catalog/accounts.ts` y `localDate` a `insights/catalog.ts`, para que los módulos de lectura (analítica, auditoría e IA) no arrastren la sincronización ni el cliente de Meta.
- `platform/access.ts` concentra la lógica de invitaciones y membresías (antes en `modules/tenancy`), para que `platform` no dependa de ningún módulo.
- CSRF por verificación de `Origin` en lugar del token de doble envío previsto (SECURITY §4.5).
- `pnpm-workspace.yaml` autoriza los scripts de instalación de `esbuild` (pnpm 11 los bloquea por defecto).
- El cliente de Meta envía el token solo en `Authorization: Bearer` (V-02 confirmado en el spike); desaparece la opción de llevarlo en la URL.
- Al dar de alta una conexión se encola su validación; revocarla vacía su cola.
- Editar un miembro que otro administrador acaba de quitar responde 404 en lugar de 500 (condición de carrera detectada por un test).

## [0.1.0-pre] — F0 (pendiente de cerrar con el spike de Meta)

### Añadido
- Repositorio git local (`main`) con un solo paquete pnpm; TypeScript 7 estricto ejecutado de forma nativa por Node ≥ 22.18; Biome (lint y formato); Vitest.
- `docker-compose.yml`: Postgres 17 local en el puerto 55432 y `db/init/01-roles.sql` con los roles `app_owner` y `app_rw` (sin DDL ni `BYPASSRLS`).
- `src/platform/logging.ts`: logger pino con redacción de tokens, `appsecret_proof`, secretos, cabeceras `Authorization` y URLs.
- `src/modules/meta/`: cliente mínimo de Graph / Marketing API v26.0 (`appsecret_proof`, token en la URL o en cabecera, GET y POST, paginación por cursor sin seguir `paging.next`, errores sin truncado silencioso, fallos de red redactados, `fetch` inyectable), taxonomía de errores, lectura de las cabeceras de uso, lista de campos y snapshot de las specs oficiales (`facebook-business-sdk-codegen@8420be6`).
- `scripts/spike-meta.ts` (spike manual autorizado de V-01 a V-12), `scripts/sanitize.ts` (sanitizador de fixtures), `scripts/update-meta-specs.ts`, `scripts/check-docs.ts`.
- 51 tests: contrato de campos con las specs, taxonomía de errores, cliente, canario de tokens en logs, sanitizador, anclas de documentación y roles de BD contra Postgres real.
- `.github/workflows/ci.yml`: typecheck, lint, tests con Postgres 17 de servicio, comprobación de documentación, auditoría de dependencias y gitleaks. Primera ejecución en verde (run 40007312436).
- Repositorio privado `MaycollJaramillo01/ad-astra` y `.gitattributes` con finales de línea LF.
- `README.md` de puesta en marcha.
- ADR-022: despliegue en Vercel Pro + Neon con el worker como función `tick` programada.
- Checklist de configuración en Meta (API_INTEGRATIONS §1.21).

### Cambiado
- Plan aprobado: los ADR pasan a "Aceptada", salvo 006 y 009 (dependen del spike).
- ADR-001: un solo paquete hasta que la web lo requiera (F1).
- ADR-019: Google Workspace como único método de acceso (PQ-05).
- Respuestas a PQ-01, PQ-02, PQ-04 y PQ-05 incorporadas a MASTER_PLAN, ARCHITECTURE, SECURITY, DATABASE_SCHEMA, ROADMAP y TESTING.

### Eliminado
- ADR-003 (pg-boss) sustituido por ADR-022: pg-boss necesita un proceso permanente, que Vercel no ofrece.

## [0.0.1] — 2026-10-23 — Planificación

### Añadido
- `docs/MASTER_PLAN.md`: documento rector con visión, clasificación de requisitos (confirmados, propuestos y supuestos), hechos verificados, MVP, registro de riesgos, reglas de ejecución y preguntas abiertas.
- `docs/ARCHITECTURE.md`: monolito modular, módulos y reglas de dependencia, flujos de conexión y sincronización, gobernador de cuotas, catálogo de métricas, motor de auditoría con 16 reglas iniciales, fórmula de salud `health-v1`, capa de IA de solo lectura con verificador de cifras, máquina de estados de acciones, enfoque de predicción, contrato de API v1, RNF, despliegue y observabilidad.
- `docs/API_INTEGRATIONS.md`: Marketing API v26 (ciclo de vida, modelo de acceso de agencia, permisos y niveles, tokens, `appsecret_proof`, endpoints y campos verificados con las specs oficiales, Insights, atribución 2025–2026, matriz de disponibilidad, límites, taxonomía de errores, sincronización, escrituras, webhooks, conectores de IA oficiales, condiciones de la plataforma, 14 puntos a verificar), proveedor LLM y email.
- `docs/DATABASE_SCHEMA.md`: convenciones, diagrama ER, boceto SQL de las tablas del MVP, RLS con fallo cerrado, particionado mensual, retención y purga, migraciones y estimación de volumen.
- `docs/SECURITY.md`: activos, STRIDE, controles, cumplimiento, backups, incidentes y checklist por fase.
- `docs/DECISIONS.md`: 21 ADR, incluida la evaluación de los 6 repositorios open source candidatos (ADR-014).
- `docs/ROADMAP.md`: fases F0–F7 con 9 apartados cada una, trazabilidad, MoSCoW, hitos y registro de deuda técnica.
- `docs/TESTING.md`: principios, pirámide, datos de prueba, política de credenciales, puertas de la CI, catálogo de criterios de aceptación y procedimiento de pruebas manuales autorizadas.
- `docs/CHANGELOG.md`: este archivo.

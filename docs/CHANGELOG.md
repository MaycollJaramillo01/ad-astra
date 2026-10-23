# Changelog — Ad Astra

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/). Las versiones `0.x` corresponden a las fases del [ROADMAP](ROADMAP.md#1-vista-general).

## [Unreleased] — F0 en curso (se publicará como 0.1.0)

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

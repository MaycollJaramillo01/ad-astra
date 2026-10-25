# Ad Astra — Meta Ads Intelligence Platform

Plataforma interna de la agencia para conectar las cuentas publicitarias de Meta autorizadas por los clientes, sincronizar su rendimiento, auditarlas, calificar su salud y alertar de problemas, con optimizaciones solo bajo aprobación humana.
- Documento rector: [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md)
- Fases y estado: [docs/ROADMAP.md](docs/ROADMAP.md)
- Estado actual: **F1 — base del sistema lista** (tenancy, autenticación, RBAC, aislamiento y modelo de datos). El acceso real a Meta todavía no está implementado.

## Requisitos

- Node.js ≥ 22.18 (ejecuta TypeScript de forma nativa)
- pnpm 11 (`corepack enable` activa la versión de `package.json`)
- Docker Desktop (Postgres local)

## Puesta en marcha

1. Instala, levanta Postgres y crea tu `.env.local` a partir de `.env.example` (git lo ignora):

```bash
pnpm install
```

```bash
docker compose up -d
```

2. Aplica las migraciones (rol propietario) y crea la primera organización con su owner, que entra después con Google:

```bash
pnpm db:migrate
```

```bash
pnpm admin:bootstrap --name "Mi Agencia" --slug mi-agencia --owner persona@agencia.com
```

3. Arranca la API y la web, cada una en su terminal, y abre http://localhost:5173:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

El login necesita un cliente OAuth de Google Cloud de tipo "Aplicación web", con la pantalla de consentimiento en modo **Internal** y la URI de redirección `http://localhost:5173/v1/auth/callback/google` (detalles en `.env.example`).

**Sincronización con Meta (opcional).** Con `META_APP_ID` y `META_APP_SECRET` en `.env.local`, el worker procesa la cola cada minuto (`--once` para un solo ciclo). Sin ellas se niega a arrancar: nunca simula datos.

```bash
pnpm dev:worker
```

**Asistente de IA (opcional).** Con `ANTHROPIC_API_KEY` en `.env.local`, la vista `/asistente` responde con los datos sincronizados de los clientes con consentimiento `ai_processing`. Sin ella, la IA queda desactivada (503): nunca simula respuestas. Los límites de costo se configuran con las variables `AI_*` (detalles en `.env.example`). La evaluación en vivo gasta dinero y es manual (docs/TESTING.md §10):

```bash
pnpm ai:eval -- --tenant <uuid> --user <uuid>
```

## Comprobaciones (las mismas que la CI)

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

```bash
pnpm build:web
```

```bash
pnpm docs:check
```

`docker compose` usa el puerto **55432** (puerto alto para no chocar con instalaciones locales de Postgres) y crea dos bases de datos: `ad_astra` (desarrollo) y `ad_astra_test` (los tests la migran y la vacían en cada ejecución). La aplicación se conecta con `app_rw`, un rol sin DDL ni `BYPASSRLS`; las migraciones usan `app_owner`.

## Estructura

```
src/app.ts                 ensamblado de la API (Fastify)
src/server.ts              entrada local
src/contracts.ts           contrato de la API v1 (zod → validación, respuestas y OpenAPI)
src/db/                    esquema Drizzle y contexto de tenant por transacción
src/platform/              config, auth (Google Workspace), RBAC, control de acceso, errores, eventos, cifrado, logs
src/modules/tenancy/       organizaciones, miembros, invitaciones, clientes y consentimientos
src/modules/meta/          conexiones (token cifrado) y cliente de Graph API v26
src/modules/catalog/       cuentas publicitarias y campañas
src/modules/audit/         hallazgos, recomendaciones y registro de eventos
migrations/                SQL generado y revisado (0001_rls.sql: aislamiento)
web/                       SPA (React + Vite + TanStack Query)
test/                      integración y seguridad contra Postgres real
scripts/                   migraciones, alta inicial, spike de Meta, utilidades
```

El contrato OpenAPI está en `GET /v1/openapi.json`.

## Spike de Meta (prueba manual autorizada)

Solo lectura, contra cuentas reales y **nunca en la CI** ([docs/TESTING.md §9](docs/TESTING.md#9-pruebas-manuales-autorizadas)). Rellena las variables `META_*` de `.env.local` y ejecuta:

```bash
pnpm spike:meta
```

Revisa `spike-output/` (local) y las fixtures sanitizadas de `test/fixtures/meta/v26.0/` antes de cualquier commit.

## Seguridad

Nunca subas tokens, secretos ni datos reales sin sanitizar. Ver [docs/SECURITY.md](docs/SECURITY.md).

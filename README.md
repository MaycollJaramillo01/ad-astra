# Ad Astra — Meta Ads Intelligence Platform

Plataforma interna de la agencia para conectar las cuentas publicitarias de Meta autorizadas por los clientes, sincronizar su rendimiento, auditarlas, calificar su salud y alertar de problemas, con optimizaciones solo bajo aprobación humana.
- Documento rector: [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md)
- Fases y estado: [docs/ROADMAP.md](docs/ROADMAP.md)
- Estado actual: **Fase 0 — fundaciones y spikes de viabilidad**

## Requisitos

- Node.js ≥ 22.18 (ejecuta TypeScript de forma nativa, sin compilación previa)
- pnpm 11 (`corepack enable` lo activa con la versión de `package.json`)
- Docker Desktop (para el Postgres local)

## Puesta en marcha

```bash
pnpm install
```

```bash
docker compose up -d
```

```bash
pnpm test
```

`docker compose` levanta Postgres 17 en el puerto **55432** (puerto alto para no chocar con instalaciones locales) y crea los roles `app_owner` (migraciones) y `app_rw` (aplicación, sin DDL ni `BYPASSRLS`). Las credenciales del contenedor son solo de desarrollo.

Otras comprobaciones, las mismas que ejecuta la CI:

```bash
pnpm typecheck
```

```bash
pnpm lint
```

## Spike de Meta (prueba manual autorizada)

Solo lectura, contra cuentas reales y **nunca en la CI** ([docs/TESTING.md §9](docs/TESTING.md#9-pruebas-manuales-autorizadas)).
1. Copia `.env.example` a `.env.local` (git lo ignora) y rellena `META_APP_ID`, `META_APP_SECRET` y `META_ACCESS_TOKEN` (token del usuario del sistema con `ads_read`). Opcional: `META_SPIKE_ACCOUNT_ID`.
2. Ejecuta:

```bash
pnpm spike:meta
```

3. Revisa `spike-output/report.json` (local) y compara `spike-output/reconciliacion.csv` con Ads Manager (mismo rango "Últimos 30 días").
4. Revisa a mano las fixtures sanitizadas de `test/fixtures/meta/v26.0/` antes de añadirlas a un commit.

## Estructura

```
src/platform/       logging con redacción de secretos
src/modules/meta/   cliente de Graph / Marketing API v26, taxonomía de errores, campos y snapshot de specs
scripts/            spike de Meta, sanitizador de fixtures, actualización del snapshot de specs
db/init/            roles de la base de datos local
docs/               documentación transversal del proyecto
```

Al cambiar la versión de la API (`META_API_VERSION`), regenera el snapshot de specs oficiales:

```bash
pnpm specs:update
```

## Seguridad

Nunca subas tokens, secretos ni datos reales sin sanitizar. Ver [docs/SECURITY.md](docs/SECURITY.md).

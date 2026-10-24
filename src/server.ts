// Entrada local: pnpm dev:api (lee .env.local). En Vercel la API se monta como función (ADR-022).
import { buildApp } from './app.ts';
import { createDb } from './db/client.ts';
import { loadConfig } from './platform/config.ts';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '127.0.0.1' });

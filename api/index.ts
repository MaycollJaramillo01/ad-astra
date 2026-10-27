import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db/client.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createNodeHandler } from '../src/platform/node-handler.ts';

let cached: ReturnType<typeof buildApp> | undefined;
export default createNodeHandler(async () => {
  if (!cached) {
    if (process.env.DATABASE_URL_OWNER)
      throw new Error('La credencial de migración no debe existir en el runtime');
    const config = loadConfig(),
      { db, pool } = createDb(config.DATABASE_URL);
    cached = buildApp({ config, db });
    cached.catch(() => {
      cached = undefined;
      void pool.end();
    });
  }
  return cached;
});

// Tick en local: lo que en Vercel hace Cron llamando a /v1/internal/tick (ADR-022).
//   pnpm dev:worker          → un tick por minuto hasta Ctrl+C
//   pnpm dev:worker --once   → un solo tick
import { setTimeout as sleep } from 'node:timers/promises';
import { createDb } from '../src/db/client.ts';
import { createTickRunner } from '../src/modules/meta/tick.routes.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createTokenCipher } from '../src/platform/crypto.ts';
import { createLogger } from '../src/platform/logging.ts';

const config = loadConfig();
const log = createLogger(undefined, config.LOG_LEVEL);
const { db, pool } = createDb(config.DATABASE_URL);
const cipher = createTokenCipher(config.TOKEN_ENCRYPTION_KEYS, config.TOKEN_ENCRYPTION_KEY_VERSION);
const tick = createTickRunner(config, db, cipher, log);

if (!tick) {
  log.error('Falta META_APP_ID o META_APP_SECRET: no hay nada que sincronizar');
  process.exitCode = 1;
} else {
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  do {
    log.info(await tick(), 'tick terminado');
    if (process.argv.includes('--once')) break;
    await sleep(60_000, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
}
await pool.end();

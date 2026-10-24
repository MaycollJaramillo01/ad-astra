import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Db } from '../../db/client.ts';
import type { Config } from '../../platform/config.ts';
import type { TokenCipher } from '../../platform/crypto.ts';
import { AppError, notFound, unauthorized } from '../../platform/errors.ts';
import { runTick } from '../../platform/jobs.ts';
import { createSyncHandlers } from './sync.ts';

// Tick de la cola (ADR-022): Vercel Cron llama a GET /v1/internal/tick con
// "Authorization: Bearer $CRON_SECRET" cada pocos minutos. En local lo hace scripts/worker.ts.

/** El tick listo para ejecutar, o null si falta la app de Meta (no se simula nada). */
export function createTickRunner(config: Config, db: Db, cipher: TokenCipher, log: Logger) {
  if (!config.META_APP_ID || !config.META_APP_SECRET) return null;
  const handlers = createSyncHandlers({
    db,
    cipher,
    meta: { appId: config.META_APP_ID, appSecret: config.META_APP_SECRET },
    log,
  });
  return () =>
    runTick({
      db,
      handlers,
      log,
      budgetMs: config.TICK_BUDGET_SECONDS * 1000,
      concurrency: config.TICK_CONCURRENCY,
    });
}

// Comparación en tiempo constante (sobre hashes para no filtrar la longitud).
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export async function tickRoutes(
  app: FastifyInstance,
  { config, db, cipher }: { config: Config; db: Db; cipher: TokenCipher },
) {
  const tick = createTickRunner(config, db, cipher, app.log as unknown as Logger);

  app.get(
    '/v1/internal/tick',
    // Pública para la sesión de usuario: la protege el secreto del cron.
    { config: { access: { public: true } }, schema: { hide: true } },
    async (request) => {
      if (!config.CRON_SECRET) throw notFound(); // sin secreto configurado, el tick HTTP no existe
      if (!sameSecret(request.headers.authorization ?? '', `Bearer ${config.CRON_SECRET}`))
        throw unauthorized();
      if (!tick)
        throw new AppError(
          503,
          'unavailable',
          'Sincronización no disponible',
          'Falta META_APP_ID o META_APP_SECRET',
        );
      return tick();
    },
  );
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Db } from '../../db/client.ts';
import { deploymentState, jobs, SYNC_KINDS } from '../../db/schema.ts';
import type { Config } from '../../platform/config.ts';
import type { TokenCipher } from '../../platform/crypto.ts';
import { notFound, unauthorized } from '../../platform/errors.ts';
import { runTick } from '../../platform/jobs.ts';
import { assertDeployment, evaluateTechnical } from '../../platform/operations.ts';
import { createAuditHandler } from '../audit/service.ts';
import { createMonitoringHandlers } from '../monitoring/worker.ts';
import { createActionGateway } from '../optimization/meta.ts';
import { createActionHandler } from '../optimization/worker.ts';
import { createSyncHandlers } from './sync.ts';

// Tick de la cola (ADR-022): Vercel Cron llama a GET /v1/internal/tick con
// "Authorization: Bearer $CRON_SECRET" cada pocos minutos. En local lo hace scripts/worker.ts.

/** Monitoreo técnico disponible también sin integración Meta. No se simulan sus llamadas. */
export function createTickRunner(config: Config, db: Db, cipher: TokenCipher, log: Logger) {
  const meta =
    config.META_APP_ID && config.META_APP_SECRET
      ? { appId: config.META_APP_ID, appSecret: config.META_APP_SECRET }
      : null;
  const handlers = {
    ...createMonitoringHandlers(db, config),
    ...(meta
      ? createSyncHandlers({
          db,
          cipher,
          meta,
          log,
        })
      : Object.fromEntries(
          SYNC_KINDS.map((kind) => [
            kind,
            async () => ({
              type: 'reschedule' as const,
              runAfter: new Date(Date.now() + 3600000),
              reason: 'Integración Meta no configurada.',
            }),
          ]),
        )),
    audit: createAuditHandler(db),
    action_execute: createActionHandler({
      db,
      config,
      gateway: createActionGateway({ db, config, cipher }),
    }),
  };
  return async () => {
    await assertDeployment(db, config);
    await db
      .update(deploymentState)
      .set({ workerStartedAt: new Date() })
      .where(eq(deploymentState.id, 1));
    const result = await runTick({
      db,
      handlers,
      log,
      budgetMs: config.TICK_BUDGET_SECONDS * 1000,
      concurrency: config.TICK_CONCURRENCY,
    });
    await db
      .update(deploymentState)
      .set({ workerFinishedAt: new Date() })
      .where(eq(deploymentState.id, 1));
    const tenants = await db.selectDistinct({ tenantId: jobs.tenantId }).from(jobs).limit(100);
    for (const t of tenants) await evaluateTechnical(db, t.tenantId);
    log.info({ event: 'worker.tick', ...result }, 'tick técnico terminado');
    return result;
  };
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
      return tick();
    },
  );
}

import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Db } from './db/client.ts';
import { createProvider, type LlmProvider } from './modules/ai/provider.ts';
import { aiRoutes } from './modules/ai/routes.ts';
import { auditEngineRoutes } from './modules/audit/engine.routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { catalogRoutes } from './modules/catalog/routes.ts';
import { forecastingRoutes } from './modules/forecasting/routes.ts';
import { insightsRoutes } from './modules/insights/routes.ts';
import { connectionRoutes } from './modules/meta/connections.routes.ts';
import { tickRoutes } from './modules/meta/tick.routes.ts';
import { monitoringRoutes } from './modules/monitoring/routes.ts';
import { type ActionGateway, createActionGateway } from './modules/optimization/meta.ts';
import { actionRoutes } from './modules/optimization/routes.ts';
import { clientRoutes } from './modules/tenancy/clients.routes.ts';
import { tenancyRoutes } from './modules/tenancy/routes.ts';
import {
  type Authenticate,
  createAuth,
  registerAuthRoutes,
  sessionAuthenticator,
} from './platform/auth.ts';
import type { Config } from './platform/config.ts';
import { createTokenCipher } from './platform/crypto.ts';
import { registerErrorHandling } from './platform/errors.ts';
import { registerAccessControl } from './platform/http.ts';
import { createLogger } from './platform/logging.ts';
import { assertDeployment, operationsRoutes } from './platform/operations.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  logger?: Logger;
  /** Solo los tests lo sustituyen; en ejecución real es siempre la sesión de Better Auth. */
  authenticate?: Authenticate;
  /** Solo los tests lo sustituyen (proveedor guionizado); null desactiva la IA. */
  llm?: LlmProvider | null;
  /** Solo tests: el ejecutor de producción usa Graph y el gobernador. */
  actionGateway?: ActionGateway;
}

export async function buildApp({
  config,
  db,
  logger,
  authenticate,
  llm,
  actionGateway,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: (logger ?? createLogger(undefined, config.LOG_LEVEL)) as FastifyBaseLogger,
    // El log de acceso propio (http.ts) registra la plantilla de la ruta, no la URL con su query.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    trustProxy:
      config.NODE_ENV === 'production' ? (_address: string, hop: number) => hop === 0 : false,
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Invariante de arranque: ninguna ruta sin control de acceso declarado (docs/SECURITY.md §4.2).
  app.addHook('onRoute', (route) => {
    if (!route.config?.access)
      throw new Error(`Ruta sin control de acceso: ${route.method} ${route.url}`);
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });

  await app.register(helmet);
  // ponytail: contador en memoria por instancia. En Vercel cada instancia cuenta por su lado;
  // pasar a un almacén compartido (tabla o Redis) si hace falta un límite global.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: { info: { title: 'Ad Astra API', version: '0.2.0' } },
    transform: jsonSchemaTransform,
  });
  registerErrorHandling(app);

  const auth = createAuth(config, db);
  registerAccessControl(
    app,
    db,
    authenticate ?? sessionAuthenticator(auth, config.AUTH_MODE),
    config.APP_ORIGIN,
  );
  registerAuthRoutes(app, auth, config.APP_ORIGIN);
  app.get(
    '/v1/access-options',
    { config: { access: { public: true } }, schema: { hide: true } },
    async () => ({ mode: config.AUTH_MODE }),
  );
  app.addHook('preHandler', async (request) => {
    if (request.tenant || request.routeOptions.url === '/v1/auth/*')
      await assertDeployment(db, config);
  });

  app.get(
    '/v1/health',
    { config: { access: { public: true } }, schema: { hide: true } },
    async () => ({ status: 'ok' }),
  );
  app.get(
    '/v1/ready',
    { config: { access: { public: true } }, schema: { hide: true } },
    async (_request, reply) => {
      try {
        await db.execute(sql`select 1`);
        if ((await assertDeployment(db, config)).recoveryMode)
          throw new Error('Recuperación pendiente');
        return { status: 'ready' };
      } catch {
        return reply.status(503).send({ status: 'unavailable' });
      }
    },
  );
  app.get(
    '/v1/openapi.json',
    { config: { access: { public: true } }, schema: { hide: true } },
    async () => app.swagger(),
  );

  const cipher = createTokenCipher(
    config.TOKEN_ENCRYPTION_KEYS,
    config.TOKEN_ENCRYPTION_KEY_VERSION,
  );
  await app.register(tenancyRoutes, { db });
  await app.register(clientRoutes, { db });
  await app.register(connectionRoutes, { db, cipher });
  await app.register(catalogRoutes, { db });
  await app.register(auditRoutes, { db });
  await app.register(auditEngineRoutes, { db });
  await app.register(insightsRoutes, { db, cacheMs: config.ANALYTICS_CACHE_MS });
  await app.register(forecastingRoutes, { db, enabled: config.FORECASTING_ENABLED });
  await app.register(monitoringRoutes, { db });
  await app.register(operationsRoutes, { db, config });
  await app.register(actionRoutes, {
    db,
    config,
    gateway: actionGateway ?? createActionGateway({ db, config, cipher }),
  });
  await app.register(tickRoutes, { config, db, cipher });
  await app.register(aiRoutes, {
    db,
    config,
    llm: llm !== undefined ? llm : await createProvider(config),
  });
  return app;
}

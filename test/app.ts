import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { Identity } from '../src/platform/auth.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createLogger } from '../src/platform/logging.ts';
import { testDb } from './seed.ts';

// App real (rutas, RBAC, RLS, errores) con una sola sustitución: la identidad la da la cabecera
// x-test-user en lugar de una sesión de Google. Eso no existe fuera de los tests (src/server.ts
// no pasa `authenticate`).

export const config = loadConfig();

export async function testApp(opts: { realAuth?: boolean } = {}) {
  let logs = '';
  const sink = new Writable({
    write(chunk, _enc, done) {
      logs += chunk.toString();
      done();
    },
  });
  const users = new Map<string, Identity>();
  const app = await buildApp({
    config,
    db: testDb(),
    logger: createLogger(sink, 'info'),
    ...(!opts.realAuth && {
      authenticate: async (request) => users.get(String(request.headers['x-test-user'])) ?? null,
    }),
  });
  return {
    app,
    logs: () => logs,
    /** Petición como un usuario (registrado al vuelo) y, opcionalmente, con tenant activo. */
    as(user: { id: string; email: string } | null, tenantId?: string) {
      if (user) users.set(user.id, { userId: user.id, email: user.email });
      return request(app, user?.id, tenantId);
    },
  };
}

function request(app: FastifyInstance, userId?: string, tenantId?: string) {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        origin: config.APP_ORIGIN,
        ...(userId && { 'x-test-user': userId }),
        ...(tenantId && { 'x-tenant-id': tenantId }),
      },
      ...(body !== undefined && { payload: body as object }),
    });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}) => call('POST', url, body),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
    put: (url: string, body: unknown) => call('PUT', url, body),
    delete: (url: string) => call('DELETE', url),
  };
}

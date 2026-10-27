import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

/** Puente Node/serverless: conserva URL, cookies, streaming y los controles de Fastify. */
export function createNodeHandler(load: () => Promise<FastifyInstance>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const app = await load();
      await app.ready();
      app.server.emit('request', req, res);
    } catch {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ status: 'unavailable' }));
    }
  };
}

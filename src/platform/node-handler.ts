import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

export class RuntimeConfigurationError extends Error {}

/** Puente Node/serverless: conserva URL, cookies, streaming y los controles de Fastify. */
export function createNodeHandler(load: () => Promise<FastifyInstance>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const app = await load();
      await app.ready();
      app.server.emit('request', req, res);
    } catch (error) {
      const setup = error instanceof RuntimeConfigurationError;
      res.statusCode = 503;
      res.setHeader('content-type', 'application/problem+json');
      res.setHeader('cache-control', 'no-store');
      res.end(
        JSON.stringify({
          type: setup
            ? 'urn:ad-astra:environment-unconfigured'
            : 'urn:ad-astra:service-unavailable',
          status: 503,
          title: setup
            ? 'Entorno pendiente de configuración'
            : 'Servicio temporalmente no disponible',
          detail: setup
            ? 'El administrador debe completar la configuración segura para habilitar el acceso.'
            : 'Inténtalo de nuevo más tarde.',
        }),
      );
    }
  };
}

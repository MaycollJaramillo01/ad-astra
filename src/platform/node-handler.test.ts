import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createNodeHandler, RuntimeConfigurationError } from './node-handler.ts';

it.each([
  [
    new RuntimeConfigurationError('dato-privado-no-debe-salir'),
    'Entorno pendiente de configuración',
  ],
  [new Error('dato-privado-no-debe-salir'), 'Servicio temporalmente no disponible'],
])('el bootstrap responde con un problema seguro: %s', async (failure, title) => {
  const server = createServer(
    createNodeHandler(async () => {
      throw failure;
    }),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Sin puerto');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/me`);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 503, title });
    expect(body).not.toContain('dato-privado-no-debe-salir');
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

import { expect, it } from 'vitest';
import { testApp } from './app.ts';

it('salud y contrato OpenAPI son públicos; el resto exige sesión con error RFC 9457', async () => {
  const { app, as } = await testApp();
  expect((await as(null).get('/v1/health')).json()).toEqual({ status: 'ok' });
  expect((await as(null).get('/v1/ready')).json()).toEqual({ status: 'ready' });

  const openapi = await as(null).get('/v1/openapi.json');
  expect(openapi.statusCode).toBe(200);
  expect(Object.keys(openapi.json().paths)).toContain('/v1/clients');

  const res = await as(null).get('/v1/clients');
  expect(res.statusCode).toBe(401);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.json()).toMatchObject({
    status: 401,
    type: 'about:blank#unauthorized',
    request_id: res.headers['x-request-id'],
  });

  const missing = await as(null).get('/v1/no-existe');
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ status: 404, type: 'about:blank#not-found' });
  await app.close();
});

it('la app no arranca si una ruta no declara su control de acceso', async () => {
  const { app } = await testApp();
  expect(() => app.get('/v1/sin-acceso', async () => 'x')).toThrow(/sin control de acceso/);
  await app.close();
});

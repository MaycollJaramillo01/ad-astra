import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import { metaConnections } from '../src/db/schema.ts';
import { openConnectionToken } from '../src/modules/meta/connections.routes.ts';
import { createTokenCipher, fingerprint } from '../src/platform/crypto.ts';
import { config, testApp } from './app.ts';
import { type SeededTenant, seedTenant, testDb } from './seed.ts';

// El token de Meta es de solo escritura (docs/SECURITY.md §4.4, CA-F1-03).
const db = testDb();
const cipher = createTokenCipher(config.TOKEN_ENCRYPTION_KEYS, config.TOKEN_ENCRYPTION_KEY_VERSION);
const CANARY = `EAACANARY${randomBytes(24).toString('hex')}`;
let t: Awaited<ReturnType<typeof testApp>>;
let a: SeededTenant;

beforeAll(async () => {
  t = await testApp();
  a = await seedTenant(db);
});

const loadRow = (id: string) =>
  withContext(db, { tenantId: a.tenantId }, async (tx) => {
    const [row] = await tx.select().from(metaConnections).where(eq(metaConnections.id, id));
    return row!;
  });

it('el token canario nunca sale: ni en respuestas, ni en logs, ni en eventos, ni en claro en la BD', async () => {
  const api = t.as(a.owner);
  const created = await api.post('/v1/meta/connections', {
    label: 'Portafolio',
    metaAppId: '1234',
    accessToken: CANARY,
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    status: 'pending',
    tokenFingerprint: fingerprint(CANARY),
  });

  const surfaces = [
    created.body,
    (await api.get('/v1/meta/connections')).body,
    (await api.get('/v1/audit-log')).body,
    (await api.get('/v1/openapi.json')).body,
    t.logs(),
  ];
  for (const surface of surfaces) expect(surface).not.toContain(CANARY);

  const row = await loadRow(created.json().id);
  expect(row.tokenCiphertext.includes(Buffer.from(CANARY))).toBe(false);
  expect(row.tokenKeyVersion).toBe(config.TOKEN_ENCRYPTION_KEY_VERSION);
  expect(openConnectionToken(cipher, row)).toBe(CANARY); // cifrado real y recuperable
});

it('un cifrado copiado a otra fila no se puede descifrar (AAD atado a la fila)', async () => {
  const api = t.as(a.owner);
  const first = await loadRow(
    (
      await api.post('/v1/meta/connections', { label: 'X', metaAppId: '1', accessToken: CANARY })
    ).json().id,
  );
  const second = await loadRow(
    (
      await api.post('/v1/meta/connections', {
        label: 'Y',
        metaAppId: '1',
        accessToken: `${CANARY}b`,
      })
    ).json().id,
  );
  expect(() =>
    openConnectionToken(cipher, {
      ...second,
      tokenCiphertext: first.tokenCiphertext,
      tokenNonce: first.tokenNonce,
    }),
  ).toThrow();
});

it('un token inválido se rechaza sin repetirlo en el error', async () => {
  const short = 'EAAcorto';
  const res = await t
    .as(a.owner)
    .post('/v1/meta/connections', { label: 'X', metaAppId: '1', accessToken: short });
  expect(res.statusCode).toBe(400);
  expect(res.body).not.toContain(short);
});

it('al revocar una conexión se borra el cifrado', async () => {
  const api = t.as(a.owner);
  const id = (
    await api.post('/v1/meta/connections', {
      label: 'Revocable',
      metaAppId: '1',
      accessToken: CANARY,
    })
  ).json().id;
  const revoked = await api.post(`/v1/meta/connections/${id}/revoke`);
  expect(revoked.json()).toMatchObject({ status: 'revoked' });
  const row = await loadRow(id);
  expect(row.tokenCiphertext.length).toBe(0);
  expect((await api.post(`/v1/meta/connections/${id}/revoke`)).statusCode).toBe(404);
});

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMetaClient } from '../src/modules/meta/client.ts';
import { createGovernor, createMetaSession, ThrottledError } from '../src/modules/meta/governor.ts';
import { testDb } from './seed.ts';

// Gobernador de cuotas contra Postgres real y un Meta simulado. Cada test usa una app ficticia
// distinta: los bloqueos de una no afectan a otra (como en Meta, que limita por app).
const db = testDb();

function fakeFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  let calls = 0;
  const fn = (async () => {
    calls++;
    const r = responses.shift() ?? { body: { data: [] } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const setup = (responses: Parameters<typeof fakeFetch>[0]) => {
  const appKey = randomUUID();
  const fake = fakeFetch(responses);
  const governor = createGovernor(db, appKey);
  const client = createMetaClient({ accessToken: 'EAAtest', appSecret: 's', fetch: fake.fn });
  const session = createMetaSession({ client, governor, metaAccountId: 'act_1', pace: false });
  return { governor, session, fake };
};

it('un uso ≥ 90 % en la cuenta bloquea la cuenta durante el tiempo indicado por Meta', async () => {
  const { governor, session, fake } = setup([
    {
      body: { data: [] },
      headers: {
        'x-business-use-case-usage': JSON.stringify({
          act_1: [
            {
              type: 'ads_insights',
              call_count: 95,
              total_cputime: 10,
              total_time: 10,
              estimated_time_to_regain_access: 4,
            },
          ],
        }),
      },
    },
  ]);
  await session.get('/act_1/insights', {}, true);
  const blocked = await governor.blocked([governor.key.account('act_1')]);
  expect(blocked).toBeInstanceOf(ThrottledError);
  expect(blocked!.until.getTime()).toBeGreaterThan(Date.now() + 3.5 * 60_000);

  // La siguiente llamada no llega a Meta.
  await expect(session.get('/act_1/insights', {}, true)).rejects.toBeInstanceOf(ThrottledError);
  expect(fake.calls()).toBe(1);
  // Otro ámbito (la app en general) sigue libre.
  expect(await governor.blocked([governor.key.app])).toBeNull();
});

it('un error de throttling de Insights bloquea solo Insights de esa app', async () => {
  const { governor, session } = setup([
    {
      status: 400,
      body: { error: { code: 4, error_subcode: 1504022, message: 'Too many API requests' } },
    },
  ]);
  const err = await session.get('/act_1/insights', {}, true).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ThrottledError);
  expect((err as ThrottledError).scope).toBe(governor.key.insights);
  expect(await governor.blocked([governor.key.insights])).not.toBeNull();
  expect(await governor.blocked([governor.key.app, governor.key.account('act_1')])).toBeNull();
});

it('un uso bajo no bloquea nada y las páginas se recorren por cursor', async () => {
  const { governor, session, fake } = setup([
    {
      body: { data: [1, 2], paging: { next: 'x', cursors: { after: 'C1' } } },
      headers: {
        'x-app-usage': JSON.stringify({ call_count: 20, total_cputime: 5, total_time: 5 }),
      },
    },
    { body: { data: [3] } },
  ]);
  expect(await session.getAll<number>('/act_1/campaigns', { limit: 2 })).toEqual([1, 2, 3]);
  expect(session.calls).toBe(2);
  expect(fake.calls()).toBe(2);
  expect(await governor.blocked([governor.key.app, governor.key.account('act_1')])).toBeNull();
});

it('un error que no es de cuota se propaga sin bloquear', async () => {
  const { governor, session } = setup([
    { status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } },
  ]);
  await expect(session.get('/act_1/x', {})).rejects.toMatchObject({
    name: 'MetaApiError',
    code: 100,
  });
  expect(await governor.blocked([governor.key.app, governor.key.account('act_1')])).toBeNull();
});

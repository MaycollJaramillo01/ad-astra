import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import { jobs, syncRuns } from '../src/db/schema.ts';
import { testApp } from './app.ts';
import { addMember, type SeededTenant, seedTenant, testDb } from './seed.ts';

// La API pone en marcha y detiene la sincronización; el tick HTTP está protegido por secreto.
// Ningún test de este archivo ejecuta un tick: sin app de Meta configurada no se llama a nadie.
const db = testDb();
let t: Awaited<ReturnType<typeof testApp>>;
let a: SeededTenant;

beforeAll(async () => {
  t = await testApp();
  a = await seedTenant(db);
});

const queued = (tenantId: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, 'queued')));

describe('activación de la sincronización', () => {
  it('dar de alta una conexión encola su validación; revocarla la saca de la cola', async () => {
    const api = t.as(a.owner);
    const created = await api.post('/v1/meta/connections', {
      label: 'Nueva',
      metaAppId: '42',
      accessToken: `EAATEST${randomBytes(16).toString('hex')}`,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await queued(a.tenantId)).map((j) => [j.kind, j.payload])).toContainEqual([
      'token_validation',
      { connectionId: id },
    ]);

    expect((await api.post(`/v1/meta/connections/${id}/revoke`)).statusCode).toBe(200);
    expect(
      (await queued(a.tenantId)).filter(
        (j) => (j.payload as { connectionId?: string }).connectionId === id,
      ),
    ).toEqual([]);
  });

  it('activar una cuenta exige el consentimiento read_insights de su cliente', async () => {
    const res = await t.as(a.owner).patch(`/v1/ad-accounts/${a.account.id}`, { syncEnabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/read_insights/);
    expect(await queued(a.tenantId)).toEqual([]);
  });

  it('activar una cuenta encola sus trabajos con backfill; desactivarla los cancela', async () => {
    const api = t.as(a.owner);
    const url = `/v1/ad-accounts/${a.account.id}`;
    const consent = await api.post(`/v1/clients/${a.client.id}/consents`, {
      scope: ['read_insights'],
      grantedByName: 'Cliente',
      grantedByEmail: 'cliente@example.com',
      grantedAt: new Date().toISOString(),
    });
    expect(consent.statusCode).toBe(201);
    expect((await api.patch(url, { syncEnabled: true })).json()).toMatchObject({
      syncEnabled: true,
      lastInsightsSyncAt: null,
    });
    const forAccount = async () =>
      (await queued(a.tenantId))
        .filter((j) => (j.payload as { adAccountId?: string }).adAccountId === a.account.id)
        .map((j) => j.kind)
        .sort();
    expect(await forAccount()).toEqual([
      'entities',
      'insights_backfill',
      'insights_incremental',
      'insights_restatement',
    ]);

    // Repetir la activación no duplica nada.
    await api.patch(url, { syncEnabled: true });
    expect(await forAccount()).toHaveLength(4);

    await api.patch(url, { syncEnabled: false });
    expect(await forAccount()).toEqual([]);
  });

  it('el historial de sincronizaciones respeta el alcance por cliente', async () => {
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.insert(syncRuns).values({
        tenantId: a.tenantId,
        adAccountId: a.account.id,
        connectionId: a.connection.id,
        kind: 'entities',
        apiVersion: 'v26.0',
        status: 'failed',
        errorMessage: 'Meta API 400 code=100: [REDACTED]',
      }),
    );
    const url = `/v1/ad-accounts/${a.account.id}/sync-runs`;
    const runs = await t.as(a.owner).get(url);
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toContainEqual(
      expect.objectContaining({ kind: 'entities', status: 'failed', apiVersion: 'v26.0' }),
    );

    const outsider = await addMember(db, a.tenantId, 'analyst'); // sin el cliente asignado
    expect((await t.as(outsider).get(url)).statusCode).toBe(404);
    const other = await seedTenant(db);
    expect((await t.as(other.owner).get(url)).statusCode).toBe(404);
  });
});

describe('tick HTTP', () => {
  const SECRET = randomBytes(24).toString('hex'); // generado al vuelo: nada fijo que parezca un secreto

  it('no existe sin CRON_SECRET', async () => {
    expect((await t.as(null).get('/v1/internal/tick')).statusCode).toBe(404);
  });

  it('exige el secreto exacto y no simula nada si falta la app de Meta', async () => {
    const withCron = await testApp({ config: { CRON_SECRET: SECRET } });
    const call = (authorization?: string) =>
      withCron.app.inject({
        method: 'GET',
        url: '/v1/internal/tick',
        headers: authorization ? { authorization } : {},
      });
    expect((await call()).statusCode).toBe(401);
    expect((await call(`Bearer ${SECRET}x`)).statusCode).toBe(401);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomes.done).toBeDefined();
    expect(withCron.logs()).not.toContain(SECRET);
    await withCron.app.close();
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import type { Forecast, Simulation } from '../src/contracts.ts';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import type { DailyRow } from '../src/modules/forecasting/forecast.ts';
import { mulberry32, normal } from '../src/modules/forecasting/simulate.ts';
import { testApp } from './app.ts';
import { day, entity } from './audit-fixtures.ts';
import { synthetic, UNTIL } from './forecast-fixtures.ts';
import { addMember, loadEntities, type SeededTenant, seedTenant, testDb } from './seed.ts';

// Pronóstico y simulación de punta a punta: datos sintéticos en Postgres → API → estados de
// publicación, intervalos y escenarios, con RLS y el alcance por cliente.
const db = testDb();
let t: Awaited<ReturnType<typeof testApp>>;
let a: SeededTenant;
let other: SeededTenant;
let accountId = '';

const toDays = (rows: DailyRow[]) =>
  rows.map((r) =>
    day(r.date, {
      spend: Math.round((r.values.spend ?? 0) * 100) / 100,
      impressions: r.values.impressions ?? 0,
      inlineLinkClicks: r.values.inlineLinkClicks ?? 0,
      leads: r.values.leads ?? 0,
      results: r.values.leads ?? 0,
      resultIndicator: 'actions:lead',
    }),
  );
// Campaña larga: el nivel semanal del gasto varía (log-normal) para que la curva se identifique.
const weekly = (() => {
  const rand = mulberry32(42);
  return Array.from({ length: 40 }, () => Math.exp(0.3 * normal(rand)));
})();
const long = synthetic({
  days: 260,
  seed: 9,
  spend: (t) => 300 * (weekly[Math.floor(t / 7)] as number),
  leads: { k: 0.2, b: 0.8 },
});
const short = synthetic({ days: 60, seed: 4, spend: () => 80, leads: { k: 0.2, b: 0.8 } });

const forecast = (body: Record<string, unknown>, user = a.owner, tenant = a.tenantId) =>
  t.as(user, tenant).post('/v1/forecasts', { asOf: UNTIL, ...body });
const simulate = (body: Record<string, unknown> = {}) =>
  t
    .as(a.owner, a.tenantId)
    .post('/v1/simulations', { adAccountId: accountId, asOf: UNTIL, ...body });

beforeAll(async () => {
  t = await testApp();
  a = await seedTenant(db);
  other = await seedTenant(db);
  const [acc] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .insert(s.adAccounts)
      .values({
        tenantId: a.tenantId,
        connectionId: a.connection.id,
        clientId: a.client.id,
        metaAccountId: 'act_555000111',
        name: 'Cuenta con historia',
        currency: 'USD',
        timezoneName: 'America/Tegucigalpa',
        accountStatus: 1,
      })
      .returning(),
  );
  accountId = acc?.id ?? '';
  await loadEntities(db, a.tenantId, accountId, 'act_555000111', [
    entity('campaign', '9100', { objective: 'OUTCOME_LEADS', days: toDays(long) }),
    entity('campaign', '9200', { objective: 'OUTCOME_LEADS', days: toDays(short) }),
  ]);
});

describe('pronóstico (POST /v1/forecasts)', () => {
  it('publica gasto y leads de una campaña con historia suficiente, con su ficha', async () => {
    const res = await forecast({ level: 'campaign', id: '9100', horizonDays: 28 });
    expect(res.statusCode).toBe(200);
    const f = res.json<Forecast>();
    expect(f.node).toMatchObject({ level: 'campaign', id: '9100', accountId, currency: 'USD' });
    expect(f.cut).toBe('2026-10-17'); // tres días de maduración por defecto
    const spend = f.metrics.find((m) => m.id === 'spend');
    expect(spend?.status).toBe('published');
    expect(spend?.forecast).toHaveLength(28);
    expect(spend?.forecast?.[0]?.date).toBe('2026-10-21');
    expect(spend?.history).toHaveLength(56);
    expect(spend?.backtest?.scores.map((x) => x.model)).toEqual(['snaive', 'weekday', 'ets']);
    expect(f.metrics.find((m) => m.id === 'leads')?.history.at(-1)?.immature).toBe(true);
    expect(f.assumptions.length).toBeGreaterThan(0);
    expect(f.inputHash).toMatch(/^[0-9a-f]{64}$/);
    // Mismas entradas, misma respuesta.
    const again = await forecast({ level: 'campaign', id: '9100', horizonDays: 28 });
    expect(again.json<Forecast>().inputHash).toBe(f.inputHash);
  });

  it('con poca historia no publica y dice cuántos días faltan', async () => {
    const res = await forecast({ level: 'campaign', id: '9200' });
    const spend = res.json<Forecast>().metrics.find((m) => m.id === 'spend');
    expect(spend?.status).toBe('insufficient_data');
    expect(spend?.forecast).toBeNull();
    expect(spend?.reasons[0]).toContain('Faltan');
  });

  it('excluye eventos externos y valida la fecha y el cuerpo', async () => {
    const exclude = [{ since: '2026-09-01', until: '2026-09-03', label: 'Promoción' }];
    const res = await forecast({ level: 'account', id: accountId, exclude });
    expect(res.statusCode).toBe(200);
    const f = res.json<Forecast>();
    expect(f.excluded).toEqual(exclude);
    expect(f.metrics[0]?.history.find((p) => p.date === '2026-09-02')?.value).toBeNull();
    expect(
      (await forecast({ level: 'account', id: accountId, asOf: '2099-01-01' })).statusCode,
    ).toBe(400);
    expect((await forecast({ level: 'account', id: accountId, horizonDays: 90 })).statusCode).toBe(
      400,
    );
  });

  it('respeta el aislamiento entre organizaciones y deja leer a todos los roles', async () => {
    expect(
      (await forecast({ level: 'account', id: accountId }, other.owner, other.tenantId)).statusCode,
    ).toBe(404);
    expect(
      (await forecast({ level: 'campaign', id: '9100' }, other.owner, other.tenantId)).statusCode,
    ).toBe(404);
    const viewer = await addMember(db, a.tenantId, 'viewer', [a.client.id]);
    expect((await forecast({ level: 'account', id: accountId }, viewer)).statusCode).toBe(200);
  });
});

describe('simulación (POST /v1/simulations)', () => {
  it('simula con la curva validada y compara con mantener el gasto', async () => {
    const base = await simulate();
    expect(base.statusCode).toBe(200);
    const sim = base.json<Simulation>();
    const c1 = sim.campaigns.find((c) => c.id === '9100');
    expect(c1?.kpi.field).toBe('leads');
    expect(c1?.curve?.weeks).toBe(26);
    expect(c1?.status).toBe('published');
    expect(c1?.outcome?.expectedChange.p50).toBe(0);
    const c2 = sim.campaigns.find((c) => c.id === '9200');
    expect(c2?.status).toBe('insufficient_data');
    expect(c2?.outcome).toBeNull();

    const more = (
      await simulate({
        changes: [{ campaignId: '9100', dailySpend: (c1?.currentDailySpend ?? 0) * 1.3 }],
      })
    ).json<Simulation>();
    const m1 = more.campaigns.find((c) => c.id === '9100');
    expect(m1?.outcome?.expectedChange.p50).toBeGreaterThan(0);
    expect(m1?.outcome?.extrapolation).toBe(false);
    expect(more.spend.planned).toBeGreaterThan(sim.spend.planned);
    expect(more.totals[0]?.field).toBe('leads');
  });

  it('es reproducible con la semilla y rechaza campañas de otra cuenta', async () => {
    const a1 = (await simulate({ seed: 7 })).json<Simulation>();
    const a2 = (await simulate({ seed: 7 })).json<Simulation>();
    expect(a2.campaigns).toEqual(a1.campaigns);
    expect((await simulate({ changes: [{ campaignId: '123', dailySpend: 10 }] })).statusCode).toBe(
      400,
    );
    const res = await t
      .as(other.owner, other.tenantId)
      .post('/v1/simulations', { adAccountId: accountId, asOf: UNTIL });
    expect(res.statusCode).toBe(404);
  });
});

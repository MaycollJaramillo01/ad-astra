import { and, eq, gte } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Experiment, ExperimentPreview, Forecast, Simulation } from '../src/contracts.ts';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import type { DailyRow } from '../src/modules/forecasting/forecast.ts';
import {
  designExperiment,
  mulberry32,
  normal,
  poissonSample,
} from '../src/modules/forecasting/simulate.ts';
import { addDays, localDate } from '../src/modules/insights/catalog.ts';
import { testApp } from './app.ts';
import { day, entity } from './audit-fixtures.ts';
import { synthetic, UNTIL } from './forecast-fixtures.ts';
import { addMember, loadEntities, type SeededTenant, seedTenant, testDb } from './seed.ts';

// Pronóstico, simulación y experimentos de punta a punta: datos sintéticos en Postgres → API →
// estados de publicación, intervalos, escenarios y análisis causal, con RLS y el alcance por cliente.
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

// Campaña con un experimento terminado: fuera de él, el anunciante sube el gasto cuando la demanda
// es alta (confusión); durante él, el gasto sigue los niveles asignados al azar. Elasticidad real 0,6.
const schedule = designExperiment({
  start: '2026-08-10',
  levels: [0.6, 1, 1.6],
  blocks: 3,
  seed: 11,
});
const experimental: DailyRow[] = (() => {
  const rand = mulberry32(99);
  const demand = Array.from({ length: 31 }, () => Math.exp(0.2 * normal(rand)));
  return Array.from({ length: 210 }, (_, i) => {
    const date = addDays(UNTIL, i - 209);
    const d = demand[Math.floor(i / 7)] as number;
    const m = schedule.find((p) => date >= p.since && date <= p.until)?.multiplier;
    const spend = 300 * (m ?? d ** 1.5) * Math.exp(0.05 * normal(rand));
    return {
      date,
      attribution: '7d_click_1d_view',
      values: {
        spend,
        impressions: Math.round(spend * 100),
        inlineLinkClicks: Math.round(spend),
        leads: poissonSample(0.4 * spend ** 0.6 * d, rand),
      },
    };
  });
})();

const forecast = (body: Record<string, unknown>, user = a.owner, tenant = a.tenantId) =>
  t.as(user, tenant).post('/v1/forecasts', { asOf: UNTIL, ...body });
const simulate = (body: Record<string, unknown> = {}) =>
  t
    .as(a.owner, a.tenantId)
    .post('/v1/simulations', { adAccountId: accountId, asOf: UNTIL, ...body });
const nextWeek = () => addDays(localDate('America/Tegucigalpa'), 7);

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
    entity('campaign', '9300', { objective: 'OUTCOME_LEADS', days: toDays(experimental) }),
  ]);
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.insert(s.budgetExperiments).values({
      tenantId: a.tenantId,
      adAccountId: accountId,
      campaignMetaId: '9300',
      kpiField: 'leads',
      startDate: '2026-08-10',
      burnInDays: 2,
      baseDailySpend: '300',
      levels: [0.6, 1, 1.6],
      schedule,
      seed: 11,
      observed: { mean: 0.9, sd: 0.1 },
      createdBy: a.owner.id,
    }),
  );
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
    // Calendario incorporado: la quincena cae en el horizonte y tiene efecto estimado con historia.
    expect(f.calendar.some((e) => e.key === 'quincena')).toBe(true);
    expect(spend?.forecast?.some((p) => p.event === 'Días de pago (quincena)')).toBe(true);
    expect(spend?.events.find((e) => e.key === 'quincena')?.source).toBe('history');
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

  it('acepta eventos propios (incidencias excluidas, promociones modeladas) y valida el cuerpo', async () => {
    const events = [
      {
        since: '2026-09-01',
        until: '2026-09-03',
        label: 'Caída del píxel',
        category: 'incident',
        yearly: false,
      },
      {
        since: '2026-11-05',
        until: '2026-11-06',
        label: 'Promo aniversario',
        category: 'promotion',
        yearly: false,
      },
    ];
    const res = await forecast({ level: 'account', id: accountId, events });
    expect(res.statusCode).toBe(200);
    const f = res.json<Forecast>();
    expect(f.events).toEqual(events);
    expect(f.metrics[0]?.history.find((p) => p.date === '2026-09-02')?.value).toBeNull();
    expect(f.calendar.find((e) => e.label === 'Promo aniversario')?.source).toBe('user');
    const off = await forecast({ level: 'account', id: accountId, builtinCalendar: false });
    expect(off.json<Forecast>().calendar).toEqual([]);
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
  it('simula con la curva validada, la confusión y el rango validado', async () => {
    const base = await simulate();
    expect(base.statusCode).toBe(200);
    const sim = base.json<Simulation>();
    const c1 = sim.campaigns.find((c) => c.id === '9100');
    expect(c1?.kpi.field).toBe('leads');
    expect(c1?.curve?.weeks).toBe(26);
    expect(c1?.status).toBe('published');
    expect(c1?.outcome?.expectedChange.p50).toBe(0);
    expect(c1?.curve?.causal.source).toBe('observational');
    expect(c1?.curve?.spillover).not.toBeNull(); // hay otras campañas de leads en la cuenta
    expect(c1?.validation?.extremes.evaluated).toBeGreaterThan(0);
    expect(c1?.validatedRange?.maxDaily).toBeGreaterThan(c1?.currentDailySpend ?? 0);
    expect(sim.confounding.sd).toBeGreaterThan(0);
    const c2 = sim.campaigns.find((c) => c.id === '9200');
    expect(c2?.status).toBe('insufficient_data');
    expect(c2?.outcome).toBeNull();

    const more = (
      await simulate({
        changes: [{ campaignId: '9100', dailySpend: (c1?.currentDailySpend ?? 0) * 1.2 }],
      })
    ).json<Simulation>();
    const m1 = more.campaigns.find((c) => c.id === '9100');
    expect(m1?.outcome?.expectedChange.p50).toBeGreaterThan(0);
    expect(more.spend.planned).toBeGreaterThan(sim.spend.planned);
    expect(more.totals[0]?.field).toBe('leads');

    // Muy lejos de lo observado no se publica: fuera del rango validado.
    const far = (
      await simulate({
        changes: [{ campaignId: '9100', dailySpend: (c1?.currentDailySpend ?? 0) * 10 }],
      })
    ).json<Simulation>();
    const f1 = far.campaigns.find((c) => c.id === '9100');
    expect(f1?.status).toBe('not_published');
    expect(f1?.reasons.join(' ')).toContain('fuera del rango validado');
  });

  it('usa la elasticidad causal del experimento terminado', async () => {
    const sim = (await simulate()).json<Simulation>();
    const c3 = sim.campaigns.find((c) => c.id === '9300');
    expect(c3?.experiment?.result.complete).toBe(true);
    const e = c3?.experiment?.result.elasticity;
    expect(e).not.toBeNull();
    expect(Math.abs((e?.point ?? 0) - 0.6)).toBeLessThan(3 * (e?.se ?? 0) + 0.05);
    expect(c3?.curve?.causal.source).toBe('experiment');
    expect(c3?.curve?.causal.point).toBeCloseTo(e?.point ?? 0, 10);
    // La elasticidad observada (con confusión: la demanda sube gasto y leads) queda por encima.
    expect(c3?.curve?.elasticity.point).toBeGreaterThan(e?.point ?? 0);
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

describe('experimentos de presupuesto (/v1/budget-experiments)', () => {
  const body = () => ({
    adAccountId: accountId,
    campaignId: '9100',
    startDate: nextWeek(),
    seed: 5,
  });

  it('previsualiza el diseño aleatorizado con su potencia', async () => {
    const res = await t.as(a.owner, a.tenantId).post('/v1/budget-experiments/preview', body());
    expect(res.statusCode).toBe(200);
    const p = res.json<ExperimentPreview>();
    expect(p.schedule).toHaveLength(9);
    expect(new Set(p.schedule.slice(0, 3).map((x) => x.multiplier))).toEqual(
      new Set([0.8, 1, 1.25]),
    );
    expect(p.power?.se).toBeGreaterThan(0);
    expect(p.observed).not.toBeNull();
    const past = await t
      .as(a.owner, a.tenantId)
      .post('/v1/budget-experiments/preview', { ...body(), startDate: '2026-01-05' });
    expect(past.statusCode).toBe(400);
  });

  it('crea, lista y cancela con permisos, sin solapes y con registro', async () => {
    const analyst = await addMember(db, a.tenantId, 'analyst', [a.client.id]);
    expect(
      (await t.as(analyst, a.tenantId).post('/v1/budget-experiments', body())).statusCode,
    ).toBe(403);
    const created = await t.as(a.owner, a.tenantId).post('/v1/budget-experiments', body());
    expect(created.statusCode).toBe(200);
    const e = created.json<Experiment>();
    expect(e.status).toBe('planned');
    expect(e.schedule).toHaveLength(9);
    expect(
      (await t.as(a.owner, a.tenantId).post('/v1/budget-experiments', body())).statusCode,
    ).toBe(409);
    const list = (
      await t.as(analyst, a.tenantId).get(`/v1/budget-experiments?adAccountId=${accountId}`)
    ).json<Experiment[]>();
    expect(list.map((x) => x.id)).toContain(e.id);
    expect(list.find((x) => x.campaignId === '9300')?.status).toBe('complete');
    const cancelled = await t
      .as(a.owner, a.tenantId)
      .post(`/v1/budget-experiments/${e.id}/cancel`, {});
    expect(cancelled.json<Experiment>().status).toBe('cancelled');
    expect(
      (await t.as(a.owner, a.tenantId).post(`/v1/budget-experiments/${e.id}/cancel`, {}))
        .statusCode,
    ).toBe(409);
    const log = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(s.auditLog),
    );
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(['budget_experiment.created', 'budget_experiment.cancelled']),
    );
    expect(
      (
        await t
          .as(other.owner, other.tenantId)
          .get(`/v1/budget-experiments?adAccountId=${accountId}`)
      ).statusCode,
    ).toBe(404);
  });
});

it('mantiene métricas desconocidas como nulas y no las convierte en ceros', async () => {
  const [account] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .insert(s.adAccounts)
      .values({
        tenantId: a.tenantId,
        connectionId: a.connection.id,
        clientId: a.client.id,
        metaAccountId: 'act_555000222',
        name: 'Métricas desconocidas',
        currency: 'USD',
        timezoneName: 'America/Tegucigalpa',
        accountStatus: 1,
      })
      .returning(),
  );
  const unknownAccountId = account!.id;
  await loadEntities(db, a.tenantId, unknownAccountId, 'act_555000222', [
    entity('campaign', '9400', { objective: 'OUTCOME_LEADS', days: toDays(long) }),
  ]);
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .update(s.insightsDaily)
      .set({ leads: null })
      .where(
        and(
          eq(s.insightsDaily.adAccountId, unknownAccountId),
          eq(s.insightsDaily.entityMetaId, '9400'),
          gte(s.insightsDaily.date, addDays(UNTIL, -45)),
        ),
      ),
  );
  const res = await forecast({ level: 'campaign', id: '9400', builtinCalendar: false });
  expect(res.statusCode).toBe(200);
  const leads = res.json<Forecast>().metrics.find((m) => m.id === 'leads');
  expect(leads?.status).toBe('insufficient_data');
  expect(leads?.history.at(-1)?.value).toBeNull();
  expect(leads?.reasons.join(' ')).toContain('Pocos días normales');
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .update(s.insightsDaily)
      .set({ spend: null })
      .where(
        and(
          eq(s.insightsDaily.adAccountId, unknownAccountId),
          eq(s.insightsDaily.entityMetaId, '9400'),
          eq(s.insightsDaily.date, UNTIL),
        ),
      ),
  );
  const sim = await simulate({ adAccountId: unknownAccountId });
  expect(sim.statusCode).toBe(400);
  expect(sim.body).toContain('Gasto desconocido');
});

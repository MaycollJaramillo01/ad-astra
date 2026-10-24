import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuditEntity } from '../src/contracts.ts';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { ENGINE_VERSION } from '../src/modules/audit/engine.ts';
import type { Component } from '../src/modules/audit/health.ts';
import { combine } from '../src/modules/audit/health.ts';
import type { EntityInput } from '../src/modules/audit/model.ts';
import { testApp } from './app.ts';
import { AS_OF, inEvaluation, leadsDay, series, stack, sumDays } from './audit-fixtures.ts';
import { addMember, type SeededTenant, seedTenant, testDb } from './seed.ts';

// Motor de auditoría de punta a punta: datos sintéticos en Postgres → ejecución por la API →
// hallazgos con su ciclo de vida, historial y salud diaria, con RLS y alcance por cliente.
const db = testDb();
let t: Awaited<ReturnType<typeof testApp>>;
let a: SeededTenant;
let accountId = '';

const leads = (id: string, base: [number, number], now: [number, number]) =>
  stack(
    id,
    series(35, (back) =>
      inEvaluation(back) ? leadsDay(now[0], now[1]) : leadsDay(base[0], base[1]),
    ),
  );

/** Inserta entidades y sus días como si los hubiera traído la sincronización. */
async function load(
  tenantId: string,
  adAccountId: string,
  metaAccountId: string,
  entities: EntityInput[],
  replace = false,
) {
  await withContext(db, { tenantId }, async (tx) => {
    if (replace)
      await tx.delete(s.insightsDaily).where(eq(s.insightsDaily.adAccountId, adAccountId));
    const [run] = await tx
      .insert(s.syncRuns)
      .values({ tenantId, adAccountId, kind: 'insights_backfill', apiVersion: 'v26.0' })
      .returning();
    const now = new Date();
    if (!replace) {
      for (const e of entities) {
        const common = {
          tenantId,
          metaId: e.id,
          adAccountId,
          name: e.name,
          effectiveStatus: e.status,
          raw: {},
          lastSyncedAt: now,
        };
        if (e.level === 'campaign')
          await tx.insert(s.campaigns).values({ ...common, objective: e.objective });
        if (e.level === 'adset')
          await tx.insert(s.adsets).values({
            ...common,
            campaignMetaId: e.campaignId ?? '',
            optimizationGoal: e.optimizationGoal,
          });
        if (e.level === 'ad')
          await tx.insert(s.ads).values({
            ...common,
            adsetMetaId: e.parentId ?? '',
            campaignMetaId: e.campaignId ?? '',
          });
      }
    }
    const rows = [
      ...entities.map((e) => ({ e, level: e.level, id: e.id, days: e.days })),
      {
        e: null,
        level: 'account' as const,
        id: metaAccountId,
        days: sumDays(entities.filter((x) => x.level === 'campaign').flatMap((x) => x.days)),
      },
    ].flatMap(({ e, level, id, days }) =>
      days.map((d) => ({
        tenantId,
        adAccountId,
        level,
        entityMetaId: id,
        campaignMetaId: e?.campaignId ?? null,
        adsetMetaId: e?.level === 'ad' ? e.parentId : e?.level === 'adset' ? e.id : null,
        date: d.date,
        currency: 'USD',
        attributionSetting: d.attribution,
        spend: String(d.spend),
        impressions: d.impressions,
        reach: d.reach,
        clicks: d.clicks,
        inlineLinkClicks: d.inlineLinkClicks,
        results: level === 'account' ? null : String(d.results),
        resultIndicator: level === 'account' ? null : d.resultIndicator,
        leads: String(d.leads),
        extractionVersion: 1,
        syncRunId: run!.id,
        fetchedAt: now,
      })),
    );
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(s.insightsDaily).values(rows.slice(i, i + 500));
  });
}

const entitiesV1 = () => [
  ...leads('1', [100, 10], [100, 3]),
  ...leads('2', [100, 10], [100, 10]),
  ...leads('3', [100, 10], [100, 0]),
];
const audit = (asOf = AS_OF) => t.as(a.owner).post(`/v1/ad-accounts/${accountId}/audit`, { asOf });
const openFindings = () =>
  withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .select()
      .from(s.findings)
      .where(and(eq(s.findings.adAccountId, accountId), eq(s.findings.status, 'open'))),
  );
const eventsOf = (findingId: string) =>
  withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.select().from(s.findingEvents).where(eq(s.findingEvents.findingId, findingId)),
  );

beforeAll(async () => {
  t = await testApp();
  a = await seedTenant(db);
  const [acc] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .insert(s.adAccounts)
      .values({
        tenantId: a.tenantId,
        connectionId: a.connection.id,
        clientId: a.client.id,
        metaAccountId: 'act_777000111',
        name: 'Cuenta auditada',
        currency: 'USD',
        timezoneName: 'America/Tegucigalpa',
        accountStatus: 1,
        syncEnabled: true,
      })
      .returning(),
  );
  accountId = acc!.id;
  await load(a.tenantId, accountId, 'act_777000111', entitiesV1());
});

describe('ejecución y persistencia', () => {
  it('guarda la ejecución, los hallazgos con su evidencia y la salud diaria', async () => {
    const res = await audit();
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json();
    expect(run).toMatchObject({
      asOf: AS_OF,
      engineVersion: ENGINE_VERSION,
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(run.stats.opened).toBeGreaterThan(0);

    const open = await openFindings();
    const eff = open.find((f) => f.fingerprint === 'R-EFF-001:campaign:10');
    expect(eff).toMatchObject({
      category: 'efficiency',
      profile: 'leads',
      engineVersion: ENGINE_VERSION,
      ruleVersion: 1,
      windowStart: '2026-10-14',
      windowEnd: '2026-10-17',
      clearRuns: 0,
    });
    expect(eff?.explanation).toMatch(/costo por cliente potencial/);
    expect(eff?.evidence).toMatchObject({
      reference: { source: 'baseline' },
      metrics: { events: 12, spend: 400 },
      method: expect.any(String),
    });
    expect(Number(eff?.confidence)).toBeGreaterThan(0.8);
    expect(open.find((f) => f.fingerprint === 'R-TRK-013:campaign:30')?.severity).toBe('high'); // ~1/3 del gasto
    expect(open.some((f) => f.entityMetaId === '20')).toBe(false); // la campaña sana no tiene hallazgos

    expect((await eventsOf(eff!.id)).map((e) => e.event)).toEqual(['opened']);

    const health = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx
        .select()
        .from(s.healthScores)
        .where(and(eq(s.healthScores.adAccountId, accountId), eq(s.healthScores.date, AS_OF))),
    );
    expect(health.length).toBe(10); // 9 entidades + la cuenta
    // La puntuación guardada se reproduce desde sus componentes (CA-F3-03).
    for (const h of health.filter((x) => x.entityLevel !== 'account')) {
      const recomputed = combine(h.components as Component[], 0.6).score;
      expect(
        recomputed === null ? null : recomputed.toFixed(2),
        `${h.entityLevel}:${h.entityMetaId}`,
      ).toBe(h.score);
    }
    const score = (id: string) =>
      Number(health.find((h) => h.entityLevel === 'campaign' && h.entityMetaId === id)?.score);
    expect(score('20')).toBeGreaterThan(score('10'));
  });

  it('repetir con los mismos datos da la misma huella y no duplica hallazgos ni eventos', async () => {
    const before = await openFindings();
    const first = (await audit()).json();
    const second = (await audit()).json();
    expect(second.inputHash).toBe(first.inputHash);
    expect(second.stats.opened).toBe(0);
    const after = await openFindings();
    expect(after.map((f) => f.fingerprint).sort()).toEqual(before.map((f) => f.fingerprint).sort());
    const eff = after.find((f) => f.fingerprint === 'R-EFF-001:campaign:10');
    expect((await eventsOf(eff!.id)).map((e) => e.event)).toEqual(['opened']);
  });

  it('un hallazgo descartado no se reabre; uno que deja de cumplirse se resuelve tras 2 evaluaciones (CA-F3-04)', async () => {
    const open = await openFindings();
    const tracking = open.find((f) => f.fingerprint === 'R-TRK-013:campaign:30');
    const decided = await t.as(a.owner).post(`/v1/findings/${tracking!.id}/decision`, {
      status: 'dismissed',
      reason: 'Formulario cambiado a propósito',
    });
    expect(decided.statusCode).toBe(200);
    expect((await audit()).json().stats.keptDismissed).toBeGreaterThan(0);
    expect((await openFindings()).some((f) => f.fingerprint === 'R-TRK-013:campaign:30')).toBe(
      false,
    );
    expect((await eventsOf(tracking!.id)).map((e) => e.event)).toEqual(['opened', 'decided']);

    // Los datos se normalizan: todas las campañas a su costo habitual.
    await load(
      a.tenantId,
      accountId,
      'act_777000111',
      [
        ...leads('1', [100, 10], [100, 10]),
        ...leads('2', [100, 10], [100, 10]),
        ...leads('3', [100, 10], [100, 10]),
      ],
      true,
    );
    const eff = open.find((f) => f.fingerprint === 'R-EFF-001:campaign:10');
    expect((await audit()).json().stats.resolved).toBe(0); // primera evaluación limpia
    const [stillOpen] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(s.findings).where(eq(s.findings.id, eff!.id)),
    );
    expect(stillOpen).toMatchObject({ status: 'open', clearRuns: 1 });
    expect((await audit()).json().stats.resolved).toBeGreaterThan(0);
    const [resolved] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(s.findings).where(eq(s.findings.id, eff!.id)),
    );
    expect(resolved?.status).toBe('resolved');
    expect((await eventsOf(eff!.id)).map((e) => e.event)).toEqual(['opened', 'resolved']);

    // Si la condición vuelve, se abre de nuevo y queda como reapertura.
    await load(a.tenantId, accountId, 'act_777000111', entitiesV1(), true);
    await audit();
    const reopened = (await openFindings()).find((f) => f.fingerprint === 'R-EFF-001:campaign:10');
    expect(reopened?.id).not.toBe(eff!.id);
    expect(
      (await eventsOf(reopened!.id)).map((e) => [
        e.event,
        (e.data as { previous?: string } | null)?.previous,
      ]),
    ).toEqual([['reopened', eff!.id]]);
  });
});

describe('API de consulta', () => {
  it('salud, historial e hallazgos de la rama de una campaña, y la salud de sus hijos', async () => {
    const res = await t.as(a.owner).get('/v1/audit/entity?level=campaign&id=10');
    expect(res.statusCode, res.body).toBe(200);
    const body: AuditEntity = res.json();
    expect(body.health).toMatchObject({
      level: 'campaign',
      entityId: '10',
      date: AS_OF,
      formulaVersion: 'health-v1',
      profile: 'leads',
    });
    expect(body.health?.components.map((c) => c.id)).toEqual([
      'efficiency',
      'stability',
      'delivery',
      'measurement',
      'fatigue',
    ]);
    expect(body.history.at(-1)?.date).toBe(AS_OF);
    expect(new Set(body.findings.map((f) => f.entityMetaId))).toEqual(
      new Set(['10', '11', '12'].filter((id) => body.findings.some((f) => f.entityMetaId === id))),
    );
    expect(body.findings.every((f) => ['10', '11', '12'].includes(f.entityMetaId))).toBe(true);
    expect(body.findings.find((f) => f.entityMetaId === '10')?.entityName).toBe('campaign 10');
    expect(Object.keys(body.childrenHealth)).toEqual(['11']);

    const account = (
      await t.as(a.owner).get(`/v1/audit/entity?level=account&id=${accountId}`)
    ).json() as AuditEntity;
    expect(account.health?.level).toBe('account');
    expect(Object.keys(account.childrenHealth).sort()).toEqual(['10', '20', '30']);
  });

  it('el catálogo publica cada regla con su método, muestra mínima y esquema de parámetros', async () => {
    const res = await t.as(a.owner).get('/v1/audit/catalog');
    expect(res.statusCode).toBe(200);
    const catalog = res.json();
    expect(catalog.engineVersion).toBe(ENGINE_VERSION);
    expect(catalog.rules).toHaveLength(15);
    const eff = catalog.rules.find((r: { id: string }) => r.id === 'R-EFF-001');
    expect(eff.defaults).toMatchObject({ tolerance: 0.2, minProbability: 0.8 });
    expect(eff.paramsSchema.properties.tolerance).toMatchObject({ type: 'number', minimum: 0 });
    expect(catalog.defaults.health).toMatchObject({ center: 80, slope: 40, minCoverage: 0.6 });
  });

  it('respeta el alcance por cliente y la organización', async () => {
    const outsider = await addMember(db, a.tenantId, 'analyst'); // sin clientes asignados
    expect(
      (await t.as(outsider).get(`/v1/audit/entity?level=account&id=${accountId}`)).statusCode,
    ).toBe(404);
    expect((await t.as(outsider).get('/v1/audit/entity?level=campaign&id=10')).statusCode).toBe(
      404,
    );
    expect((await t.as(outsider).post(`/v1/ad-accounts/${accountId}/audit`, {})).statusCode).toBe(
      404,
    );
    const other = await seedTenant(db);
    expect((await t.as(other.owner).get('/v1/audit/entity?level=campaign&id=10')).statusCode).toBe(
      404,
    );
  });
});

describe('configuración', () => {
  it('valida el parche, aplica el objetivo del cliente y queda auditada', async () => {
    const api = t.as(a.owner);
    const bad = await api.put('/v1/audit/config', {
      clientId: a.client.id,
      patch: { rules: { 'R-EFF-001': { params: { tolerance: -1 } } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await api.put('/v1/audit/config', { patch: { rules: { 'R-NOPE': { enabled: false } } } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api.put('/v1/audit/config', { patch: { windows: { evaluationDays: 1 } } })).statusCode,
    ).toBe(400);

    const ok = await api.put('/v1/audit/config', {
      clientId: a.client.id,
      patch: { targets: [{ profile: 'leads', currency: 'USD', costPerEvent: 8 }] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().effective.targets).toEqual([
      { profile: 'leads', currency: 'USD', costPerEvent: 8 },
    ]);
    await audit();
    const eff = (await openFindings()).find((f) => f.fingerprint === 'R-EFF-001:campaign:10');
    expect(eff?.evidence).toMatchObject({ reference: { value: 8, source: 'target' } });
    const [event] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'audit_config.updated')),
    );
    expect(event).toMatchObject({ targetType: 'client', targetId: a.client.id });
  });

  it('solo owner y admin cambian la organización; un analista no configura', async () => {
    const manager = await addMember(db, a.tenantId, 'manager', [a.client.id]);
    const analyst = await addMember(db, a.tenantId, 'analyst', [a.client.id]);
    expect(
      (await t.as(manager).put('/v1/audit/config', { patch: { fdrQ: 0.05 } })).statusCode,
    ).toBe(403);
    expect(
      (
        await t
          .as(manager)
          .put('/v1/audit/config', { clientId: a.client.id, patch: { fdrQ: 0.05 } })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await t
          .as(analyst)
          .put('/v1/audit/config', { clientId: a.client.id, patch: { fdrQ: 0.05 } })
      ).statusCode,
    ).toBe(403);
    expect(
      (await t.as(a.owner).put('/v1/audit/config', { patch: { fdrQ: 0.05 } })).statusCode,
    ).toBe(200);
    expect(
      (await t.as(analyst).get(`/v1/audit/config?clientId=${a.client.id}`)).json().effective.fdrQ,
    ).toBe(0.05);
  });
});

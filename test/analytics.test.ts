import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsReport } from '../src/contracts.ts';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { compute } from '../src/modules/insights/catalog.ts';
import { csvCell } from '../src/modules/insights/routes.ts';
import { testApp } from './app.ts';
import { addMember, type SeededTenant, seedTenant, testDb } from './seed.ts';

// Analítica (F2) contra Postgres real con RLS: totales, comparación, serie, desglose por nivel,
// monedas, alcance por cliente, aislamiento y exportación.
const db = testDb();
let t: Awaited<ReturnType<typeof testApp>>;
let a: SeededTenant;
let other: SeededTenant;
const ids = { acc1: '', acc2: '', acc3: '', clientB: '' };

const CUR = { since: '2026-09-01', until: '2026-09-07' };
const MESSAGES = 'actions:onsite_conversion.messaging_conversation_started_7d';
const LEADS = 'actions:lead';
const id = () => String(Math.floor(Math.random() * 1e12));
// Ids de Meta únicos por ejecución (la clave es tenant + id, pero así cada test es independiente).
const m = {
  c1: id(),
  c2: id(),
  s1: id(),
  s2: id(),
  a1: id(),
  a2: id(),
  a3: id(),
  a4: id(),
  orphan: id(),
  c3: id(),
};

type Row = Partial<typeof s.insightsDaily.$inferInsert> & { spend?: string };

/** Días del 25 de agosto al 7 de septiembre: la semana anterior y la del informe. */
const days = Array.from({ length: 14 }, (_, i) =>
  new Date(Date.UTC(2026, 7, 25 + i)).toISOString().slice(0, 10),
);
const isCurrent = (d: string) => d >= CUR.since;

async function seedAnalytics() {
  a = await seedTenant(db);
  other = await seedTenant(db);
  const tenantId = a.tenantId;
  await withContext(db, { tenantId }, async (tx) => {
    const [clientB] = await tx
      .insert(s.clients)
      .values({ tenantId, name: `Cliente B ${id()}` })
      .returning();
    ids.clientB = clientB!.id;
    const account = (name: string, currency: string, tz: string, clientId: string) =>
      tx
        .insert(s.adAccounts)
        .values({
          tenantId,
          connectionId: a.connection.id,
          clientId,
          metaAccountId: `act_${id()}`,
          name,
          currency,
          timezoneName: tz,
          accountStatus: 1,
          syncEnabled: true,
          lastInsightsSyncAt: new Date(Date.now() - 30 * 60_000),
        })
        .returning();
    const [acc1] = await account('Cuenta HNL A', 'HNL', 'America/Tegucigalpa', a.client.id);
    const [acc2] = await account('Cuenta HNL B', 'HNL', 'America/Tegucigalpa', clientB!.id);
    const [acc3] = await account('Cuenta USD B', 'USD', 'America/New_York', clientB!.id);
    ids.acc1 = acc1!.id;
    ids.acc2 = acc2!.id;
    ids.acc3 = acc3!.id;

    const now = new Date();
    const entity = { tenantId, adAccountId: acc1!.id, raw: {}, lastSyncedAt: now };
    await tx.insert(s.campaigns).values([
      {
        ...entity,
        metaId: m.c1,
        name: 'Mensajes',
        objective: 'OUTCOME_ENGAGEMENT',
        effectiveStatus: 'ACTIVE',
      },
      {
        ...entity,
        metaId: m.c2,
        name: '=SUM(A1)',
        objective: 'OUTCOME_LEADS',
        effectiveStatus: 'PAUSED',
      },
      { ...entity, adAccountId: acc2!.id, metaId: m.c3, name: 'Otra', effectiveStatus: 'ACTIVE' },
    ]);
    await tx.insert(s.adsets).values([
      {
        ...entity,
        metaId: m.s1,
        campaignMetaId: m.c1,
        name: 'Conjunto 1',
        effectiveStatus: 'ACTIVE',
        learningStageInfo: { status: 'LEARNING' },
      },
      {
        ...entity,
        metaId: m.s2,
        campaignMetaId: m.c2,
        name: 'Conjunto 2',
        effectiveStatus: 'CAMPAIGN_PAUSED',
      },
    ]);
    await tx.insert(s.ads).values([
      {
        ...entity,
        metaId: m.a1,
        adsetMetaId: m.s1,
        campaignMetaId: m.c1,
        name: 'Anuncio 1',
        effectiveStatus: 'ACTIVE',
      },
      {
        ...entity,
        metaId: m.a2,
        adsetMetaId: m.s1,
        campaignMetaId: m.c1,
        name: 'Anuncio 2',
        effectiveStatus: 'ACTIVE',
      },
      {
        ...entity,
        metaId: m.a3,
        adsetMetaId: m.s2,
        campaignMetaId: m.c2,
        name: 'Anuncio 3',
        effectiveStatus: 'DISAPPROVED',
      },
      {
        ...entity,
        metaId: m.a4,
        adsetMetaId: m.s2,
        campaignMetaId: m.c2,
        name: 'Anuncio sin entrega',
        effectiveStatus: 'ACTIVE',
      },
    ]);
    const [run] = await tx
      .insert(s.syncRuns)
      .values({ tenantId, adAccountId: acc1!.id, kind: 'insights_backfill', apiVersion: 'v26.0' })
      .returning();

    // Anuncios por día; los niveles superiores son sus sumas, como en Meta.
    const rows: Array<typeof s.insightsDaily.$inferInsert> = [];
    const put = (
      accId: string,
      level: s.Level,
      entityMetaId: string,
      date: string,
      v: Record<string, number | null>,
      extra: Row = {},
    ) =>
      rows.push({
        tenantId,
        adAccountId: accId,
        level,
        entityMetaId,
        date,
        currency: accId === acc3!.id ? 'USD' : 'HNL',
        attributionSetting: accId === acc1!.id ? '1d_view_7d_click' : '7d_click',
        spend: String(v.spend),
        impressions: v.impressions,
        clicks: v.clicks,
        inlineLinkClicks: v.link,
        reach: v.reach ?? null,
        results: v.results === null || v.results === undefined ? null : String(v.results),
        resultIndicator:
          v.results === null || v.results === undefined ? null : (extra.resultIndicator ?? null),
        messagingConversations: String(v.messages ?? 0),
        leads: String(v.leads ?? 0),
        extractionVersion: 1,
        syncRunId: run!.id,
        fetchedAt: now,
        ...extra,
      });
    for (const date of days) {
      const f = isCurrent(date) ? 2 : 1;
      const ad1 = {
        spend: 10 * f,
        impressions: 1000,
        clicks: 20,
        link: 10,
        results: 2,
        messages: 2,
      };
      const ad2 = { spend: 5, impressions: 500, clicks: 8, link: 5, results: 1, messages: 1 };
      const orphan = { spend: 1, impressions: 100, clicks: 1, link: 0, results: null };
      const ad3 = { spend: 4, impressions: 400, clicks: 5, link: 2, results: 1, leads: 1 };
      const p1 = { campaignMetaId: m.c1, adsetMetaId: m.s1 };
      const p2 = { campaignMetaId: m.c2, adsetMetaId: m.s2 };
      put(acc1!.id, 'ad', m.a1, date, ad1, { ...p1, resultIndicator: MESSAGES });
      put(acc1!.id, 'ad', m.a2, date, ad2, { ...p1, resultIndicator: MESSAGES });
      put(acc1!.id, 'ad', m.orphan, date, orphan, p1);
      put(acc1!.id, 'ad', m.a3, date, ad3, { ...p2, resultIndicator: LEADS });
      if (isCurrent(date))
        put(
          acc1!.id,
          'ad',
          m.a4,
          date,
          { spend: 0, impressions: 0, clicks: 0, link: 0, results: null },
          p2,
        );
      const s1 = {
        spend: ad1.spend + 6,
        impressions: 1600,
        clicks: 29,
        link: 15,
        results: 3,
        messages: 3,
      };
      put(acc1!.id, 'adset', m.s1, date, s1, { ...p1, resultIndicator: MESSAGES });
      put(acc1!.id, 'adset', m.s2, date, ad3, { ...p2, resultIndicator: LEADS });
      put(acc1!.id, 'campaign', m.c1, date, s1, {
        campaignMetaId: m.c1,
        resultIndicator: MESSAGES,
      });
      put(acc1!.id, 'campaign', m.c2, date, ad3, { campaignMetaId: m.c2, resultIndicator: LEADS });
      // Nivel de cuenta: sin `results` (Meta no lo da con objetivos mezclados) y con alcance diario.
      put(acc1!.id, 'account', acc1!.metaAccountId, date, {
        spend: s1.spend + 4,
        impressions: 2000,
        clicks: 34,
        link: 17,
        reach: 1500,
        results: null,
        messages: 3,
        leads: 1,
      });
      put(acc2!.id, 'account', acc2!.metaAccountId, date, {
        spend: 7,
        impressions: 700,
        clicks: 7,
        link: 7,
        results: null,
        leads: 1,
      });
      put(
        acc2!.id,
        'campaign',
        m.c3,
        date,
        { spend: 7, impressions: 700, clicks: 7, link: 7, results: 1, leads: 1 },
        { campaignMetaId: m.c3, resultIndicator: LEADS },
      );
      put(acc3!.id, 'account', acc3!.metaAccountId, date, {
        spend: 100,
        impressions: 5000,
        clicks: 50,
        link: 40,
        results: null,
      });
    }
    await tx.insert(s.insightsDaily).values(rows);
  });
}

beforeAll(async () => {
  t = await testApp();
  await seedAnalytics();
});

const query = (level: string, entityId?: string, extra = '') =>
  `/v1/analytics?level=${level}${entityId ? `&id=${entityId}` : ''}&since=${CUR.since}&until=${CUR.until}${extra}`;
const report = async (url: string, user = a.owner): Promise<AnalyticsReport> => {
  const res = await t.as(user).get(url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const ctx = (r: AnalyticsReport) => ({
  days: r.range.days,
  reachSources: r.totals.sources,
  resultTypes: r.totals.resultTypes.length,
  immature: false,
});

describe('vista de cuenta', () => {
  it('totales con comparación, serie diaria, desglose de resultados y campañas', async () => {
    const r = await report(query('account', ids.acc1));
    expect(r.range).toMatchObject({ ...CUR, days: 7 });
    expect(r.compare).toEqual({ mode: 'previous', since: '2026-08-25', until: '2026-08-31' });
    expect(r.currency).toBe('HNL');
    expect(r.timezones).toEqual(['America/Tegucigalpa']);
    expect(r.attribution).toEqual(['1d_view_7d_click']);
    expect(r.totals.current).toMatchObject({
      spend: 210,
      impressions: 14_000,
      inlineLinkClicks: 119,
    });
    expect(r.totals.previous).toMatchObject({ spend: 140, impressions: 14_000 });
    // Resultados de las campañas (el nivel de cuenta no los trae), con dos tipos: no se suman.
    expect([...r.totals.resultTypes].sort()).toEqual([LEADS, MESSAGES].sort());
    // El periodo de comparación trae sus propios tipos (no se suman resultados mezclados al comparar).
    expect([...r.totals.previousResultTypes].sort()).toEqual([LEADS, MESSAGES].sort());
    expect(r.children?.rows.find((c) => c.id === m.c1)?.previousResultTypes).toEqual([MESSAGES]);
    expect(compute('results', r.totals.current, ctx(r))).toMatchObject({
      value: null,
      state: 'unavailable',
    });
    expect(r.results).toEqual([
      { indicator: MESSAGES, current: 21, previous: 21 },
      { indicator: LEADS, current: 7, previous: 7 },
    ]);
    expect(compute('cpm', r.totals.current, ctx(r)).value).toBeCloseTo(15); // 210 ÷ 14000 × 1000
    // El alcance de 7 días no se suma.
    expect(compute('reach', r.totals.current, ctx(r)).reason).toBe(
      'el alcance no se suma entre días',
    );

    expect(r.series).toHaveLength(7);
    expect(r.series[0]).toMatchObject({ date: '2026-09-01', previousDate: '2026-08-25' });
    expect(r.series[0]?.current.spend).toBe(30);
    expect(r.series[0]?.previous?.spend).toBe(20);
    expect(r.series[0]?.current.results).toBe(4); // 3 mensajes + 1 cliente potencial

    expect(r.children?.level).toBe('campaign');
    const byId = Object.fromEntries((r.children?.rows ?? []).map((c) => [c.id, c]));
    expect(byId[m.c1]).toMatchObject({
      name: 'Mensajes',
      status: 'ACTIVE',
      objective: 'OUTCOME_ENGAGEMENT',
    });
    expect(byId[m.c1]?.current.spend).toBe(182);
    expect(byId[m.c1]?.resultTypes).toEqual([MESSAGES]);
    expect(byId[m.c2]?.current.spend).toBe(28);
    expect(r.path.map((p) => p.level)).toEqual(['org', 'client', 'account']);
    expect(r.freshness).toMatchObject({
      accounts: 1,
      syncEnabled: 1,
      neverSynced: 0,
      dataUntil: '2026-09-07',
    });
  });

  it('un día suelto sí muestra el alcance (estimado)', async () => {
    const r = await report(
      `/v1/analytics?level=account&id=${ids.acc1}&since=2026-09-03&until=2026-09-03&compare=none`,
    );
    expect(r.compare).toBeNull();
    expect(compute('reach', r.totals.current, ctx(r))).toMatchObject({
      value: 1500,
      state: 'estimated',
    });
  });
});

describe('investigar hasta el anuncio', () => {
  it('campaña → conjuntos → anuncios, con estados de entrega y lo que ya no aparece en Meta', async () => {
    const campaign = await report(query('campaign', m.c1));
    expect(campaign.node).toMatchObject({ level: 'campaign', name: 'Mensajes', status: 'ACTIVE' });
    expect(campaign.children?.rows.map((c) => [c.id, c.learning])).toEqual([[m.s1, 'LEARNING']]);

    const adset = await report(query('adset', m.s1));
    const rows = Object.fromEntries((adset.children?.rows ?? []).map((c) => [c.id, c]));
    expect(Object.keys(rows).sort()).toEqual([m.a1, m.a2, m.orphan].sort());
    expect(rows[m.orphan]).toMatchObject({ name: `ID ${m.orphan}`, deleted: true });
    expect(rows[m.a1]?.current.spend).toBe(140);
    expect(rows[m.a1]?.previous?.spend).toBe(70); // el anuncio que explica la subida

    const empty = await report(query('adset', m.s2));
    const noDelivery = empty.children?.rows.find((c) => c.id === m.a4);
    expect(noDelivery?.current.impressions).toBe(0);
    expect(compute('cpm', noDelivery!.current, ctx(empty))).toMatchObject({
      value: null,
      reason: 'sin impresiones',
    });

    const ad = await report(query('ad', m.a1));
    expect(ad.children).toBeNull();
    expect(ad.path.map((p) => p.name)).toEqual([
      expect.any(String),
      a.client.name,
      'Cuenta HNL A',
      'Mensajes',
      'Conjunto 1',
      'Anuncio 1',
    ]);
    expect(ad.series.map((d) => d.current.spend)).toEqual([20, 20, 20, 20, 20, 20, 20]);
  });
});

describe('cartera y monedas (ADR-020)', () => {
  it('nunca suma monedas distintas: por defecto la de más gasto y se puede elegir otra', async () => {
    const usd = await report(query('org'));
    expect(usd.currencies.map((c) => [c.code, c.accounts])).toEqual([
      ['USD', 1],
      ['HNL', 2],
      ['EUR', 1], // la cuenta del seed común: sin gasto en el rango, va al final
    ]);
    expect(usd.currency).toBe('USD');
    expect(usd.totals.current.spend).toBe(700);
    expect(usd.children?.rows.map((c) => c.id)).toEqual([ids.clientB]);

    const hnl = await report(query('org', undefined, '&currency=HNL'));
    expect(hnl.currency).toBe('HNL');
    // 210 de la cuenta A + 49 de la B; la cuenta sembrada en EUR y la de USD quedan fuera.
    expect(hnl.totals.current.spend).toBe(259);
    expect(hnl.totals.sources).toBe(2); // 2 cuentas en HNL: el alcance no es sumable
    expect(hnl.children?.rows.find((c) => c.id === ids.clientB)?.current.spend).toBe(49);
  });

  it('un cliente con cuentas en dos monedas muestra solo las de la moneda elegida', async () => {
    const r = await report(query('client', ids.clientB, '&currency=HNL'));
    expect(r.children?.rows.map((c) => c.id)).toEqual([ids.acc2]);
    expect(r.children?.rows[0]).toMatchObject({
      statusKind: 'account',
      status: '1',
      currency: 'HNL',
    });
  });
});

describe('seguridad', () => {
  it('un analista solo ve sus clientes asignados, en todos los niveles', async () => {
    const analyst = await addMember(db, a.tenantId, 'analyst', [a.client.id]);
    const org = await report(query('org', undefined, '&currency=HNL'), analyst);
    expect(org.children?.rows.map((c) => c.id)).toEqual([a.client.id]);
    expect(org.totals.current.spend).toBe(210);
    for (const url of [
      query('client', ids.clientB),
      query('account', ids.acc2),
      query('campaign', m.c3),
      query('client', 'none'),
    ]) {
      expect((await t.as(analyst).get(url)).statusCode, url).toBe(404);
    }
  });

  it('otra organización recibe 404 para cualquier id ajeno', async () => {
    for (const url of [
      query('account', ids.acc1),
      query('campaign', m.c1),
      query('adset', m.s1),
      query('ad', m.a1),
    ]) {
      expect((await t.as(other.owner).get(url)).statusCode, url).toBe(404);
    }
  });

  it('valida el rango y los ids', async () => {
    expect((await t.as(a.owner).get('/v1/analytics?since=2026-09-01')).statusCode).toBe(400);
    expect(
      (await t.as(a.owner).get('/v1/analytics?since=2026-09-07&until=2026-09-01')).statusCode,
    ).toBe(400);
    expect((await t.as(a.owner).get('/v1/analytics?level=campaign&id=abc')).statusCode).toBe(404);
    expect((await t.as(null).get(query('org'))).statusCode).toBe(401);
  });
});

describe('exportación CSV', () => {
  it('exporta la tabla con comparación, sin fórmulas ejecutables, y queda auditada', async () => {
    const res = await t
      .as(a.owner)
      .get(
        `/v1/analytics/export.csv?level=account&id=${ids.acc1}&since=${CUR.since}&until=${CUR.until}&columns=spend,cpm,linkCtr,nope`,
      );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="ad-astra-account-${CUR.since}_${CUR.until}.csv"`,
    );
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(res.body.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe(
      'Nombre,ID,Estado,Moneda,Importe gastado,Importe gastado (anterior),Importe gastado (variación %),CPM,CPM (anterior),CPM (variación %),CTR del enlace (%),CTR del enlace (%) (anterior),CTR del enlace (%) (variación %)',
    );
    expect(lines.find((l) => l.includes(m.c1))).toMatch(/^Mensajes,\d+,Activa,HNL,182,112,62\.5,/);
    // El nombre "=SUM(A1)" no se ejecuta como fórmula al abrirlo en una hoja de cálculo.
    expect(lines.find((l) => l.includes(m.c2))).toMatch(/^'=SUM\(A1\),/);
    expect(lines.at(-1)).toMatch(/^Total,,,HNL,210,140,50,/);

    const [event] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'analytics.exported')),
    );
    expect(event).toMatchObject({ actorId: a.owner.id, targetType: 'account', targetId: ids.acc1 });
    expect(event?.after).toMatchObject({
      columns: ['spend', 'cpm', 'linkCtr'],
      rows: 2,
      since: CUR.since,
    });
  });
});

describe('celdas CSV', () => {
  it('neutraliza fórmulas pero deja los números negativos como números', () => {
    expect(csvCell('-1.37')).toBe('-1.37');
    expect(csvCell('-40')).toBe('-40');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
  });
});

import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { ForecastBody, ForecastDto, SimulationBody, SimulationDto } from '../../contracts.ts';
import { type Db, type Tx, withContext } from '../../db/client.ts';
import { adsets, campaigns, insightsDaily } from '../../db/schema.ts';
import { badRequest } from '../../platform/errors.ts';
import { type TenantContext, tenantOf } from '../../platform/http.ts';
import { resolveEntity } from '../audit/engine.routes.ts';
import { kpiOf, PROFILES, profileOf } from '../audit/model.ts';
import { canonical, effectiveConfig } from '../audit/service.ts';
import { findAccount } from '../catalog/accounts.ts';
import { addDays, localDate } from '../insights/catalog.ts';
import {
  CRITERIA,
  coverageOk,
  type DailyRow,
  type ExcludedRange,
  FORECAST_CARD,
  FORECAST_VERSION,
  forecastRatio,
  forecastSeries,
  MODELS,
  prepareHistory,
  requiredDays,
  type SeriesForecast,
  seriesOf,
} from './forecast.ts';
import {
  fitResponse,
  type Plan,
  RESPONSE,
  SIMULATION_CARD,
  SIMULATION_VERSION,
  simulatePlans,
  validateResponse,
  weeksOf,
} from './simulate.ts';

// Pronóstico y simulación (F6): se calculan al pedirlos desde insights_daily, con RLS y el alcance
// por cliente del usuario. No escriben nada: la respuesta lleva la versión del motor y la huella
// de las entradas para reproducirla.
// ponytail: sin tablas forecasts/simulations; se añaden si hay que guardar escenarios o seguir la
// precisión de los pronósticos publicados frente a lo ocurrido.

/** Historia que se lee: cubre los 30 orígenes del backtest y las 26 semanas de la curva. */
const HISTORY_DAYS = 400;

const FIELDS = {
  spend: insightsDaily.spend,
  impressions: insightsDaily.impressions,
  inlineLinkClicks: insightsDaily.inlineLinkClicks,
  landingPageViews: insightsDaily.landingPageViews,
  results: insightsDaily.results,
  leads: insightsDaily.leads,
  messagingConversations: insightsDaily.messagingConversations,
  purchases: insightsDaily.purchases,
  appInstalls: insightsDaily.appInstalls,
};
type Field = keyof typeof FIELDS;

const METRICS: Array<{
  id: Field;
  label: string;
  unit: 'currency' | 'count';
  conversion: boolean;
}> = [
  { id: 'spend', label: 'Gasto', unit: 'currency', conversion: false },
  { id: 'impressions', label: 'Impresiones', unit: 'count', conversion: false },
  { id: 'inlineLinkClicks', label: 'Clics en el enlace', unit: 'count', conversion: false },
  {
    id: 'landingPageViews',
    label: 'Visitas a la página de destino',
    unit: 'count',
    conversion: false,
  },
  { id: 'leads', label: 'Clientes potenciales', unit: 'count', conversion: true },
  {
    id: 'messagingConversations',
    label: 'Conversaciones iniciadas',
    unit: 'count',
    conversion: true,
  },
  { id: 'purchases', label: 'Compras', unit: 'count', conversion: true },
  { id: 'appInstalls', label: 'Instalaciones de la app', unit: 'count', conversion: true },
];
const RATIOS: Array<{ id: string; label: string; denominator: Field; scale: number }> = [
  { id: 'cpm', label: 'CPM', denominator: 'impressions', scale: 1000 },
  { id: 'cpc', label: 'CPC del enlace', denominator: 'inlineLinkClicks', scale: 1 },
  {
    id: 'costPerLandingPageView',
    label: 'Costo por visita a la página',
    denominator: 'landingPageViews',
    scale: 1,
  },
  { id: 'costPerLead', label: 'Costo por cliente potencial', denominator: 'leads', scale: 1 },
  {
    id: 'costPerConversation',
    label: 'Costo por conversación',
    denominator: 'messagingConversations',
    scale: 1,
  },
  { id: 'costPerPurchase', label: 'Costo por compra', denominator: 'purchases', scale: 1 },
  { id: 'costPerInstall', label: 'Costo por instalación', denominator: 'appInstalls', scale: 1 },
];

interface LoadedRow extends DailyRow {
  entity: string;
  resultIndicator: string | null;
}

async function loadRows(
  tx: Tx,
  adAccountId: string,
  level: 'account' | 'campaign',
  entityIds: string[] | null,
  since: string,
  until: string,
): Promise<LoadedRow[]> {
  const rows = await tx
    .select({
      date: insightsDaily.date,
      entity: insightsDaily.entityMetaId,
      attribution: insightsDaily.attributionSetting,
      resultIndicator: insightsDaily.resultIndicator,
      ...FIELDS,
    })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.adAccountId, adAccountId),
        eq(insightsDaily.level, level),
        entityIds ? inArray(insightsDaily.entityMetaId, entityIds) : undefined,
        gte(insightsDaily.date, since),
        lte(insightsDaily.date, until),
      ),
    )
    .orderBy(insightsDaily.date);
  return rows.map((r) => ({
    date: r.date,
    entity: r.entity,
    attribution: r.attribution,
    resultIndicator: r.resultIndicator,
    values: Object.fromEntries(
      (Object.keys(FIELDS) as Field[]).map((f) => [f, r[f] === null ? 0 : Number(r[f])]),
    ),
  }));
}

/** Día observado más reciente (ayer, local de la cuenta) y días de maduración del cliente. */
async function observedWindow(
  tx: Tx,
  account: { clientId: string | null; timezoneName: string },
  asOf?: string,
) {
  const yesterday = addDays(localDate(account.timezoneName), -1);
  if (asOf && asOf > yesterday)
    throw badRequest(
      `asOf no puede ser posterior a ayer en la zona horaria de la cuenta (${yesterday})`,
    );
  const gap = (await effectiveConfig(tx, account.clientId)).windows.maturityDays;
  const day = asOf ?? yesterday;
  return { asOf: day, gap, cut: addDays(day, -gap) };
}

const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const inRanges = (date: string, ranges: readonly ExcludedRange[]) =>
  ranges.some((r) => date >= r.since && date <= r.until);

export async function buildForecast(
  tx: Tx,
  ctx: TenantContext,
  body: z.infer<typeof ForecastBody>,
): Promise<z.infer<typeof ForecastDto>> {
  const { account, entityMetaId } = await resolveEntity(tx, ctx, body.level, body.id);
  const { asOf, gap, cut } = await observedWindow(tx, account, body.asOf);
  const rows = await loadRows(
    tx,
    account.id,
    body.level,
    [entityMetaId],
    addDays(asOf, -HISTORY_DAYS),
    asOf,
  );
  const [campaign] =
    body.level === 'campaign'
      ? await tx
          .select({ name: campaigns.name })
          .from(campaigns)
          .where(eq(campaigns.metaId, entityMetaId))
      : [];
  const history = prepareHistory(rows, cut, body.exclude);
  const h = { horizon: body.horizonDays, gap };
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const firstDate = rows[0]?.date ?? null;

  const forecasts = new Map<Field, SeriesForecast>();
  const metrics = METRICS.filter(
    (m) => m.id === 'spend' || rows.some((r) => (r.values[m.id] ?? 0) > 0),
  ).map((m) => {
    const f = forecastSeries(history, seriesOf(history, m.id), h, { count: m.unit === 'count' });
    forecasts.set(m.id, f);
    const chosen = f.backtest?.chosen ?? null;
    return {
      id: m.id,
      label: m.label,
      unit: m.unit,
      conversion: m.conversion,
      status: f.status,
      reasons: f.reasons,
      usableDays: f.usableDays,
      requiredDays: f.requiredDays,
      recentDailyMean: f.recentDailyMean,
      anomalies: f.anomalies.map((i) => history.dates[i] as string),
      backtest: f.backtest && {
        origins: f.backtest.origins,
        chosen,
        chosenLabel: chosen ? MODELS[chosen].label : null,
        method: chosen ? MODELS[chosen].method : null,
        scores: f.backtest.scores.map((s) => ({
          ...s,
          label: MODELS[s.model].label,
          mae: Number.isFinite(s.mae) ? s.mae : null,
        })),
        calibration: f.backtest.calibration && {
          evaluated: f.backtest.calibration.evaluated,
          dailyCoverage: f.backtest.calibration.dailyCoverage,
          totalCoverage: f.backtest.calibration.totalCoverage,
        },
      },
      history: Array.from({ length: 56 }, (_, i) => {
        const date = addDays(asOf, i - 55);
        const known = firstDate !== null && date >= firstDate && !inRanges(date, body.exclude);
        return {
          date,
          value: known ? (byDate.get(date)?.values[m.id] ?? 0) : null,
          immature: m.conversion && date > cut,
        };
      }),
      forecast: f.points?.map((p, i) => ({ ...p, date: addDays(asOf, i + 1) })) ?? null,
      total: f.total,
    };
  });
  const spend = forecasts.get('spend') as SeriesForecast;
  const ratios = RATIOS.filter((r) => forecasts.has(r.denominator)).map((r) => ({
    id: r.id,
    label: r.label,
    ...forecastRatio(spend, forecasts.get(r.denominator) as SeriesForecast, h, r.scale),
  }));

  return {
    version: FORECAST_VERSION,
    node: {
      level: body.level,
      id: body.level === 'account' ? account.id : entityMetaId,
      name: body.level === 'account' ? account.name : (campaign?.name ?? `ID ${entityMetaId}`),
      accountId: account.id,
      currency: account.currency,
      timezone: account.timezoneName,
    },
    asOf,
    cut,
    horizonDays: body.horizonDays,
    gapDays: gap,
    start: history.start,
    usableDays: history.dates.length,
    requiredDays: requiredDays(h),
    breaks: history.breaks,
    excluded: body.exclude,
    criteria: CRITERIA,
    metrics,
    ratios,
    assumptions: FORECAST_CARD.assumptions,
    limitations: FORECAST_CARD.limitations,
    inputHash: hash({ version: FORECAST_VERSION, body: { ...body, asOf }, gap, rows }),
  };
}

const mostCommon = (values: Array<string | null>) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const promotedEvent = (o: unknown) =>
  o && typeof o === 'object' && 'custom_event_type' in o
    ? String((o as { custom_event_type: unknown }).custom_event_type)
    : null;

export async function buildSimulation(
  tx: Tx,
  ctx: TenantContext,
  body: z.infer<typeof SimulationBody>,
): Promise<z.infer<typeof SimulationDto>> {
  const account = await findAccount(tx, ctx, body.adAccountId);
  const { asOf, gap, cut } = await observedWindow(tx, account, body.asOf);
  // En serie: una transacción es una sola conexión.
  const listed = await tx.select().from(campaigns).where(eq(campaigns.adAccountId, account.id));
  const sets = await tx.select().from(adsets).where(eq(adsets.adAccountId, account.id));
  const rows = await loadRows(tx, account.id, 'campaign', null, addDays(asOf, -HISTORY_DAYS), asOf);
  const rowsOf = new Map<string, LoadedRow[]>();
  for (const r of rows) rowsOf.set(r.entity, [...(rowsOf.get(r.entity) ?? []), r]);
  const ids = [...new Set([...listed.map((c) => c.metaId), ...rowsOf.keys()])];
  const changes = new Map(body.changes.map((c) => [c.campaignId, c.dailySpend]));
  for (const id of changes.keys())
    if (!ids.includes(id)) throw badRequest(`La campaña ${id} no es de esta cuenta`);

  const H = body.horizonDays;
  const plans: Plan[] = [];
  const out = ids.flatMap((id) => {
    const c = listed.find((x) => x.metaId === id);
    const daily = rowsOf.get(id) ?? [];
    const recent = daily.filter((d) => d.date > addDays(asOf, -28));
    const current = recent.reduce((s, d) => s + (d.values.spend ?? 0), 0) / 28;
    if (current <= 0 && !changes.has(id)) return []; // inactiva y sin plan: no aporta
    const planned = changes.get(id) ?? current;
    const own = sets.filter((s) => s.campaignMetaId === id);
    const goal = mostCommon(own.map((s) => s.optimizationGoal));
    const profile = profileOf({
      optimizationGoal: goal,
      promotedEvent: promotedEvent(own.find((s) => s.optimizationGoal === goal)?.promotedObject),
      objective: c?.objective ?? null,
      resultTypes: [
        ...new Set(daily.map((d) => d.resultIndicator).filter((t): t is string => !!t)),
      ],
    });
    const kpi = kpiOf(profile, {
      hasLandingPageViews: daily.some((d) => (d.values.landingPageViews ?? 0) > 0),
    });
    const history = prepareHistory(daily, cut, body.exclude);
    const weeks = weeksOf(history, kpi.field);
    const fit = fitResponse(weeks);
    const validation = fit ? validateResponse(weeks, body.seed) : null;
    let status: 'published' | 'not_published' | 'insufficient_data' = 'published';
    const reasons: string[] = [];
    const events = weeks.reduce((s, w) => s + w.events, 0);
    if (!fit) {
      status = 'insufficient_data';
      reasons.push(
        `Hay ${weeks.length} semanas con gasto y ${Math.round(events)} ${kpi.label} utilizables; la curva exige ${RESPONSE.minWeeks} semanas y ${RESPONSE.minEvents} eventos.`,
      );
    } else if (!validation || validation.evaluated < RESPONSE.minValidated) {
      status = 'insufficient_data';
      reasons.push(
        `Solo ${validation?.evaluated ?? 0} semanas para validar la curva (mínimo ${RESPONSE.minValidated}: hacen falta ${RESPONSE.minWeeks + RESPONSE.minValidated} semanas con gasto).`,
      );
    } else if (
      validation.coverage === null ||
      !coverageOk(validation.coverage, validation.evaluated)
    ) {
      status = 'not_published';
      reasons.push(
        `La validación de un paso no está calibrada: cobertura del 80 % de ${Math.round((validation.coverage ?? 0) * 100)} % en ${validation.evaluated} semanas (aceptable entre 70 % y 90 %, más un error típico por el tamaño de la muestra).`,
      );
    }
    if (history.pausedAtEnd && planned > 0)
      reasons.push(
        'Reactivación tras una pausa: la curva viene de antes y la fase de aprendizaje puede reiniciarse.',
      );
    if (fit && status === 'published')
      plans.push({ id, group: kpi.field, fit, currentDaily: current, plannedDaily: planned });
    const sd = fit ? Math.sqrt(fit.cov.bb) : 0;
    return [
      {
        id,
        name: c?.name ?? `ID ${id}`,
        effectiveStatus: c?.effectiveStatus ?? null,
        profile,
        profileLabel: PROFILES[profile],
        kpi: { field: kpi.field, label: kpi.label, costLabel: kpi.costLabel, scale: kpi.scale },
        currentDailySpend: current,
        plannedDailySpend: planned,
        status,
        reasons,
        curve: fit && {
          weeks: fit.weeks,
          events: fit.events,
          elasticity: { point: fit.b, lower: fit.b - 1.2816 * sd, upper: fit.b + 1.2816 * sd },
          learned: fit.learned,
          phi: fit.phi,
          spendRange: fit.spendRange,
        },
        validation: validation && {
          evaluated: validation.evaluated,
          coverage: validation.coverage,
          relMae: validation.relMae,
        },
      },
    ];
  });

  const sim = simulatePlans(plans, H, { seed: body.seed });
  const scaleOf = (field: string) => out.find((c) => c.kpi.field === field)?.kpi.scale ?? 1;
  const scaled = (
    cost: { p10: number | null; p50: number | null; p90: number | null },
    s: number,
  ) => ({
    p10: cost.p10 === null ? null : cost.p10 * s,
    p50: cost.p50 === null ? null : cost.p50 * s,
    p90: cost.p90 === null ? null : cost.p90 * s,
  });
  const campaignsOut = out.map(({ kpi: { scale, ...kpi }, ...c }) => {
    const o = sim.outcomes.find((x) => x.id === c.id);
    return {
      ...c,
      kpi,
      outcome: o ? { ...o, cost: scaled(o.cost, scale) } : null,
    };
  });
  return {
    version: SIMULATION_VERSION,
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      timezone: account.timezoneName,
    },
    asOf,
    cut,
    horizonDays: H,
    seed: body.seed,
    draws: RESPONSE.draws,
    campaigns: campaignsOut,
    totals: sim.totals.map((t) => {
      const c = out.find((x) => x.kpi.field === t.group);
      return {
        field: t.group,
        label: c?.kpi.label ?? t.group,
        costLabel: c?.kpi.costLabel ?? '',
        campaigns: plans.filter((p) => p.group === t.group).length,
        spend: t.spend,
        events: t.events,
        cost: scaled(t.cost, scaleOf(t.group)),
        probNoEvents: t.probNoEvents,
        expectedChange: t.expectedChange,
      };
    }),
    spend: {
      current: out.reduce((s, c) => s + c.currentDailySpend * H, 0),
      planned: out.reduce((s, c) => s + c.plannedDailySpend * H, 0),
      notSimulated: out
        .filter((c) => c.status !== 'published')
        .reduce((s, c) => s + c.plannedDailySpend * H, 0),
    },
    prior: RESPONSE.prior,
    assumptions: SIMULATION_CARD.assumptions,
    limitations: SIMULATION_CARD.limitations,
    inputHash: hash({ version: SIMULATION_VERSION, body: { ...body, asOf }, gap, rows }),
  };
}

export async function forecastingRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST porque lleva cuerpo (eventos excluidos); no modifica nada.
  app.post(
    '/v1/forecasts',
    {
      config: { access: { permission: 'insights:read' } },
      schema: { body: ForecastBody, response: { 200: ForecastDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, (tx) => buildForecast(tx, ctx, request.body));
    },
  );

  app.post(
    '/v1/simulations',
    {
      config: { access: { permission: 'insights:read' } },
      schema: { body: SimulationBody, response: { 200: SimulationDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, (tx) => buildSimulation(tx, ctx, request.body));
    },
  );
}

import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ExperimentBody,
  ExperimentDto,
  ExperimentListQuery,
  ExperimentPreviewDto,
  ForecastBody,
  ForecastDto,
  IdParams,
  SimulationBody,
  SimulationDto,
} from '../../contracts.ts';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import { adsets, budgetExperiments, campaigns, insightsDaily } from '../../db/schema.ts';
import { badRequest, conflict, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { type TenantContext, tenantOf } from '../../platform/http.ts';
import { resolveEntity } from '../audit/engine.routes.ts';
import { type KpiEvent, kpiOf, PROFILES, type Profile, profileOf } from '../audit/model.ts';
import { canonical, effectiveConfig } from '../audit/service.ts';
import { findAccount } from '../catalog/accounts.ts';
import { addDays, localDate } from '../insights/catalog.ts';
import { type CalendarEvent, calendarEvents, MODELED, type UserEvent } from './calendar.ts';
import {
  CRITERIA,
  coverageOk,
  type DailyRow,
  type EventEffect,
  FORECAST_CARD,
  FORECAST_VERSION,
  forecastRatio,
  forecastSeries,
  type History,
  MODELS,
  prepareHistory,
  requiredDays,
  type SeriesForecast,
  seriesOf,
} from './forecast.ts';
import {
  analyzeExperiment,
  type CurveFit,
  causalElasticity,
  confoundingSd,
  designExperiment,
  type ExperimentPeriod,
  type ExperimentResult,
  expectedWeekly,
  experimentPower,
  fitCurve,
  learned,
  localElasticity,
  type Plan,
  RESPONSE,
  SHARE_CATEGORIES,
  SIMULATION_CARD,
  SIMULATION_VERSION,
  shockCorrelation,
  simulatePlans,
  validatedRange,
  validateExtremes,
  validateResponse,
  weeksOf,
} from './simulate.ts';

// Pronóstico, simulación y experimentos de presupuesto (F6). Pronósticos y escenarios se calculan
// al pedirlos desde insights_daily, con RLS y el alcance por cliente del usuario, y llevan la versión
// del motor y la huella de las entradas. Los experimentos guardan su diseño aleatorizado; su análisis
// se calcula al leerlos.
// ponytail: sin tablas forecasts/simulations; se añaden si hay que guardar escenarios o seguir la
// precisión de los pronósticos publicados frente a lo ocurrido.

/** Historia que se lee: cubre los 30 orígenes del backtest y las 26 semanas de la curva. */
const HISTORY_DAYS = 400;
const Z80 = 1.2816;

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
      (Object.keys(FIELDS) as Field[]).map((f) => [f, r[f] === null ? Number.NaN : Number(r[f])]),
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
const band = (mean: number, sd: number) => ({
  point: mean,
  lower: mean - Z80 * sd,
  upper: mean + Z80 * sd,
});
const effectDto = (e: EventEffect) => ({
  key: e.key,
  label: e.label,
  category: e.category,
  occurrences: e.occurrences,
  effect: {
    point: Math.exp(e.mean),
    lower: Math.exp(e.mean - Z80 * e.sd),
    upper: Math.exp(e.mean + Z80 * e.sd),
  },
  source: e.occurrences ? ('history' as const) : ('prior' as const),
});

/** Calendario (incorporado y propio) de la historia que se lee y del horizonte. */
const calendarFor = (
  asOf: string,
  horizon: number,
  body: { events: UserEvent[]; builtinCalendar: boolean },
) =>
  calendarEvents(
    addDays(asOf, -HISTORY_DAYS),
    addDays(asOf, horizon + 7),
    body.events,
    body.builtinCalendar,
  );

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
  const events = calendarFor(asOf, body.horizonDays, body);
  const history = prepareHistory(rows, cut, events);
  const h = { horizon: body.horizonDays, gap };
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const firstDate = rows[0]?.date ?? null;
  const incident = (date: string) =>
    body.events.some((e) => e.category === 'incident' && date >= e.since && date <= e.until);

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
        selectionOrigins: f.backtest.selectionOrigins,
        evaluationOrigins: f.backtest.evaluationOrigins,
        selectionScores: f.backtest.selectionScores.map((s) => ({
          ...s,
          label: MODELS[s.model].label,
          mae: Number.isFinite(s.mae) ? s.mae : null,
        })),
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
          eventDays: f.backtest.calibration.eventDays,
          eventCoverage: f.backtest.calibration.eventCoverage,
        },
      },
      events: f.events.map(effectDto),
      history: Array.from({ length: 56 }, (_, i) => {
        const date = addDays(asOf, i - 55);
        const known = firstDate !== null && date >= firstDate && !incident(date);
        return {
          date,
          value:
            known && Number.isFinite(byDate.get(date)?.values[m.id] ?? 0)
              ? (byDate.get(date)?.values[m.id] ?? 0)
              : null,
          immature: m.conversion && date > cut,
          event: history.eventAt(date)?.label ?? null,
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
  const horizonEnd = addDays(asOf, body.horizonDays);

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
    events: body.events,
    builtinCalendar: body.builtinCalendar,
    calendar: events.filter(
      (e) => MODELED.includes(e.category) && e.since <= horizonEnd && e.until > asOf,
    ),
    criteria: CRITERIA,
    metrics,
    ratios,
    assumptions: FORECAST_CARD.assumptions,
    limitations: FORECAST_CARD.limitations,
    inputHash: hash({ version: FORECAST_VERSION, body: { ...body, asOf }, gap, rows }),
  };
}

// --- Campañas de una cuenta (simulación y experimentos)

const mostCommon = (values: Array<string | null>) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const promotedEvent = (o: unknown) =>
  o && typeof o === 'object' && 'custom_event_type' in o
    ? String((o as { custom_event_type: unknown }).custom_event_type)
    : null;

interface CampaignData {
  id: string;
  name: string;
  effectiveStatus: string | null;
  profile: Profile;
  kpi: KpiEvent;
  byDate: Map<string, LoadedRow>;
  history: History;
  /** Gasto diario medio de los últimos 28 días. */
  current: number;
}

async function accountCampaigns(
  tx: Tx,
  accountId: string,
  asOf: string,
  cut: string,
  events: readonly CalendarEvent[],
): Promise<CampaignData[]> {
  // En serie: una transacción es una sola conexión.
  const listed = await tx.select().from(campaigns).where(eq(campaigns.adAccountId, accountId));
  const sets = await tx.select().from(adsets).where(eq(adsets.adAccountId, accountId));
  const rows = await loadRows(tx, accountId, 'campaign', null, addDays(asOf, -HISTORY_DAYS), asOf);
  const rowsOf = new Map<string, LoadedRow[]>();
  for (const r of rows) rowsOf.set(r.entity, [...(rowsOf.get(r.entity) ?? []), r]);
  const ids = [...new Set([...listed.map((c) => c.metaId), ...rowsOf.keys()])];
  return ids.map((id) => {
    const c = listed.find((x) => x.metaId === id);
    const daily = rowsOf.get(id) ?? [];
    if (daily.some((d) => d.date > addDays(asOf, -28) && !Number.isFinite(d.values.spend)))
      throw badRequest(
        `Gasto desconocido en los últimos 28 días de la campaña ${id}: completa la sincronización antes de simular.`,
      );
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
    return {
      id,
      name: c?.name ?? `ID ${id}`,
      effectiveStatus: c?.effectiveStatus ?? null,
      profile,
      kpi: kpiOf(profile, {
        hasLandingPageViews: daily.some((d) => (d.values.landingPageViews ?? 0) > 0),
      }),
      byDate: new Map(daily.map((d) => [d.date, d])),
      history: prepareHistory(daily, cut, events),
      current:
        daily
          .filter((d) => d.date > addDays(asOf, -28))
          .reduce((s, d) => s + (d.values.spend ?? 0), 0) / 28,
    };
  });
}

/** Gasto diario de las otras campañas con el mismo evento clave. */
const othersOf = (all: readonly CampaignData[], c: CampaignData) => {
  const peers = all.filter((d) => d !== c && d.kpi.field === c.kpi.field);
  return (date: string) => peers.reduce((s, d) => s + (d.byDate.get(date)?.values.spend ?? 0), 0);
};

// --- Experimentos

type ExperimentRow = typeof budgetExperiments.$inferSelect;

function experimentStatus(e: ExperimentRow, asOf: string, cut: string) {
  const schedule = e.schedule as ExperimentPeriod[];
  const end = schedule.at(-1)?.until ?? e.startDate;
  if (e.status === 'cancelled') return 'cancelled' as const;
  if (e.startDate > asOf) return 'planned' as const;
  if (end > asOf) return 'running' as const;
  if (end > cut) return 'awaiting_data' as const;
  return 'complete' as const;
}

function analyze(e: ExperimentRow, data: CampaignData | undefined, cut: string): ExperimentResult {
  const schedule = e.schedule as ExperimentPeriod[];
  const excluded = new Set(data?.history.dates.filter((_, i) => data.history.excluded[i]));
  return analyzeExperiment(
    schedule,
    (date) => {
      if (!data?.history.start || date < data.history.start || excluded.has(date))
        return { spend: Number.NaN, events: Number.NaN };
      const r = data?.byDate.get(date);
      return { spend: r?.values.spend ?? 0, events: r?.values[e.kpiField] ?? 0 };
    },
    cut,
    Number(e.baseDailySpend),
    e.burnInDays,
  );
}

const resultDto = (r: ExperimentResult) => ({
  ...r,
  elasticity: r.elasticity && { ...r.elasticity },
});

function experimentDto(
  e: ExperimentRow,
  data: CampaignData | undefined,
  asOf: string,
  cut: string,
): z.infer<typeof ExperimentDto> {
  const schedule = e.schedule as ExperimentPeriod[];
  const base = Number(e.baseDailySpend);
  return {
    id: e.id,
    campaignId: e.campaignMetaId,
    campaignName: data?.name ?? `ID ${e.campaignMetaId}`,
    kpi: { field: e.kpiField, label: data?.kpi.label ?? e.kpiField },
    baseDailySpend: base,
    burnInDays: e.burnInDays,
    seed: e.seed,
    schedule: schedule.map((p) => ({ ...p, dailySpend: base * p.multiplier })),
    power: (e.power as { se: number; detectable: number } | null) ?? null,
    observed: (e.observed as { mean: number; sd: number } | null) ?? null,
    warnings: [],
    status: experimentStatus(e, asOf, cut),
    startDate: e.startDate,
    endDate: schedule.at(-1)?.until ?? e.startDate,
    levels: e.levels as number[],
    result: resultDto(analyze(e, data, cut)),
    createdAt: e.createdAt.toISOString(),
    cancelledAt: e.cancelledAt ? e.cancelledAt.toISOString() : null,
  };
}

const activeExperiments = (tx: Tx, accountId: string) =>
  tx
    .select()
    .from(budgetExperiments)
    .where(
      and(eq(budgetExperiments.adAccountId, accountId), eq(budgetExperiments.status, 'planned')),
    )
    .orderBy(desc(budgetExperiments.startDate));

// --- Simulación

export async function buildSimulation(
  tx: Tx,
  ctx: TenantContext,
  body: z.infer<typeof SimulationBody>,
): Promise<z.infer<typeof SimulationDto>> {
  const account = await findAccount(tx, ctx, body.adAccountId);
  const { asOf, gap, cut } = await observedWindow(tx, account, body.asOf);
  const H = body.horizonDays;
  const events = calendarFor(asOf, H, body);
  const all = await accountCampaigns(tx, account.id, asOf, cut, events);
  const changes = new Map(body.changes.map((c) => [c.campaignId, c.dailySpend]));
  for (const id of changes.keys())
    if (!all.some((c) => c.id === id)) throw badRequest(`La campaña ${id} no es de esta cuenta`);
  const included = all.filter((c) => c.current > 0 || changes.has(c.id));
  const planned = (c: CampaignData) => changes.get(c.id) ?? c.current;

  // Experimentos concluyentes: elasticidad causal por campaña y calibración del sesgo.
  const experiments = (await activeExperiments(tx, account.id)).map((e) => ({
    row: e,
    result: analyze(
      e,
      all.find((c) => c.id === e.campaignMetaId),
      cut,
    ),
  }));
  const conclusive = experiments.filter((e) => e.result.complete && e.result.elasticity);
  const confounding = confoundingSd(
    conclusive
      .filter((e) => e.row.observed)
      .map((e) => {
        const o = e.row.observed as { mean: number; sd: number };
        return {
          observed: o.mean,
          observedSe: o.sd,
          experimental: e.result.elasticity?.point ?? 0,
          experimentalSe: e.result.elasticity?.se ?? 0,
        };
      }),
  );

  const K = Math.ceil(H / 7);
  const shares = (history: History) =>
    Array.from({ length: K }, (_, k) => {
      const days = Math.min(7, H - 7 * k);
      const out = SHARE_CATEGORIES.map(() => 0);
      for (let d = 1; d <= days; d++) {
        const c = SHARE_CATEGORIES.indexOf(
          history.eventAt(addDays(asOf, 7 * k + d))?.category as (typeof SHARE_CATEGORIES)[number],
        );
        if (c >= 0) out[c] = (out[c] as number) + 1 / days;
      }
      return out;
    });
  const peersWeekly = (c: CampaignData, daily: (d: CampaignData) => number) =>
    7 *
    included
      .filter((d) => d !== c && d.kpi.field === c.kpi.field)
      .reduce((s, d) => s + daily(d), 0);

  const plans: Plan[] = [];
  const fits = new Map<string, CurveFit>();
  const out = included.map((c) => {
    const plan = planned(c);
    const weeks = weeksOf(c.history, c.kpi.field, othersOf(all, c));
    const fit = fitCurve(weeks);
    const oneStep = fit ? validateResponse(weeks, body.seed) : null;
    const extremes = fit ? validateExtremes(weeks, body.seed) : null;
    const range = fit && extremes ? validatedRange(fit, weeks, extremes) : null;
    const exp = conclusive.find((e) => e.row.campaignMetaId === c.id) ?? null;
    const reasons: string[] = [];
    let status: 'published' | 'not_published' | 'insufficient_data' = 'published';
    const eventsSum = weeks.reduce((s, w) => s + w.events, 0);
    const money = (v: number) => `${v.toFixed(2)} ${account.currency}`;
    if (!fit) {
      status = 'insufficient_data';
      reasons.push(
        `Hay ${weeks.length} semanas con gasto y ${Math.round(eventsSum)} ${c.kpi.label} utilizables; la curva exige ${RESPONSE.minWeeks} semanas y ${RESPONSE.minEvents} eventos.`,
      );
    } else if (!oneStep || oneStep.evaluated < RESPONSE.minValidated) {
      status = 'insufficient_data';
      reasons.push(
        `Solo ${oneStep?.evaluated ?? 0} semanas para validar la curva (mínimo ${RESPONSE.minValidated}: hacen falta ${RESPONSE.minWeeks + RESPONSE.minValidated} semanas con gasto).`,
      );
    } else if (oneStep.coverage === null || !coverageOk(oneStep.coverage, oneStep.evaluated)) {
      status = 'not_published';
      reasons.push(
        `La validación de un paso no está calibrada: cobertura del 80 % de ${Math.round((oneStep.coverage ?? 0) * 100)} % en ${oneStep.evaluated} semanas (aceptable entre 70 % y 90 %, más un error típico por el tamaño de la muestra).`,
      );
    } else if (
      range &&
      plan > 0 &&
      Math.abs(plan - c.current) > 1e-9 &&
      (7 * plan < range.min || 7 * plan > range.max)
    ) {
      status = 'not_published';
      reasons.push(
        `El plan (${money(plan)}/día) está fuera del rango validado (${money(range.min / 7)} a ${money(range.max / 7)}/día)${range.reliableShape ? '' : ', que se limita al rango intercuartílico porque la curva no superó la validación de extremos'}. Un experimento de presupuesto con ese nivel ampliaría el rango.`,
      );
    }
    if (c.history.pausedAtEnd && plan > 0)
      reasons.push(
        'Reactivación tras una pausa: la curva viene de antes y la fase de aprendizaje puede reiniciarse.',
      );
    if (fit) fits.set(c.id, fit);
    if (fit && status === 'published')
      plans.push({
        id: c.id,
        group: c.kpi.field,
        fit,
        currentDaily: c.current,
        plannedDaily: plan,
        othersCurrent: peersWeekly(c, (d) => d.current),
        othersPlanned: peersWeekly(c, planned),
        experiment: exp?.result.elasticity
          ? { mean: exp.result.elasticity.point, se: exp.result.elasticity.se }
          : null,
        shares: shares(c.history),
      });
    const anchor = c.current > 0 ? 7 * c.current : fit ? Math.exp(fit.xMean) : 1;
    const observed = fit ? localElasticity(fit, anchor) : null;
    const causal =
      observed &&
      causalElasticity(
        observed,
        confounding.sd,
        exp?.result.elasticity
          ? { mean: exp.result.elasticity.point, se: exp.result.elasticity.se }
          : null,
      );
    const sdOf = (f: CurveFit, i: number) => Math.sqrt((f.cov[i] as number[])[i] as number);
    return {
      id: c.id,
      name: c.name,
      effectiveStatus: c.effectiveStatus,
      profile: c.profile,
      profileLabel: PROFILES[c.profile],
      kpi: {
        field: c.kpi.field,
        label: c.kpi.label,
        costLabel: c.kpi.costLabel,
        scale: c.kpi.scale,
      },
      currentDailySpend: c.current,
      plannedDailySpend: plan,
      status,
      reasons,
      curve:
        fit && observed && causal
          ? {
              weeks: fit.weeks,
              events: fit.events,
              elasticity: band(observed.mean, observed.sd),
              learned: learned(fit, 1, RESPONSE.priors.elasticity.sd),
              causal: {
                ...band(causal.mean, causal.sd),
                source: causal.source,
              },
              curvature: band(fit.theta[2] as number, sdOf(fit, 2)),
              spillover: fit.hasOthers ? band(fit.theta[4] as number, sdOf(fit, 4)) : null,
              trend: band(fit.theta[3] as number, sdOf(fit, 3)),
              phi: fit.phi,
              shockSd: fit.shockSd,
              spendRange: fit.spendRange,
            }
          : null,
      validation:
        oneStep && extremes
          ? {
              oneStep: {
                evaluated: oneStep.evaluated,
                coverage: oneStep.coverage,
                relMae: oneStep.relMae,
              },
              extremes,
            }
          : null,
      validatedRange: range
        ? { minDaily: range.min / 7, maxDaily: range.max / 7, reliableShape: range.reliableShape }
        : null,
      experiment: (() => {
        const e = experiments.find((x) => x.row.campaignMetaId === c.id);
        return e ? { id: e.row.id, startDate: e.row.startDate, result: resultDto(e.result) } : null;
      })(),
    };
  });

  const sim = simulatePlans(plans, H, { seed: body.seed, biasSd: confounding.sd });
  const scaled = (
    cost: { p10: number | null; p50: number | null; p90: number | null },
    s: number,
  ) => ({
    p10: cost.p10 === null ? null : cost.p10 * s,
    p50: cost.p50 === null ? null : cost.p50 * s,
    p90: cost.p90 === null ? null : cost.p90 * s,
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
    campaigns: out.map(({ kpi: { scale, ...kpi }, ...c }) => {
      const o = sim.outcomes.find((x) => x.id === c.id);
      return { ...c, kpi, outcome: o ? { ...o, cost: scaled(o.cost, scale) } : null };
    }),
    totals: sim.totals.map((t) => {
      const c = out.find((x) => x.kpi.field === t.group);
      const groupPlans = plans.filter((p) => p.group === t.group);
      return {
        field: t.group,
        label: c?.kpi.label ?? t.group,
        costLabel: c?.kpi.costLabel ?? '',
        campaigns: groupPlans.length,
        spend: t.spend,
        events: t.events,
        cost: scaled(t.cost, c?.kpi.scale ?? 1),
        probNoEvents: t.probNoEvents,
        expectedChange: t.expectedChange,
        correlation: shockCorrelation(groupPlans.map((p) => p.fit)),
      };
    }),
    spend: {
      current: out.reduce((s, c) => s + c.currentDailySpend * H, 0),
      planned: out.reduce((s, c) => s + c.plannedDailySpend * H, 0),
      notSimulated: out
        .filter((c) => c.status !== 'published')
        .reduce((s, c) => s + c.plannedDailySpend * H, 0),
    },
    priors: RESPONSE.priors,
    confounding: {
      sd: confounding.sd,
      source: confounding.source,
      experiments: confounding.n,
    },
    assumptions: SIMULATION_CARD.assumptions,
    limitations: SIMULATION_CARD.limitations,
    inputHash: hash({
      version: SIMULATION_VERSION,
      body: { ...body, asOf },
      gap,
      experiments: experiments.map((e) => e.row.id),
      data: all.map((c) => [c.id, [...c.byDate.values()]]),
    }),
  };
}

// --- Diseño de experimentos

async function designFor(
  tx: Tx,
  ctx: TenantContext,
  body: z.infer<typeof ExperimentBody>,
): Promise<{ preview: z.infer<typeof ExperimentPreviewDto>; accountId: string }> {
  const account = await findAccount(tx, ctx, body.adAccountId);
  const { asOf, cut } = await observedWindow(tx, account);
  if (body.startDate <= addDays(asOf, 1))
    throw badRequest('El experimento debe empezar después de hoy (día local de la cuenta).');
  const events = calendarEvents(addDays(asOf, -HISTORY_DAYS), addDays(asOf, 7));
  const all = await accountCampaigns(tx, account.id, asOf, cut, events);
  const c = all.find((x) => x.id === body.campaignId);
  if (!c) throw badRequest(`La campaña ${body.campaignId} no es de esta cuenta`);
  const base = body.baseDailySpend ?? c.current;
  if (!(base > 0))
    throw badRequest(
      'La campaña no gasta: indica un gasto diario de referencia para el experimento.',
    );
  const seed = body.seed ?? randomInt(2_147_483_647);
  const schedule = designExperiment({
    start: body.startDate,
    levels: body.levels,
    blocks: body.blocks,
    seed,
  });
  const others = othersOf(all, c);
  const fit = fitCurve(weeksOf(c.history, c.kpi.field, others));
  const othersWeekly =
    7 *
    all.filter((d) => d !== c && d.kpi.field === c.kpi.field).reduce((s, d) => s + d.current, 0);
  const power = fit
    ? experimentPower({
        weeklyEvents: expectedWeekly(fit, 7 * base, othersWeekly),
        shockSd: fit.shockSd,
        levels: body.levels,
        blocks: body.blocks,
        burnInDays: body.burnInDays,
      })
    : null;
  const warnings: string[] = [];
  if (body.levels.some((m) => m < 0.7 || m > 1.5))
    warnings.push(
      'Cambios de más de −30 % o +50 % pueden reiniciar la fase de aprendizaje de Meta: los días de transición lo amortiguan, pero conviene niveles moderados.',
    );
  if (!power)
    warnings.push(
      'Sin curva de respuesta todavía: no se puede estimar la potencia. El experimento sigue siendo válido.',
    );
  else if (power.se > 0.25)
    warnings.push(
      `Potencia baja: la elasticidad saldría con un error típico de ±${power.se.toFixed(2)}. Amplía los niveles o los bloques.`,
    );
  return {
    accountId: account.id,
    preview: {
      campaignId: c.id,
      campaignName: c.name,
      kpi: { field: c.kpi.field, label: c.kpi.label },
      baseDailySpend: base,
      burnInDays: body.burnInDays,
      seed,
      schedule: schedule.map((p) => ({ ...p, dailySpend: base * p.multiplier })),
      power,
      observed: fit ? localElasticity(fit, 7 * base) : null,
      warnings,
    },
  };
}

export async function forecastingRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST porque lleva cuerpo (calendario y plan); no modifica nada.
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

  app.get(
    '/v1/budget-experiments',
    {
      config: { access: { permission: 'insights:read' } },
      schema: { querystring: ExperimentListQuery, response: { 200: z.array(ExperimentDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const account = await findAccount(tx, ctx, request.query.adAccountId);
        const { asOf, cut } = await observedWindow(tx, account);
        const rows = await tx
          .select()
          .from(budgetExperiments)
          .where(eq(budgetExperiments.adAccountId, account.id))
          .orderBy(desc(budgetExperiments.createdAt));
        if (!rows.length) return [];
        const all = await accountCampaigns(tx, account.id, asOf, cut, []);
        return rows.map((e) =>
          experimentDto(
            e,
            all.find((c) => c.id === e.campaignMetaId),
            asOf,
            cut,
          ),
        );
      });
    },
  );

  app.post(
    '/v1/budget-experiments/preview',
    {
      config: { access: { permission: 'insights:read' } },
      schema: { body: ExperimentBody, response: { 200: ExperimentPreviewDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => (await designFor(tx, ctx, request.body)).preview);
    },
  );

  app.post(
    '/v1/budget-experiments',
    {
      config: { access: { permission: 'experiments:manage' } },
      schema: { body: ExperimentBody, response: { 200: ExperimentDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const { preview, accountId } = await designFor(tx, ctx, request.body);
        const end = preview.schedule.at(-1)?.until ?? request.body.startDate;
        const clash = (await activeExperiments(tx, accountId)).find(
          (e) =>
            e.campaignMetaId === preview.campaignId &&
            e.startDate <= end &&
            ((e.schedule as ExperimentPeriod[]).at(-1)?.until ?? e.startDate) >=
              request.body.startDate,
        );
        if (clash)
          throw conflict('Ya hay un experimento planificado para esta campaña en esas fechas.');
        const row = first(
          await tx
            .insert(budgetExperiments)
            .values({
              tenantId: ctx.tenantId,
              adAccountId: accountId,
              campaignMetaId: preview.campaignId,
              kpiField: preview.kpi.field,
              startDate: request.body.startDate,
              burnInDays: preview.burnInDays,
              baseDailySpend: String(preview.baseDailySpend),
              levels: request.body.levels,
              schedule: preview.schedule.map(({ dailySpend: _, ...p }) => p),
              seed: preview.seed,
              observed: preview.observed,
              power: preview.power,
              createdBy: ctx.userId,
            })
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'budget_experiment.created',
          targetType: 'campaign',
          targetId: preview.campaignId,
          after: {
            experimentId: row.id,
            startDate: row.startDate,
            levels: request.body.levels,
            blocks: request.body.blocks,
            seed: preview.seed,
          },
        });
        const account = await findAccount(tx, ctx, accountId);
        const { asOf, cut } = await observedWindow(tx, account);
        return { ...experimentDto(row, undefined, asOf, cut), ...preview, id: row.id };
      });
    },
  );

  app.post(
    '/v1/budget-experiments/:id/cancel',
    {
      config: { access: { permission: 'experiments:manage' } },
      schema: { params: IdParams, response: { 200: ExperimentDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const [e] = await tx
          .select()
          .from(budgetExperiments)
          .where(eq(budgetExperiments.id, request.params.id));
        if (!e) throw notFound('Experimento');
        const account = await findAccount(tx, ctx, e.adAccountId); // alcance por cliente
        if (e.status === 'cancelled') throw conflict('El experimento ya está cancelado.');
        const row = first(
          await tx
            .update(budgetExperiments)
            .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId })
            .where(eq(budgetExperiments.id, e.id))
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'budget_experiment.cancelled',
          targetType: 'campaign',
          targetId: e.campaignMetaId,
          after: { experimentId: e.id },
        });
        const { asOf, cut } = await observedWindow(tx, account);
        return experimentDto(row, undefined, asOf, cut);
      });
    },
  );
}

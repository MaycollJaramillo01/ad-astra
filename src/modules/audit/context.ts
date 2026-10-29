import { addDays } from '../insights/catalog.ts';
import {
  type AuditConfig,
  type AuditInput,
  type AuditLevel,
  CONVERSION_PROFILES,
  type Day,
  type EntityInput,
  type KpiEvent,
  kpiOf,
  type Profile,
  profileOf,
} from './model.ts';
import { coefficientOfVariation, median } from './stats.ts';

// Contexto de evaluación de cada entidad: ventanas, sumas, referencias (con su origen) y los
// benchmarks internos de la cuenta. Las reglas y la salud solo leen de aquí.

export interface Window {
  since: string;
  until: string;
}

export interface Windows {
  /** Días evaluados. */
  evaluation: Window;
  /** Días de la evaluación cuyas conversiones ya maduraron. */
  mature: Window;
  /** Línea base propia: los días anteriores a la evaluación. */
  baseline: Window;
  /** Estabilidad y anomalías. */
  stability: Window;
  /** Últimos días para la entrega. */
  delivery: Window;
  /** La semana anterior a la evaluación (para comparar mitades en la fatiga). */
  previous: Window;
}

export function windowsFor(asOf: string, cfg: AuditConfig['windows']): Windows {
  const evaluation = { since: addDays(asOf, -(cfg.evaluationDays - 1)), until: asOf };
  return {
    evaluation,
    mature: { since: evaluation.since, until: addDays(asOf, -cfg.maturityDays) },
    baseline: {
      since: addDays(evaluation.since, -cfg.baselineDays),
      until: addDays(evaluation.since, -1),
    },
    stability: { since: addDays(asOf, -(cfg.stabilityDays - 1)), until: asOf },
    delivery: { since: addDays(asOf, -(cfg.deliveryDays - 1)), until: asOf },
    previous: {
      since: addDays(evaluation.since, -cfg.evaluationDays),
      until: addDays(evaluation.since, -1),
    },
  };
}

const SUMMED = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'inlineLinkClicks',
  'outboundClicks',
  'results',
  'leads',
  'purchases',
  'purchaseValue',
  'messagingConversations',
  'appInstalls',
  'landingPageViews',
  'thruplays',
] as const;
export type Sums = Record<(typeof SUMMED)[number], number> & { days: number; activeDays: number };

export const inWindow = (d: Day, w: Window) => d.date >= w.since && d.date <= w.until;

export function sumDays(days: Day[], w: Window): Sums {
  const s = Object.fromEntries(SUMMED.map((k) => [k, 0])) as Sums;
  s.days = 0;
  s.activeDays = 0;
  for (const d of days) {
    if (!inWindow(d, w)) continue;
    for (const k of SUMMED) s[k] += d[k];
    s.days++;
    if (d.impressions > 0) s.activeDays++;
  }
  return s;
}

export const daysIn = (w: Window) =>
  Math.round((Date.parse(w.until) - Date.parse(w.since)) / 86_400_000) + 1;

export type ReferenceSource = 'target' | 'baseline' | 'account_median';
export const SOURCE_LABEL: Record<ReferenceSource, string> = {
  target: 'objetivo del cliente',
  baseline: 'línea base propia',
  account_median: 'mediana de la cuenta para el mismo perfil',
};
export interface Reference {
  value: number;
  source: ReferenceSource;
  /** Tamaño de la muestra que respalda la referencia (eventos o entidades). */
  n: number;
}

export interface EntityContext {
  level: AuditLevel;
  id: string;
  name: string;
  entity: EntityInput | null;
  profile: Profile;
  kpi: KpiEvent;
  conversion: boolean;
  days: Day[];
  /** Activa en Meta (ella y sus padres). */
  active: boolean;
  /** Apagada (pausada, archivada o borrada), ella o un padre: no es de lo que se gestiona hoy. */
  off: boolean;
  cur: Sums;
  /** Para las conversiones: solo los días maduros de la evaluación. */
  mature: Sums;
  base: Sums;
  prev: Sums;
  stability: Sums;
  delivery: Sums;
  costRef: Reference | null;
  roasRef: Reference | null;
  cvrRef: Reference | null;
  /** Coeficiente de variación del costo diario, corregido por el ruido de Poisson. */
  cv: { value: number; days: number } | null;
  cvBenchmark: number | null;
  attribution: string[];
  campaign: EntityInput | null;
  adset: EntityInput | null;
}

export const eventsOf = (s: Sums, kpi: KpiEvent) => s[kpi.field as keyof Sums] as number;

/** Mínimo de eventos de la línea base para usarla como referencia. */
export const MIN_BASELINE = { events: 5, impressions: 1000, clicks: 100 };

/**
 * Estados "apagados": alguien pausó o archivó la entidad (o un padre), o Meta ya no la lista.
 * No son parte de lo que se gestiona hoy, a diferencia de un problema de entrega sobre algo
 * encendido (DISAPPROVED, WITH_ISSUES, PENDING_BILLING_INFO), que sí es un hallazgo actual.
 */
const OFF_STATUSES = new Set(['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED']);

/** CV del costo diario por evento sin el ruido esperado de Poisson: √max(0, CV² − 1/media). */
function dailyCostCv(
  days: Day[],
  w: Window,
  kpi: KpiEvent,
): { value: number; days: number } | null {
  const costs: number[] = [];
  let events = 0;
  for (const d of days) {
    const e = d[kpi.field as keyof Day] as number;
    if (!inWindow(d, w) || e < (kpi.field === 'impressions' ? 100 : 1)) continue;
    costs.push(d.spend / e);
    events += e;
  }
  const cv = coefficientOfVariation(costs);
  if (cv === null) return null;
  const meanEvents = events / costs.length;
  return { value: Math.sqrt(Math.max(0, cv * cv - 1 / meanEvents)), days: costs.length };
}

/** Construye el contexto de todas las entidades y los benchmarks internos de la cuenta. */
export function buildContexts(input: AuditInput, config: AuditConfig) {
  const win = windowsFor(input.asOf, config.windows);
  const byId = new Map(input.entities.map((e) => [`${e.level}:${e.id}`, e]));
  const campaignOf = (e: EntityInput) =>
    e.campaignId ? (byId.get(`campaign:${e.campaignId}`) ?? null) : null;
  const adsetOf = (e: EntityInput) =>
    e.level === 'ad' && e.parentId ? (byId.get(`adset:${e.parentId}`) ?? null) : null;

  const resultTypes = (days: Day[]) => [
    ...new Set(days.map((d) => d.resultIndicator).filter((t): t is string => !!t)),
  ];
  const profileFor = (e: EntityInput): Profile => {
    const adset = e.level === 'adset' ? e : adsetOf(e);
    const campaign = e.level === 'campaign' ? e : campaignOf(e);
    return profileOf({
      optimizationGoal: adset?.optimizationGoal,
      promotedEvent: adset?.promotedEvent,
      objective: campaign?.objective ?? e.objective,
      resultTypes: resultTypes(e.days),
    });
  };

  const base = (
    level: AuditLevel,
    id: string,
    name: string,
    entity: EntityInput | null,
    profile: Profile,
    days: Day[],
  ) => {
    const kpi = kpiOf(profile, { hasLandingPageViews: days.some((d) => d.landingPageViews > 0) });
    const conversion = CONVERSION_PROFILES.includes(profile);
    const campaign = entity ? (entity.level === 'campaign' ? entity : campaignOf(entity)) : null;
    const adset = entity ? (entity.level === 'adset' ? entity : adsetOf(entity)) : null;
    const isActive = (x: EntityInput | null) => !x || (x.status === 'ACTIVE' && !x.deleted);
    const isOff = (x: EntityInput | null) => !!x && (x.deleted || OFF_STATUSES.has(x.status ?? ''));
    return {
      level,
      id,
      name,
      entity,
      profile,
      kpi,
      conversion,
      days,
      active: entity ? isActive(entity) && isActive(campaign) && isActive(adset) : true,
      off: entity ? isOff(entity) || isOff(campaign) || isOff(adset) : false,
      cur: sumDays(days, win.evaluation),
      mature: sumDays(days, conversion ? win.mature : win.evaluation),
      base: sumDays(days, win.baseline),
      prev: sumDays(days, win.previous),
      stability: sumDays(days, win.stability),
      delivery: sumDays(days, win.delivery),
      cv: dailyCostCv(days, win.stability, kpi),
      attribution: [
        ...new Set(
          days
            .filter((d) => inWindow(d, win.evaluation))
            .map((d) => d.attribution)
            .filter((a): a is string => !!a),
        ),
      ].sort(),
      campaign,
      adset,
      costRef: null,
      roasRef: null,
      cvrRef: null,
      cvBenchmark: null,
    } satisfies EntityContext;
  };

  const sorted = [...input.entities].sort((a, b) =>
    `${a.level}:${a.id}`.localeCompare(`${b.level}:${b.id}`),
  );
  const contexts: EntityContext[] = sorted.map((e) =>
    base(e.level, e.id, e.name, e, profileFor(e), e.days),
  );

  // Benchmarks internos: medianas de la línea base de las entidades del mismo nivel y perfil.
  const groups = new Map<string, EntityContext[]>();
  for (const c of contexts)
    groups.set(`${c.level}:${c.profile}`, [...(groups.get(`${c.level}:${c.profile}`) ?? []), c]);
  const benchmark = (list: EntityContext[], pick: (c: EntityContext) => number | null) => {
    const values = list.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
    return values.length >= 3 ? { value: median(values) as number, n: values.length } : null;
  };
  const minEvents = (c: EntityContext) =>
    c.kpi.field === 'impressions' ? MIN_BASELINE.impressions : MIN_BASELINE.events;
  const benchmarks = new Map<
    string,
    {
      cost: ReturnType<typeof benchmark>;
      roas: ReturnType<typeof benchmark>;
      cvr: ReturnType<typeof benchmark>;
      cv: ReturnType<typeof benchmark>;
    }
  >();
  for (const [key, list] of groups) {
    benchmarks.set(key, {
      cost: benchmark(list, (c) =>
        eventsOf(c.base, c.kpi) >= minEvents(c) ? c.base.spend / eventsOf(c.base, c.kpi) : null,
      ),
      roas: benchmark(list, (c) =>
        c.base.purchases >= MIN_BASELINE.events && c.base.spend > 0
          ? c.base.purchaseValue / c.base.spend
          : null,
      ),
      cvr: benchmark(list, (c) =>
        c.base.inlineLinkClicks >= MIN_BASELINE.clicks &&
        eventsOf(c.base, c.kpi) >= MIN_BASELINE.events
          ? eventsOf(c.base, c.kpi) / c.base.inlineLinkClicks
          : null,
      ),
      cv: benchmark(list, (c) => (c.cv && c.cv.days >= 7 ? c.cv.value : null)),
    });
  }

  // Referencias: objetivo del cliente → línea base propia → mediana de la cuenta.
  for (const c of contexts) {
    const bm = benchmarks.get(`${c.level}:${c.profile}`);
    const target = config.targets.find(
      (t) => t.profile === c.profile && t.currency === input.account.currency,
    );
    const baseEvents = eventsOf(c.base, c.kpi);
    if (target?.costPerEvent)
      c.costRef = { value: target.costPerEvent / c.kpi.scale, source: 'target', n: 0 };
    else if (baseEvents >= minEvents(c) && c.base.spend > 0)
      c.costRef = { value: c.base.spend / baseEvents, source: 'baseline', n: baseEvents };
    else if (bm?.cost) c.costRef = { value: bm.cost.value, source: 'account_median', n: bm.cost.n };

    if (target?.roas) c.roasRef = { value: target.roas, source: 'target', n: 0 };
    else if (c.base.purchases >= MIN_BASELINE.events && c.base.spend > 0)
      c.roasRef = {
        value: c.base.purchaseValue / c.base.spend,
        source: 'baseline',
        n: c.base.purchases,
      };
    else if (bm?.roas) c.roasRef = { value: bm.roas.value, source: 'account_median', n: bm.roas.n };

    if (c.base.inlineLinkClicks >= MIN_BASELINE.clicks && baseEvents >= MIN_BASELINE.events)
      c.cvrRef = {
        value: baseEvents / c.base.inlineLinkClicks,
        source: 'baseline',
        n: c.base.inlineLinkClicks,
      };
    else if (bm?.cvr) c.cvrRef = { value: bm.cvr.value, source: 'account_median', n: bm.cvr.n };

    c.cvBenchmark = bm?.cv?.value ?? null;
  }

  const account = base(
    'account',
    input.account.metaAccountId,
    input.account.name,
    null,
    'other',
    input.accountDays,
  );
  const children = (parentLevel: AuditLevel, id: string) =>
    contexts.filter((c) =>
      parentLevel === 'campaign'
        ? c.level === 'adset' && c.entity?.campaignId === id
        : c.level === 'ad' && c.entity?.parentId === id,
    );
  return { win, contexts, account, children };
}

export type Built = ReturnType<typeof buildContexts>;

// --- Formato determinista para las explicaciones (sin depender del idioma del servidor)

export const money = (v: number, currency: string) => `${v.toFixed(2)} ${currency}`;
export const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)} %`;
export const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
export const costText = (c: EntityContext, perEvent: number, currency: string) =>
  money(perEvent * c.kpi.scale, currency);

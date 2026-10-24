import type { AuditInput, Day, EntityInput } from '../src/modules/audit/model.ts';
import { addDays } from '../src/modules/insights/catalog.ts';

// Datos SINTÉTICOS para el motor de auditoría: cuentas, campañas, conjuntos y anuncios con
// series diarias de parámetros conocidos. Todo determinista (sin Math.random).

export const AS_OF = '2026-10-20';

export function day(date: string, v: Partial<Day> = {}): Day {
  return {
    date,
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    inlineLinkClicks: 0,
    outboundClicks: 0,
    results: 0,
    resultIndicator: null,
    leads: 0,
    purchases: 0,
    purchaseValue: 0,
    messagingConversations: 0,
    appInstalls: 0,
    landingPageViews: 0,
    thruplays: 0,
    attribution: '7d_click_1d_view',
    ...v,
  };
}

/** `n` días que acaban en `asOf`; `fn` recibe el índice desde el final (0 = asOf) y la fecha. */
export function series(
  n: number,
  fn: (back: number, date: string) => Partial<Day> | null,
  asOf = AS_OF,
): Day[] {
  const out: Day[] = [];
  for (let back = n - 1; back >= 0; back--) {
    const date = addDays(asOf, -back);
    const v = fn(back, date);
    if (v) out.push(day(date, v));
  }
  return out;
}

/** Días de la evaluación (los 7 últimos) frente a la historia previa. */
export const inEvaluation = (back: number) => back < 7;
/** La semana anterior a la evaluación. */
export const inPreviousWeek = (back: number) => back >= 7 && back < 14;

export function entity(
  level: EntityInput['level'],
  id: string,
  v: Partial<EntityInput> = {},
): EntityInput {
  return {
    level,
    id,
    name: `${level} ${id}`,
    parentId: null,
    campaignId: level === 'campaign' ? id : null,
    status: 'ACTIVE',
    deleted: false,
    objective: null,
    optimizationGoal: null,
    promotedEvent: null,
    dailyBudget: null,
    lifetimeBudget: null,
    bidStrategy: null,
    bidAmount: null,
    learning: null,
    hasIssues: false,
    days: [],
    ...v,
  };
}

/**
 * Campaña de un perfil con un conjunto y un anuncio que reciben los mismos días (Meta suma igual
 * en los tres niveles). Los ids se derivan de `id`.
 */
export function stack(
  id: string,
  days: Day[],
  opts: {
    objective?: string;
    goal?: string;
    event?: string;
    adset?: Partial<EntityInput>;
    ad?: Partial<EntityInput>;
    campaign?: Partial<EntityInput>;
  } = {},
): EntityInput[] {
  const c = `${id}0`;
  const s = `${id}1`;
  const a = `${id}2`;
  return [
    entity('campaign', c, { objective: opts.objective ?? 'OUTCOME_LEADS', days, ...opts.campaign }),
    entity('adset', s, {
      parentId: c,
      campaignId: c,
      optimizationGoal: opts.goal ?? 'LEAD_GENERATION',
      promotedEvent: opts.event ?? null,
      days,
      ...opts.adset,
    }),
    entity('ad', a, { parentId: s, campaignId: c, days, ...opts.ad }),
  ];
}

export function auditInput(
  entities: EntityInput[],
  accountDays?: Day[],
  currency = 'USD',
): AuditInput {
  return {
    account: {
      id: 'acc-uuid',
      metaAccountId: 'act_1',
      name: 'Cuenta sintética',
      currency,
      timezone: 'America/Tegucigalpa',
      syncEnabled: true,
    },
    asOf: AS_OF,
    accountDays:
      accountDays ?? sumDays(entities.filter((e) => e.level === 'campaign').flatMap((e) => e.days)),
    entities,
  };
}

/** Suma por fecha (para el nivel de cuenta). */
export function sumDays(days: Day[]): Day[] {
  const byDate = new Map<string, Day>();
  for (const d of days) {
    const cur = byDate.get(d.date) ?? day(d.date, { attribution: d.attribution });
    for (const k of Object.keys(d) as Array<keyof Day>) {
      const v = d[k];
      if (typeof v === 'number') (cur[k] as number) += v;
    }
    byDate.set(d.date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Leads con un costo por lead dado: gasto diario y leads por día, con clics al 1 % y CVR coherente. */
export const leadsDay = (spend: number, leads: number, extra: Partial<Day> = {}): Partial<Day> => ({
  spend,
  impressions: spend * 100,
  reach: spend * 80,
  clicks: spend * 2,
  inlineLinkClicks: spend,
  leads,
  results: leads,
  resultIndicator: 'actions:lead',
  ...extra,
});

/** PRNG determinista (mulberry32) para las simulaciones. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Muestra de una Poisson (Knuth: válida para λ moderadas). */
export function poissonSample(lambda: number, rand: () => number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

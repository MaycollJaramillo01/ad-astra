import { createHash } from 'node:crypto';
import { SEVERITIES } from '../../domain.ts';
import type { MonitoringPolicy } from '../../monitoring-contracts.ts';
import { addDays } from '../insights/catalog.ts';

export const VERSION = 'monitoring-1';
export const severityRank = (s: string) => SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]);
export function canonical(x: unknown): string {
  if (x instanceof Date) return canonical(x.toJSON());
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x !== null && typeof x === 'object')
    return `{${Object.entries(x)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(x) ?? 'null';
}
export const hash = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');
export type Day = {
  date: string;
  spend: number | null;
  results: number | null;
  leads: number | null;
  purchases: number | null;
  attribution: string | null;
  indicator: string | null;
  flags: string[];
};
export type Entity = {
  level: string;
  id: string;
  name: string;
  family: string | null;
  parent: string | null;
  campaignId: string | null;
  days: Day[];
};
export type Signal = {
  ruleId: string;
  group: string;
  level: string;
  entityId: string;
  category: string;
  severity: (typeof SEVERITIES)[number];
  hit: boolean | null;
  observation: string;
  detail: unknown;
};
export function summarize(days: Day[], since: string, until: string) {
  const selected = days.filter((d) => d.date >= since && d.date <= until);
  const expected = Math.round((Date.parse(until) - Date.parse(since)) / 86400000) + 1;
  const valid =
    selected.length === expected && new Set(selected.map((d) => d.date)).size === expected;
  const total = (k: 'spend' | 'results' | 'leads' | 'purchases') =>
    valid && selected.every((d) => d[k] !== null && Number.isFinite(d[k]) && (d[k] ?? -1) >= 0)
      ? selected.reduce((s, d) => s + (d[k] ?? 0), 0)
      : null;
  const spend = total('spend');
  const signatures = [
    ...new Set(selected.map((d) => `${d.attribution ?? '?'}|${d.indicator ?? '?'}`)),
  ];
  const known = selected.every(
    (d) => d.attribution !== null && d.indicator !== null && !d.flags.length,
  );
  const signature = valid && known && signatures.length === 1 ? (signatures[0] ?? null) : null;
  const results = signature ? total('results') : null;
  const attributionStable =
    valid &&
    selected.every((d) => d.attribution !== null && !d.flags.length) &&
    new Set(selected.map((d) => d.attribution)).size === 1;
  return {
    since,
    until,
    expected,
    observed: selected.length,
    coverage: selected.length / expected,
    spend,
    results,
    leads: attributionStable ? total('leads') : null,
    purchases: attributionStable ? total('purchases') : null,
    cpr: spend !== null && results !== null && results > 0 ? spend / results : null,
    signature,
  };
}
export type Summary = ReturnType<typeof summarize>;
export function metricSignals(
  entities: Entity[],
  policy: MonitoringPolicy,
  asOf: string,
): Signal[] {
  const currentSince = addDays(asOf, 1 - policy.windowDays),
    baselineUntil = addDays(currentSince, -1),
    baselineSince = addDays(baselineUntil, 1 - policy.baselineDays);
  return entities
    .filter((e) => e.level === 'campaign')
    .flatMap((e) => {
      const recent = summarize(e.days, currentSince, asOf),
        baseline = summarize(e.days, baselineSince, baselineUntil);
      return policy.rules
        .filter(
          (r) =>
            r.enabled && ['cpr_increase', 'results_drop', 'spend_without_results'].includes(r.kind),
        )
        .map((r): Signal => {
          let hit: boolean | null = null;
          if (recent.spend !== null && recent.results !== null && recent.signature) {
            if (r.kind === 'spend_without_results')
              hit = recent.spend >= Math.max(r.threshold, r.minSpend) && recent.results === 0;
            else if (
              baseline.signature === recent.signature &&
              baseline.results !== null &&
              baseline.results >= r.minResults &&
              baseline.spend !== null &&
              baseline.spend >= r.minSpend
            ) {
              if (r.kind === 'results_drop')
                hit =
                  recent.spend >= r.minSpend &&
                  recent.results / policy.windowDays <=
                    (baseline.results / policy.baselineDays) * (1 - r.threshold / 100);
              if (
                r.kind === 'cpr_increase' &&
                baseline.cpr !== null &&
                recent.results >= r.minResults &&
                recent.cpr !== null &&
                baseline.cpr > 0
              )
                hit =
                  recent.spend >= r.minSpend &&
                  recent.cpr >= baseline.cpr * (1 + r.threshold / 100);
            }
          }
          return {
            ruleId: r.id,
            group: `performance:campaign:${e.id}`,
            level: e.level,
            entityId: e.id,
            category: 'performance',
            severity: r.severity,
            hit,
            observation: asOf,
            detail: {
              kind: r.kind,
              recent,
              baseline,
              threshold: r.threshold,
              interpretation:
                'Condición descriptiva; no es una prueba de causalidad ni de significación.',
            },
          };
        });
    });
}

export type FollowupPlan = {
  version: string;
  actionId: string;
  capturedAt: string;
  retrospective: boolean;
  actionDate: string;
  maturityDays: number;
  days: number;
  beforeSince: string;
  beforeUntil: string;
  afterSince: string;
  afterUntil: string;
  target: Entity;
  comparators: Entity[];
  flags: string[];
  externalEvents: MonitoringPolicy['externalEvents'];
};
export function buildPlan(
  action: { id: string; entityLevel: string; entityMetaId: string; dispatchAt: Date | null },
  entities: Entity[],
  p: MonitoringPolicy,
  now: Date,
  timezoneDate: string,
): FollowupPlan {
  const date = timezoneDate,
    afterSince = addDays(date, 1),
    afterUntil = addDays(date, p.followupDays),
    beforeSince = addDays(afterSince, -7 * Math.ceil((p.followupDays + 1 + p.maturityDays) / 7)),
    beforeUntil = addDays(beforeSince, p.followupDays - 1);
  const found = entities.find(
      (e) => e.level === action.entityLevel && e.id === action.entityMetaId,
    ),
    target = found ?? {
      level: action.entityLevel,
      id: action.entityMetaId,
      name: action.entityMetaId,
      family: null,
      parent: null,
      campaignId: null,
      days: [],
    };
  const freeze = (e: Entity): Entity => ({
      ...e,
      days: e.days
        .filter((d) => d.date >= beforeSince && d.date <= beforeUntil)
        .map((d) => ({ ...d, flags: [...d.flags] })),
    }),
    frozen = freeze(target),
    baseline = summarize(frozen.days, beforeSince, beforeUntil),
    baselineSpend = baseline.spend ?? 0;
  const comparators =
    baseline.signature && baseline.spend !== null && baseline.spend > 0 && target.family
      ? entities
          .filter(
            (e) =>
              e.level === target.level &&
              e.id !== target.id &&
              e.family === target.family &&
              e.campaignId !== target.campaignId,
          )
          .map(freeze)
          .map((e) => ({ e, s: summarize(e.days, beforeSince, beforeUntil) }))
          .filter(
            ({ s }) =>
              s.signature === baseline.signature &&
              s.spend !== null &&
              s.spend / baselineSpend >= 0.5 &&
              s.spend / baselineSpend <= 2,
          )
          .sort(
            (a, b) =>
              Math.abs(Math.log((a.s.spend ?? 0) / baselineSpend)) -
                Math.abs(Math.log((b.s.spend ?? 0) / baselineSpend)) ||
              a.e.id.localeCompare(b.e.id),
          )
          .slice(0, 3)
          .map(({ e }) => e)
      : [];
  const flags = [
    'Selección observacional: objetivo y gasto similares no garantizan grupos equivalentes.',
    'Pueden existir estacionalidad, cambios de mercado, competencia y contagio entre campañas no observados.',
  ];
  if (!baseline.signature)
    flags.push('Baseline incompleto, atribución/KPI desconocidos o cambiantes, o datos marcados.');
  if (!comparators.length)
    flags.push('Sin comparador admisible; solo descripción antes y después.');
  if (action.dispatchAt)
    flags.push('Captura retrospectiva: no existe baseline registrado antes del envío.');
  flags.push(
    `Ventanas de ${p.followupDays} días con los mismos días de la semana; baseline separado para maduración y día de envío excluido.`,
  );
  return {
    version: VERSION,
    actionId: action.id,
    capturedAt: now.toISOString(),
    retrospective: !!action.dispatchAt,
    actionDate: date,
    maturityDays: p.maturityDays,
    days: p.followupDays,
    beforeSince,
    beforeUntil,
    afterSince,
    afterUntil,
    target: frozen,
    comparators,
    flags,
    externalEvents: structuredClone(p.externalEvents),
  };
}
export function evaluatePlan(
  plan: FollowupPlan,
  entities: Entity[],
  matureAsOf: string,
  concurrent: string[],
  externalEvents: MonitoringPolicy['externalEvents'],
) {
  const evaluate = (e: Entity) => {
    const before = summarize(e.days, plan.beforeSince, plan.beforeUntil),
      live = entities.find((x) => x.id === e.id && x.level === e.level),
      after = summarize(live?.days ?? [], plan.afterSince, plan.afterUntil);
    const eligible =
      !plan.retrospective &&
      matureAsOf >= plan.afterUntil &&
      e.family !== null &&
      live?.family === e.family &&
      before.signature !== null &&
      before.signature === after.signature;
    return {
      id: e.id,
      name: e.name,
      before,
      after,
      comparable: eligible,
      delta:
        eligible && before.results !== null && after.results !== null
          ? {
              results: after.results - before.results,
              spend:
                after.spend !== null && before.spend !== null ? after.spend - before.spend : null,
              cpr: after.cpr !== null && before.cpr !== null ? after.cpr - before.cpr : null,
            }
          : null,
      series:
        live?.days.filter((d) => d.date >= plan.afterSince && d.date <= plan.afterUntil) ?? [],
    };
  };
  const target = evaluate(plan.target),
    comparators = plan.comparators.map(evaluate),
    flags = [...plan.flags];
  if (matureAsOf < plan.afterUntil)
    flags.push('Ventana posterior pendiente o conversiones sin madurar.');
  if (!target.comparable)
    flags.push('No se compara el resultado objetivo: datos, KPI o atribución no compatibles.');
  if (comparators.some((e) => !e.comparable))
    flags.push(
      'Uno o más comparadores dejaron de ser comparables; se conservan sus IDs, sin sustitución posterior.',
    );
  if (concurrent.length)
    flags.push(
      `Acciones simultáneas en la cuenta: ${concurrent.join(', ')}. Posible confusión o contaminación.`,
    );
  const events = [...plan.externalEvents, ...externalEvents].filter(
    (e) => e.since <= plan.afterUntil && e.until >= plan.beforeSince,
  );
  for (const e of new Set(events.map((e) => `${e.label} (${e.since}–${e.until})`)))
    flags.push(`Evento declarado: ${e}.`);
  return {
    status:
      matureAsOf < plan.afterUntil ? 'waiting' : target.comparable ? 'observed' : 'insufficient',
    matureAsOf,
    target,
    comparators,
    flags,
    causal: false as const,
    interpretation:
      'Diferencias observadas; no se estima un efecto causal. No hay asignación aleatoria ni identificación de un contrafactual validado.',
  };
}

export const inQuietHours = (hour: number, start: number, end: number) =>
  start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../../db/client.ts';
import {
  adAccounts,
  ads,
  adsets,
  campaigns,
  clientConsents,
  clients,
  findings,
} from '../../db/schema.ts';
import type { TenantContext } from '../../platform/http.ts';
import { can, type Permission } from '../../platform/rbac.ts';
import { entityAudit, resolveEntity } from '../audit/engine.routes.ts';
import {
  accountStatus,
  attributionLabel,
  change,
  compute,
  DEFAULT_COLUMNS,
  deliveryStatus,
  METRIC_IDS,
  METRICS,
  type MetricContext,
  type MetricId,
  NODE_LEVELS,
  PRESET_IDS,
  resultLabel,
  type Totals,
} from '../insights/catalog.ts';
import { type Account, buildReport, type Report } from '../insights/report.ts';
import { clientScope } from '../tenancy/clients.routes.ts';
import { SUFFICIENCY, type SufficiencyStatus } from './answer.ts';

// Herramientas del asistente (docs/ARCHITECTURE.md §6.8). Todas de solo lectura: consultan los
// servicios de analítica y auditoría con el contexto del usuario (RLS del tenant y alcance por
// cliente) y solo sobre clientes con consentimiento `ai_processing`. Entradas y salidas se
// validan con zod; los textos que vienen de terceros (nombres de Meta) se limpian y, si parecen
// instrucciones, se retiran antes de llegar al modelo.

const Sufficiency = z.object({ status: z.enum(SUFFICIENCY), reasons: z.array(z.string()) });
type Sufficiency = z.infer<typeof Sufficiency>;
const suff = (status: SufficiencyStatus, reasons: string[] = []): Sufficiency => ({
  status,
  reasons,
});

export class ToolError extends Error {
  readonly code: 'consent' | 'not_found' | 'invalid' | 'forbidden';
  constructor(code: ToolError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ToolEnv {
  tx: Tx;
  ctx: TenantContext;
  /** Clientes con consentimiento `ai_processing` vigente. */
  consented: Set<string>;
  /** Textos retirados por posible inyección (van a la traza, nunca al modelo). */
  flags: string[];
}

// --- Texto no confiable

const INJECTION = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules?|above)\b/i,
  /\b(ignora|olvida|omite|desobedece|anula)\b.{0,40}\b(instrucci[oó]n(es)?|indicaciones|reglas|prompt|anterior)/i,
  /\b(system|developer)\s*(prompt|message|mode)\b/i,
  /\b(prompt|mensaje)\s+(de[l]?\s+)?sistema\b/i,
  /\b(you are now|act as|pretend to be|ahora eres|act[uú]a como|finge ser|haz de)\b/i,
  /<\/?\s*(system|assistant|user|tool|instructions?)\b/i,
  /\[\/?(inst|system)\]/i,
  /\b(new|nuevas?)\s+(instructions|instrucciones)\b/i,
  /\b(submit_answer|get_scope|get_metrics|get_findings|get_health|decompose_change)\b/i,
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|io|ai|xyz|ru)\/\S*/i,
];
export const WITHHELD = '[texto retirado: parecía contener instrucciones]';

/** Texto de terceros apto para el modelo: sin controles ni bidi, acotado y sin instrucciones. */
export function untrusted(value: string | null, flags: string[], max = 150): string | null {
  if (value === null) return null;
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (INJECTION.some((r) => r.test(clean))) {
    flags.push(clean);
    return WITHHELD;
  }
  return clean;
}

/** Recorre un JSON de la BD: textos como no confiables y números redondeados. */
function sanitize(value: unknown, flags: string[], depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof value === 'string') return untrusted(value, flags, 300);
  if (typeof value === 'number') return Number.isFinite(value) ? round(value, 4) : null;
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => sanitize(v, flags, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitize(v, flags, depth + 1)]),
    );
  return value;
}

// --- Utilidades

const round = (v: number | null, d = 2) => (v === null ? null : Number(v.toFixed(d)));
/** Valor tal como se muestra: los porcentajes ya multiplicados por 100. */
const shown = (id: MetricId, v: number | null) =>
  METRICS[id].unit === 'percent' ? round(v === null ? null : v * 100, 2) : round(v, 2);
const pct = (d: number | null) => round(d === null ? null : d * 100, 1);

export async function consentedClients(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({ clientId: clientConsents.clientId })
    .from(clientConsents)
    .where(
      and(isNull(clientConsents.revokedAt), sql`'ai_processing' = any(${clientConsents.scope})`),
    );
  return new Set(rows.map((r) => r.clientId));
}

const NO_CONSENT =
  'El cliente de esta entidad no ha dado consentimiento para el procesamiento con IA (ai_processing).';

/** Comprueba alcance y consentimiento del nodo. Devuelve la cuenta si el nodo es de cuenta o inferior. */
async function assertConsent(
  env: ToolEnv,
  level: (typeof NODE_LEVELS)[number],
  id: string | null,
): Promise<Account | null> {
  if (level === 'org') return null;
  if (!id) throw new ToolError('invalid', `Falta el id para el nivel ${level}`);
  if (level === 'client') {
    if (!env.consented.has(id)) {
      const [visible] = await env.tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, id), clientScope(env.tx, env.ctx, clients.id)));
      throw visible ? new ToolError('consent', NO_CONSENT) : notFoundError();
    }
    return null;
  }
  const { account } = await resolveEntity(env.tx, env.ctx, level, id).catch(() => {
    throw notFoundError();
  });
  if (!account.clientId || !env.consented.has(account.clientId))
    throw new ToolError('consent', NO_CONSENT);
  return account;
}
const notFoundError = () =>
  new ToolError('not_found', 'No existe o no está en tu alcance. Usa get_scope para ver los ids.');

const consentFilter = (env: ToolEnv) => (a: Account) =>
  a.clientId !== null && env.consented.has(a.clientId);

function sufficiencyOf(
  r: Report,
  prev: Totals | null,
  needsResults: boolean,
  excluded: number,
): Sufficiency {
  const reasons: string[] = [];
  const bad: string[] = [];
  const t = r.totals.current;
  if (r.freshness.accounts === 0) bad.push('no hay cuentas con datos en este alcance');
  else if (r.freshness.newestSyncAt === null) bad.push('las cuentas aún no se han sincronizado');
  if (!t.impressions && !t.spend) bad.push('sin entrega en el periodo');
  if ((t.impressions ?? 0) > 0 && (t.impressions ?? 0) < 1000)
    reasons.push('menos de 1.000 impresiones: los ratios son inestables');
  if (needsResults && (t.results ?? 0) < 10)
    reasons.push('menos de 10 resultados: los costos por resultado son inestables');
  if (r.totals.resultTypes.length > 1)
    reasons.push('varios tipos de resultado en el periodo: los resultados no se suman');
  if (r.range.until >= r.freshness.immatureFrom)
    reasons.push('incluye los últimos 7 días: pueden llegar conversiones atribuidas tarde');
  if (prev && !prev.impressions && !prev.spend)
    reasons.push('el periodo de comparación no tiene datos');
  const newest = r.freshness.newestSyncAt ? Date.parse(r.freshness.newestSyncAt) : null;
  if (newest !== null && Date.now() - newest > 36 * 3600_000)
    reasons.push('la última sincronización tiene más de 36 horas');
  if (r.currencies.length > 1)
    reasons.push(
      `solo se suma ${r.currency}; las cuentas en ${r.currencies
        .filter((c) => c.code !== r.currency)
        .map((c) => c.code)
        .join(', ')} quedan fuera`,
    );
  if (excluded > 0)
    reasons.push(`${excluded} cuenta(s) excluida(s) por no tener consentimiento de IA`);
  return {
    status: bad.length ? 'insufficient' : reasons.length ? 'limited' : 'sufficient',
    reasons: [...bad, ...reasons],
  };
}

// --- Definición de herramientas

const Level = z.enum(NODE_LEVELS);
const EntityLevel = z.enum(['account', 'campaign', 'adset', 'ad']);
const IsoDate = z.iso.date();
const Unit = z.enum(['currency', 'count', 'percent', 'decimal']);

interface Tool<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  description: string;
  /** CA-F4-02: el inventario no admite herramientas que escriban ni que llamen a Meta. */
  readOnly: true;
  permission: Permission;
  input: I;
  output: O;
  run(input: z.output<I>, env: ToolEnv): Promise<z.input<O>>;
}
const tool = <I extends z.ZodType, O extends z.ZodType>(t: Tool<I, O>) => t;
const withSufficiency = <T extends z.ZodType>(data: T) =>
  z.object({ sufficiency: Sufficiency, data });

// get_scope

const ScopeOutput = withSufficiency(
  z.object({
    clients: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        aiConsent: z.boolean(),
        accounts: z.array(
          z.object({
            id: z.string(),
            name: z.string().nullable(),
            currency: z.string(),
            timezone: z.string(),
            status: z.string(),
            syncEnabled: z.boolean(),
            lastSyncAt: z.string().nullable(),
          }),
        ),
      }),
    ),
    accountsWithoutClient: z.number(),
  }),
);

const getScope = tool({
  name: 'get_scope',
  description:
    'Clientes y cuentas publicitarias que el usuario puede consultar, con sus ids, moneda, zona horaria, estado y última sincronización. Solo los clientes con consentimiento de IA muestran sus cuentas. Úsala primero para encontrar los ids.',
  readOnly: true,
  permission: 'accounts:read',
  input: z.object({}),
  output: ScopeOutput,
  async run(_input, env) {
    const { tx, ctx, flags } = env;
    const visibleClients = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(clientScope(tx, ctx, clients.id))
      .orderBy(clients.name);
    const accounts = await tx
      .select()
      .from(adAccounts)
      .where(clientScope(tx, ctx, adAccounts.clientId))
      .orderBy(adAccounts.name);
    const list = visibleClients.map((c) => {
      const aiConsent = env.consented.has(c.id);
      return {
        id: c.id,
        name: untrusted(c.name, flags),
        aiConsent,
        accounts: aiConsent
          ? accounts
              .filter((a) => a.clientId === c.id)
              .map((a) => ({
                id: a.id,
                name: untrusted(a.name, flags),
                currency: a.currency,
                timezone: a.timezoneName,
                status: accountStatus(a.accountStatus).label,
                syncEnabled: a.syncEnabled,
                lastSyncAt: a.lastInsightsSyncAt?.toISOString() ?? null,
              }))
          : [],
      };
    });
    const usable = list.some((c) => c.accounts.length > 0);
    return {
      sufficiency: usable
        ? suff('sufficient')
        : suff('insufficient', [
            'ningún cliente visible tiene consentimiento de IA con cuentas asociadas',
          ]),
      data: {
        clients: list,
        accountsWithoutClient: accounts.filter((a) => a.clientId === null).length,
      },
    };
  },
});

// get_metrics

const PeriodInput = {
  preset: z
    .enum(PRESET_IDS)
    .nullable()
    .describe('Periodo predefinido (como en Meta); null si se dan since/until'),
  since: IsoDate.nullable().describe('Inicio AAAA-MM-DD (día local de la cuenta)'),
  until: IsoDate.nullable().describe('Fin AAAA-MM-DD, incluido'),
  compare: z
    .enum(['previous', 'year', 'custom', 'none'])
    .describe(
      'previous: periodo anterior de igual duración; year: mismo periodo del año anterior; custom: compareSince/compareUntil',
    ),
  compareSince: IsoDate.nullable(),
  compareUntil: IsoDate.nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .describe('Moneda a sumar si el alcance mezcla monedas; null = la de más gasto'),
};
const NodeInput = {
  level: Level,
  id: z
    .string()
    .max(64)
    .nullable()
    .describe(
      'Id del nodo (null para org): uuid de cliente o cuenta, o id de Meta de campaña, conjunto o anuncio',
    ),
};

const MetricsInput = z
  .object({
    ...NodeInput,
    ...PeriodInput,
    metrics: z
      .array(z.enum(METRIC_IDS as [MetricId, ...MetricId[]]))
      .max(12)
      .nullable()
      .describe('Métricas a devolver; null = las de la tabla por defecto'),
    breakdown: z
      .enum(['none', 'children', 'daily'])
      .describe('children: filas de los hijos del nodo (hasta 15, por gasto); daily: serie diaria'),
  })
  .refine((v) => (v.since === null) === (v.until === null), 'since y until van juntos')
  .refine((v) => !v.since || !v.until || v.since <= v.until, 'since debe ser anterior a until')
  .refine(
    (v) => v.compare !== 'custom' || (v.compareSince !== null && v.compareUntil !== null),
    'compare custom requiere compareSince y compareUntil',
  );

const MetricRow = z.object({
  id: z.string(),
  label: z.string(),
  unit: Unit,
  value: z.number().nullable(),
  previous: z.number().nullable(),
  delta: z.number().nullable(),
  changePct: z.number().nullable(),
  state: z.string(),
  note: z.string().nullable(),
});
const MetricsData = z.object({
  node: z.object({
    level: Level,
    id: z.string().nullable(),
    name: z.string().nullable(),
    status: z.string().nullable(),
    objective: z.string().nullable(),
    path: z.array(
      z.object({ level: Level, id: z.string().nullable(), name: z.string().nullable() }),
    ),
  }),
  period: z.object({ since: z.string(), until: z.string(), days: z.number() }),
  comparison: z.object({ since: z.string(), until: z.string(), mode: z.string() }).nullable(),
  currency: z.string().nullable(),
  timezones: z.array(z.string()),
  attribution: z.array(z.string()),
  resultTypes: z.array(z.string()),
  metrics: z.array(MetricRow),
  results: z.array(
    z.object({
      type: z.string(),
      current: z.number().nullable(),
      previous: z.number().nullable(),
      changePct: z.number().nullable(),
    }),
  ),
  children: z
    .object({
      level: z.string(),
      total: z.number(),
      rows: z.array(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          status: z.string().nullable(),
          metrics: z.record(z.string(), z.number().nullable()),
          changePct: z.record(z.string(), z.number().nullable()),
        }),
      ),
    })
    .nullable(),
  daily: z
    .array(z.object({ date: z.string(), metrics: z.record(z.string(), z.number().nullable()) }))
    .nullable(),
  freshness: z.object({
    dataUntil: z.string().nullable(),
    newestSyncAt: z.string().nullable(),
    oldestSyncAt: z.string().nullable(),
    immatureFrom: z.string(),
  }),
});

type MetricsInputT = z.output<typeof MetricsInput>;

interface Loaded {
  report: Report;
  prev: {
    range: { since: string; until: string };
    totals: Totals;
    resultTypes: string[];
    children: Map<string, Totals | null>;
    mode: string;
  } | null;
  excluded: number;
}

async function load(
  env: ToolEnv,
  input: Omit<MetricsInputT, 'metrics' | 'breakdown'>,
): Promise<Loaded> {
  await assertConsent(env, input.level, input.id);
  const filter = consentFilter(env);
  const base = {
    level: input.level,
    id: input.id ?? undefined,
    currency: input.currency ?? undefined,
    ...(input.since && input.until
      ? { since: input.since, until: input.until }
      : { preset: input.preset ?? ('last_7d' as const) }),
  };
  const compare = input.compare === 'custom' ? 'none' : input.compare;
  const report = await buildReport(env.tx, env.ctx, { ...base, compare }, filter);
  // Solo la cartera mezcla clientes con y sin consentimiento (un cliente se comprueba entero).
  const excluded =
    input.level === 'org'
      ? (
          await env.tx
            .select({ clientId: adAccounts.clientId })
            .from(adAccounts)
            .where(clientScope(env.tx, env.ctx, adAccounts.clientId))
        ).filter((a) => !a.clientId || !env.consented.has(a.clientId)).length
      : 0;
  let prev: Loaded['prev'] = null;
  if (report.compare && report.totals.previous) {
    prev = {
      range: { since: report.compare.since, until: report.compare.until },
      totals: report.totals.previous,
      resultTypes: report.totals.previousResultTypes,
      children: new Map(report.children?.rows.map((c) => [c.id, c.previous]) ?? []),
      mode: report.compare.mode,
    };
  } else if (input.compare === 'custom' && input.compareSince && input.compareUntil) {
    const p = await buildReport(
      env.tx,
      env.ctx,
      {
        ...base,
        preset: undefined,
        since: input.compareSince,
        until: input.compareUntil,
        compare: 'none',
        currency: report.currency ?? undefined,
      },
      filter,
    );
    prev = {
      range: { since: p.range.since, until: p.range.until },
      totals: p.totals.current,
      resultTypes: p.totals.resultTypes,
      children: new Map(p.children?.rows.map((c) => [c.id, c.current]) ?? []),
      mode: 'custom',
    };
  }
  return { report, prev, excluded };
}

function statusText(r: {
  statusKind: string;
  status: string | null;
  deleted: boolean;
  learning: string | null;
}) {
  if (r.statusKind === 'account') return accountStatus(r.status ? Number(r.status) : null).label;
  if (r.statusKind === 'client') return r.status;
  return deliveryStatus(r.status, { deleted: r.deleted, learning: r.learning }).label;
}

async function metricsOf(env: ToolEnv, input: MetricsInputT) {
  const { report: r, prev, excluded } = await load(env, input);
  const ids = input.metrics ?? DEFAULT_COLUMNS;
  const immature = (until: string) => until >= r.freshness.immatureFrom;
  const ctxOf = (
    sources: number,
    resultTypes: number,
    until: string,
    days: number,
  ): MetricContext => ({
    days,
    reachSources: sources,
    resultTypes,
    immature: immature(until),
  });
  const cur = ctxOf(r.totals.sources, r.totals.resultTypes.length, r.range.until, r.range.days);
  const prevCtx = prev
    ? ctxOf(r.totals.sources, prev.resultTypes.length, prev.range.until, r.range.days)
    : null;
  const metrics = ids.map((id) => {
    const c = compute(id, r.totals.current, cur);
    const p = prev && prevCtx ? compute(id, prev.totals, prevCtx) : null;
    const value = shown(id, c.value);
    const previous = p ? shown(id, p.value) : null;
    return {
      id,
      label: METRICS[id].label,
      unit: METRICS[id].unit,
      value,
      previous,
      delta: value !== null && previous !== null ? round(value - previous, 2) : null,
      changePct: p ? pct(change(c.value, p.value)) : null,
      state: c.state,
      note: c.reason ?? null,
    };
  });
  const flags = env.flags;
  let children: z.input<typeof MetricsData>['children'] = null;
  if (input.breakdown === 'children' && r.children) {
    const rows = [...r.children.rows].sort(
      (a, b) => (b.current.spend ?? 0) - (a.current.spend ?? 0),
    );
    children = {
      level: r.children.level,
      total: rows.length,
      rows: rows.slice(0, 15).map((row) => {
        const ctx = ctxOf(row.sources || 1, row.resultTypes.length, r.range.until, r.range.days);
        const before = prev?.children.get(row.id) ?? null;
        return {
          id: row.id,
          name: untrusted(row.name, flags),
          status: statusText(row),
          metrics: Object.fromEntries(
            ids.map((id) => [id, shown(id, compute(id, row.current, ctx).value)]),
          ),
          changePct: Object.fromEntries(
            ids.map((id) => [
              id,
              before
                ? pct(
                    change(
                      compute(id, row.current, ctx).value,
                      compute(id, before, {
                        ...ctx,
                        resultTypes: row.previousResultTypes.length,
                        immature: prev ? immature(prev.range.until) : false,
                      }).value,
                    ),
                  )
                : null,
            ]),
          ),
        };
      }),
    };
  }
  const daily =
    input.breakdown === 'daily'
      ? r.series.slice(-92).map((s) => {
          const ctx = ctxOf(r.totals.sources, r.totals.resultTypes.length, s.date, 1);
          return {
            date: s.date,
            metrics: Object.fromEntries(
              ids.map((id) => [id, shown(id, compute(id, s.current, ctx).value)]),
            ),
          };
        })
      : null;
  const needsResults = ids.some((id) => METRICS[id].conversion);
  return {
    report: r,
    prev,
    out: {
      sufficiency: sufficiencyOf(r, prev?.totals ?? null, needsResults, excluded),
      data: {
        node: {
          level: r.node.level,
          id: r.node.id,
          name: untrusted(r.path[r.path.length - 1]?.name ?? null, flags),
          status: statusText(r.node),
          objective: r.node.objective,
          path: r.path.map((p) => ({ level: p.level, id: p.id, name: untrusted(p.name, flags) })),
        },
        period: { since: r.range.since, until: r.range.until, days: r.range.days },
        comparison: prev ? { ...prev.range, mode: prev.mode } : null,
        currency: r.currency,
        timezones: r.timezones,
        attribution: r.attribution.map(attributionLabel),
        resultTypes: r.totals.resultTypes.map(resultLabel),
        metrics,
        results: r.results.map((x) => ({
          type: resultLabel(x.indicator),
          current: x.current,
          previous: x.previous,
          changePct: pct(change(x.current, x.previous)),
        })),
        children,
        daily,
        freshness: {
          dataUntil: r.freshness.dataUntil,
          newestSyncAt: r.freshness.newestSyncAt,
          oldestSyncAt: r.freshness.oldestSyncAt,
          immatureFrom: r.freshness.immatureFrom,
        },
      },
    },
  };
}

const getMetrics = tool({
  name: 'get_metrics',
  description:
    'Métricas de un nodo (org, client, account, campaign, adset, ad) en un periodo, con comparación, variaciones ya calculadas (delta y changePct en %), desglose de resultados y, opcionalmente, filas de los hijos o serie diaria. Los porcentajes (CTR, etc.) vienen ya multiplicados por 100. Incluye la atribución, la moneda, la frescura y la suficiencia de los datos.',
  readOnly: true,
  permission: 'insights:read',
  input: MetricsInput,
  output: withSufficiency(MetricsData),
  async run(input, env) {
    return (await metricsOf(env, input)).out;
  },
});

// decompose_change

const DecomposeInput = z
  .object({ ...NodeInput, ...PeriodInput })
  .refine((v) => (v.since === null) === (v.until === null), 'since y until van juntos')
  .refine((v) => v.compare !== 'none', 'hace falta un periodo de comparación')
  .refine(
    (v) => v.compare !== 'custom' || (v.compareSince !== null && v.compareUntil !== null),
    'compare custom requiere compareSince y compareUntil',
  );

const Factor = z.object({
  factor: z.enum(['cpm', 'linkCtr', 'linkCvr']),
  label: z.string(),
  current: z.number().nullable(),
  previous: z.number().nullable(),
  changePct: z.number().nullable(),
  /** Parte del cambio del costo por resultado (en log) que explica el factor, en %. */
  contributionPct: z.number().nullable(),
});

const decomposeChange = tool({
  name: 'decompose_change',
  description:
    'Descompone la variación del costo por resultado entre dos periodos en CPM, CTR de enlace y conversión por clic de enlace (costo por resultado = CPM/1000 ÷ CTR ÷ conversión). contributionPct indica qué parte del cambio explica cada factor. Requiere un solo tipo de resultado en ambos periodos.',
  readOnly: true,
  permission: 'insights:read',
  input: DecomposeInput,
  output: withSufficiency(
    z.object({
      period: z.object({ since: z.string(), until: z.string() }),
      comparison: z.object({ since: z.string(), until: z.string() }).nullable(),
      currency: z.string().nullable(),
      resultType: z.string().nullable(),
      costPerResult: z.object({
        current: z.number().nullable(),
        previous: z.number().nullable(),
        changePct: z.number().nullable(),
      }),
      factors: z.array(Factor),
    }),
  ),
  async run(input, env) {
    const {
      report: r,
      prev,
      out,
    } = await metricsOf(env, {
      ...input,
      metrics: ['costPerResult', 'results'],
      breakdown: 'none',
    });
    const reasons = [...out.sufficiency.reasons];
    let status = out.sufficiency.status;
    const c = r.totals.current;
    const p = prev?.totals ?? null;
    const sameType =
      r.totals.resultTypes.length === 1 &&
      prev?.resultTypes.length === 1 &&
      r.totals.resultTypes[0] === prev.resultTypes[0];
    if (!sameType) {
      status = 'insufficient';
      reasons.push('los periodos no tienen un único tipo de resultado común');
    }
    const parts = (t: Totals | null) =>
      t?.impressions && t.inlineLinkClicks && t.results && t.spend
        ? {
            cpr: t.spend / t.results,
            cpm: (t.spend / t.impressions) * 1000,
            linkCtr: t.inlineLinkClicks / t.impressions,
            linkCvr: t.results / t.inlineLinkClicks,
          }
        : null;
    const a = sameType ? parts(c) : null;
    const b = sameType ? parts(p) : null;
    if (sameType && (!a || !b)) {
      status = 'insufficient';
      reasons.push('falta gasto, impresiones, clics de enlace o resultados en algún periodo');
    }
    const total = a && b ? Math.log(a.cpr / b.cpr) : null;
    const share = (term: number) => (total ? round((term / total) * 100, 1) : null);
    const factor = (f: 'cpm' | 'linkCtr' | 'linkCvr', label: string, sign: 1 | -1, scale = 1) => ({
      factor: f,
      label,
      current: a ? round(a[f] * scale, 2) : null,
      previous: b ? round(b[f] * scale, 2) : null,
      changePct: a && b ? pct(change(a[f], b[f])) : null,
      contributionPct: a && b ? share(sign * Math.log(a[f] / b[f])) : null,
    });
    return {
      sufficiency: { status, reasons },
      data: {
        period: { since: r.range.since, until: r.range.until },
        comparison: prev ? prev.range : null,
        currency: r.currency,
        resultType: sameType ? resultLabel(r.totals.resultTypes[0] ?? null) : null,
        costPerResult: {
          current: a ? round(a.cpr, 2) : null,
          previous: b ? round(b.cpr, 2) : null,
          changePct: a && b ? pct(change(a.cpr, b.cpr)) : null,
        },
        factors: [
          factor('cpm', 'CPM', 1),
          factor('linkCtr', 'CTR de enlace (%)', -1, 100),
          factor('linkCvr', 'Resultados por clic de enlace (%)', -1, 100),
        ],
      },
    };
  },
});

// get_findings

const OPEN = ['open', 'acknowledged', 'snoozed'] as const;

const FindingRow = z.object({
  id: z.string(),
  ruleId: z.string(),
  category: z.string().nullable(),
  severity: z.string(),
  confidence: z.number(),
  priority: z.number(),
  status: z.string(),
  accountId: z.string(),
  entityLevel: z.string(),
  entityId: z.string(),
  entityName: z.string().nullable(),
  explanation: z.string().nullable(),
  recommendation: z.string().nullable(),
  impact: z.unknown(),
  evidence: z.unknown(),
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

const getFindings = tool({
  name: 'get_findings',
  description:
    'Hallazgos del motor de auditoría determinista para un nodo y su rama, ordenados por prioridad: regla, categoría, severidad, confianza, explicación, métricas de evidencia, impacto estimado y ventana evaluada. status open = abiertos, reconocidos o pospuestos; all = también resueltos y descartados.',
  readOnly: true,
  permission: 'findings:read',
  input: z.object({
    ...NodeInput,
    status: z.enum(['open', 'all']),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .nullable()
      .describe('Máximo de hallazgos (por defecto 15)'),
  }),
  output: withSufficiency(z.object({ total: z.number(), findings: z.array(FindingRow) })),
  async run(input, env) {
    const { tx, ctx, flags } = env;
    await assertConsent(env, input.level, input.id);
    let accountIds: string[];
    let branch: string[] | null = null;
    if (input.level === 'org' || input.level === 'client') {
      const rows = await tx
        .select({ id: adAccounts.id, clientId: adAccounts.clientId })
        .from(adAccounts)
        .where(
          and(
            clientScope(tx, ctx, adAccounts.clientId),
            input.level === 'client' ? eq(adAccounts.clientId, input.id ?? '') : undefined,
          ),
        );
      accountIds = rows.filter((a) => a.clientId && env.consented.has(a.clientId)).map((a) => a.id);
    } else {
      const resolved = await resolveEntity(tx, ctx, input.level, input.id ?? '');
      accountIds = [resolved.account.id];
      branch = resolved.branch;
    }
    if (!accountIds.length)
      return {
        sufficiency: suff('insufficient', [
          'no hay cuentas con consentimiento de IA en este alcance',
        ]),
        data: { total: 0, findings: [] },
      };
    const where = and(
      inArray(findings.adAccountId, accountIds),
      input.status === 'open' ? inArray(findings.status, [...OPEN]) : undefined,
      branch ? inArray(findings.entityMetaId, branch) : undefined,
    );
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(findings).where(where);
    const rows = await tx
      .select()
      .from(findings)
      .where(where)
      .orderBy(desc(findings.priority), desc(findings.lastSeenAt))
      .limit(input.limit ?? 15);
    const names = new Map<string, string>();
    for (const t of [campaigns, adsets, ads]) {
      const ids = rows.map((f) => f.entityMetaId).filter((x) => !names.has(x));
      if (ids.length)
        for (const n of await tx
          .select({ id: t.metaId, name: t.name })
          .from(t)
          .where(inArray(t.metaId, ids)))
          names.set(n.id, n.name);
    }
    for (const a of await tx
      .select({ id: adAccounts.metaAccountId, name: adAccounts.name })
      .from(adAccounts)
      .where(inArray(adAccounts.id, accountIds)))
      names.set(a.id, a.name);
    return {
      sufficiency: suff('sufficient'),
      data: {
        total: count?.n ?? rows.length,
        findings: rows.map((f) => ({
          id: f.id,
          ruleId: f.ruleId,
          category: f.category,
          severity: f.severity,
          confidence: Number(f.confidence),
          priority: round(Number(f.priority), 3) ?? 0,
          status: f.status,
          accountId: f.adAccountId,
          entityLevel: f.entityLevel,
          entityId: f.entityMetaId,
          entityName: untrusted(names.get(f.entityMetaId) ?? null, flags),
          explanation: untrusted(f.explanation, flags, 600),
          recommendation: untrusted(f.recommendationText, flags, 400),
          impact: sanitize(f.impact, flags),
          evidence: sanitize(f.evidence, flags),
          window: { since: f.windowStart, until: f.windowEnd },
          firstSeenAt: f.firstSeenAt.toISOString(),
          lastSeenAt: f.lastSeenAt.toISOString(),
        })),
      },
    };
  },
});

// get_health

const getHealth = tool({
  name: 'get_health',
  description:
    'Índice de salud 0–100 de una cuenta, campaña, conjunto o anuncio (fórmula health-v1): nota, confianza, cobertura, subíndices (eficiencia, estabilidad, entrega, medición, fatiga) con su peso, historial reciente y la salud de los hijos con peor nota. score null = datos insuficientes.',
  readOnly: true,
  permission: 'findings:read',
  input: z.object({ level: EntityLevel, id: z.string().max(64) }),
  output: withSufficiency(
    z.object({
      health: z
        .object({
          date: z.string(),
          formulaVersion: z.string(),
          profile: z.string(),
          windowDays: z.number(),
          score: z.number().nullable(),
          grade: z.string(),
          confidence: z.number().nullable(),
          coverage: z.number(),
          components: z.unknown(),
        })
        .nullable(),
      history: z.array(
        z.object({ date: z.string(), score: z.number().nullable(), grade: z.string() }),
      ),
      openFindings: z.number(),
      weakestChildren: z.array(
        z.object({ id: z.string(), score: z.number().nullable(), grade: z.string() }),
      ),
    }),
  ),
  async run(input, env) {
    await assertConsent(env, input.level, input.id);
    const a = await entityAudit(env.tx, env.ctx, input.level, input.id);
    const children = Object.entries(a.childrenHealth)
      .map(([id, h]) => ({ id, score: h.score, grade: h.grade }))
      .sort((x, y) => (x.score ?? 101) - (y.score ?? 101))
      .slice(0, 10);
    const h = a.health;
    return {
      sufficiency:
        !h || h.score === null
          ? suff('insufficient', [
              h
                ? 'cobertura de datos insuficiente para el índice'
                : 'la entidad aún no tiene índice de salud',
            ])
          : h.coverage < 0.8
            ? suff('limited', ['parte de los subíndices no tiene datos suficientes'])
            : suff('sufficient'),
      data: {
        health: h
          ? {
              date: h.date,
              formulaVersion: h.formulaVersion,
              profile: h.profile,
              windowDays: h.windowDays,
              score: h.score === null ? null : round(h.score, 1),
              grade: h.grade,
              confidence: h.confidence,
              coverage: h.coverage,
              components: sanitize(h.components, env.flags),
            }
          : null,
        history: a.history
          .slice(-14)
          .map((x) => ({ ...x, score: x.score === null ? null : round(x.score, 1) })),
        openFindings: a.findings.length,
        weakestChildren: children.map((c) => ({
          ...c,
          score: c.score === null ? null : round(c.score, 1),
        })),
      },
    };
  },
});

export const TOOLS = [getScope, getMetrics, decomposeChange, getFindings, getHealth] as const;
export type ReadTool = (typeof TOOLS)[number];
export const TOOLS_BY_NAME = new Map<string, ReadTool>(TOOLS.map((t) => [t.name, t]));

/** Esquema JSON de entrada de una herramienta (neutral; cada proveedor lo adapta). */
export const toolSchema = (t: { input: z.ZodType }) =>
  z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

/**
 * Ejecuta una herramienta con permiso, validación de entrada y de salida. Los errores esperables
 * (alcance, consentimiento, entrada) vuelven como ToolError para que el modelo los vea.
 */
export async function runTool(name: string, input: unknown, env: ToolEnv) {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new ToolError('invalid', `Herramienta desconocida: ${name}`);
  if (!can(env.ctx.role, t.permission))
    throw new ToolError('forbidden', 'Tu rol no permite esta consulta');
  const parsed = t.input.safeParse(input);
  if (!parsed.success)
    throw new ToolError(
      'invalid',
      `Entrada no válida: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'} ${i.message}`).join('; ')}`,
    );
  // biome-ignore lint/suspicious/noExplicitAny: la unión de herramientas no estrecha `run`.
  const out = await (t.run as (i: any, e: ToolEnv) => Promise<unknown>)(parsed.data, env);
  return t.output.parse(out) as { sufficiency: Sufficiency; data: unknown };
}

import type { Level } from '../../db/schema.ts';
import { addDays } from '../insights/catalog.ts';

// Conversión de filas de Insights a columnas canónicas (ADR-009, DATABASE_SCHEMA §3.4). Funciones
// puras y versionadas: si cambia la lógica, sube EXTRACTION_VERSION y un trabajo recalcula
// desde `actions` sin volver a pedir datos a Meta.
export const EXTRACTION_VERSION = 1;

// Un único action_type por KPI, por orden de preferencia, para no contar dos veces.
// ponytail: precedencia simple a validar con datos reales del spike (V-04); si una cuenta usa
// varias fuentes de leads sin el agregado `lead`, se queda con la primera (TD-15).
const PRECEDENCE = {
  purchases: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
  leads: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
  messagingConversations: ['onsite_conversion.messaging_conversation_started_7d'],
  appInstalls: ['omni_app_install', 'mobile_app_install', 'app_install'],
  landingPageViews: ['omni_landing_page_view', 'landing_page_view'],
} as const;

type ActionStat = { action_type?: unknown; value?: unknown };

/** Decimal exacto como string (sin pasar por coma flotante), o null si no hay valor válido. */
export function decimal(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? v : null;
}

const integer = (v: unknown): number | null => {
  const d = decimal(v);
  return d === null ? null : Math.round(Number(d));
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const stats = (v: unknown): ActionStat[] => (Array.isArray(v) ? (v as ActionStat[]) : []);

/**
 * Valor del primer action_type presente. Meta omite los tipos con cero, así que en una fila
 * con datos un tipo ausente vale 0 (la aplicabilidad por objetivo la decide el perfil KPI).
 */
export function pickAction(list: unknown, types: readonly string[]): string {
  const byType = new Map(stats(list).map((a) => [String(a.action_type), decimal(a.value)]));
  for (const t of types) {
    const v = byType.get(t);
    if (v !== undefined && v !== null) return v;
  }
  return '0';
}

/** Suma de una lista de AdsActionStats (p. ej. outbound_clicks, video_thruplay_watched_actions). */
export function sumStats(list: unknown): string {
  // Suma exacta en unidades de 1e-4 (escala de la columna) para no acumular error de coma flotante.
  const total = stats(list).reduce(
    (acc, a) => acc + BigInt(Math.round(Number(decimal(a.value) ?? 0) * 1e4)),
    0n,
  );
  const sign = total < 0n ? '-' : '';
  const abs = total < 0n ? -total : total;
  return `${sign}${abs / 10_000n}.${String(abs % 10_000n).padStart(4, '0')}`;
}

/**
 * `results` es `list<Object>` sin tipar en la spec oficial; su forma real se confirma en el
 * spike (V-04). Se interpreta de forma defensiva y, si no se entiende, se marca la fila.
 */
export function parseResults(raw: unknown): {
  value: string | null;
  indicator: string | null;
  unparsed: boolean;
} {
  if (raw === undefined || raw === null) return { value: null, indicator: null, unparsed: false };
  const first = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : undefined;
  const values = Array.isArray(first?.values) ? (first.values as ActionStat[]) : [];
  const value = decimal(values[0]?.value);
  if (!first || value === null) return { value: null, indicator: null, unparsed: true };
  return {
    value,
    indicator: typeof first.indicator === 'string' ? first.indicator : null,
    unparsed: false,
  };
}

// --- Fechas: los días de Insights son locales de la cuenta.

/** 'YYYY-MM-DD' del instante dado en la zona horaria de la cuenta. */
export function localDate(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export { addDays };

/** Primer y último día del mes que está `monthsBack` meses antes del mes de `today`. */
export function monthRange(today: string, monthsBack: number): { since: string; until: string } {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  const since = d.toISOString().slice(0, 10);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { since, until: d.toISOString().slice(0, 10) };
}

/** Parte un rango en dos mitades (para "demasiados datos"); null si es de un solo día. */
export function splitRange(
  since: string,
  until: string,
): [[string, string], [string, string]] | null {
  const days = Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000);
  if (days < 1) return null;
  const mid = addDays(since, Math.floor(days / 2));
  return [
    [since, mid],
    [addDays(mid, 1), until],
  ];
}

export interface RowContext {
  tenantId: string;
  adAccountId: string;
  metaAccountId: string;
  currency: string;
  level: Level;
  today: string; // día local de la cuenta
  syncRunId: number;
  fetchedAt: Date;
}

/** Fila de Insights de Meta → fila de insights_daily. */
export function toInsightRow(row: Record<string, unknown>, ctx: RowContext) {
  const date = String(row.date_start);
  const entityMetaId = ctx.level === 'account' ? ctx.metaAccountId : String(row[`${ctx.level}_id`]);
  const results = parseResults(row.results);
  const flags: string[] = [];
  if (date >= addDays(ctx.today, -7)) flags.push('immature'); // conversiones aún llegando
  if (results.unparsed) flags.push('results_unparsed');
  return {
    tenantId: ctx.tenantId,
    adAccountId: ctx.adAccountId,
    level: ctx.level,
    entityMetaId,
    campaignMetaId: ctx.level === 'account' ? null : (str(row.campaign_id) ?? null),
    adsetMetaId: ctx.level === 'adset' || ctx.level === 'ad' ? (str(row.adset_id) ?? null) : null,
    date,
    currency: ctx.currency,
    attributionSetting:
      typeof row.attribution_setting === 'string' ? row.attribution_setting : null,
    spend: decimal(row.spend),
    impressions: integer(row.impressions),
    reach: integer(row.reach),
    clicks: integer(row.clicks),
    inlineLinkClicks: integer(row.inline_link_clicks),
    outboundClicks: integer(sumStats(row.outbound_clicks)),
    results: results.value,
    resultIndicator: results.indicator,
    leads: pickAction(row.actions, PRECEDENCE.leads),
    purchases: pickAction(row.actions, PRECEDENCE.purchases),
    purchaseValue: pickAction(row.action_values, PRECEDENCE.purchases),
    messagingConversations: pickAction(row.actions, PRECEDENCE.messagingConversations),
    appInstalls: pickAction(row.actions, PRECEDENCE.appInstalls),
    landingPageViews: pickAction(row.actions, PRECEDENCE.landingPageViews),
    thruplays: sumStats(row.video_thruplay_watched_actions),
    actions: row.actions ?? null,
    actionValues: row.action_values ?? null,
    resultsRaw: row.results ?? null,
    qualityRanking: typeof row.quality_ranking === 'string' ? row.quality_ranking : null,
    engagementRateRanking:
      typeof row.engagement_rate_ranking === 'string' ? row.engagement_rate_ranking : null,
    conversionRateRanking:
      typeof row.conversion_rate_ranking === 'string' ? row.conversion_rate_ranking : null,
    extractionVersion: EXTRACTION_VERSION,
    isFinal: date < addDays(ctx.today, -28), // Meta deja de modificar los datos a los 28 días
    dataFlags: flags,
    syncRunId: ctx.syncRunId,
    fetchedAt: ctx.fetchedAt,
  };
}

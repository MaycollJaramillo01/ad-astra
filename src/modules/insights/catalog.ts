// Catálogo único de métricas (ARCHITECTURE §6.4, ADR-021). Lo usan la API (exportación) y la
// web: una métrica se define, se calcula y se explica en un solo sitio. Sin dependencias, porque
// también se importa desde el navegador.
//
// Reglas que aplica cada cálculo:
//   - Ratios de sumas, nunca promedios de ratios (Σgasto ÷ Σimpresiones, no media de CPM).
//   - División entre cero → "no disponible" con su motivo, nunca 0 ni infinito.
//   - null es "no disponible"; 0 es "Meta informó cero".
//   - El alcance no se suma entre días ni entre cuentas o anuncios: solo un día y una fuente.
//   - Varios tipos de resultado no se suman: se remite al desglose.
//   - Las métricas de conversión de días recientes quedan "en maduración".

/** Niveles de la jerarquía de la analítica: cartera → cliente → cuenta → campaña → conjunto → anuncio. */
export const NODE_LEVELS = ['org', 'client', 'account', 'campaign', 'adset', 'ad'] as const;
export type NodeLevel = (typeof NODE_LEVELS)[number];

/** Sumas por periodo que devuelve la API (columnas aditivas de insights_daily, más el alcance). */
export const BASE_FIELDS = [
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
export type BaseField = (typeof BASE_FIELDS)[number];
export type Totals = Record<BaseField, number | null>;

export type DataState = 'available' | 'estimated' | 'unavailable' | 'not_applicable' | 'immature';
export interface MetricValue {
  value: number | null;
  state: DataState;
  /** Por qué no hay valor, o qué matiz tiene. */
  reason?: string;
}

export interface MetricContext {
  /** Días del rango. */
  days: number;
  /** Fuentes de alcance sumadas (cuentas o entidades). Con más de una, el alcance no es sumable. */
  reachSources: number;
  /** Tipos de resultado distintos en el periodo. */
  resultTypes: number;
  /** El rango incluye días cuyas conversiones aún pueden llegar. */
  immature: boolean;
}

export type Unit = 'currency' | 'count' | 'percent' | 'decimal';
/** Qué dirección del cambio es buena. */
export type Better = 'up' | 'down' | 'none';

export interface MetricDef {
  id: string;
  label: string;
  unit: Unit;
  better: Better;
  definition: string;
  formula: string;
  /** Campos de Meta de los que sale (los derivados, los de sus componentes). */
  metaFields: string[];
  derived: boolean;
  additive: boolean;
  /** Depende de la atribución y madura con los días. */
  conversion: boolean;
  compute: (t: Totals, ctx: MetricContext) => MetricValue;
}

const ok = (value: number): MetricValue => ({ value, state: 'available' });
const missing = (reason: string): MetricValue => ({ value: null, state: 'unavailable', reason });
export const NO_DATA = 'sin entrega ni datos en el periodo';

/** División segura: sin datos o con denominador 0 no hay valor, y se dice por qué. */
export function safeDiv(
  n: number | null,
  d: number | null,
  denominator: string,
  scale = 1,
): MetricValue {
  if (n === null || d === null) return missing(NO_DATA);
  if (d === 0) return missing(`sin ${denominator}`);
  return ok((n / d) * scale);
}

type Compute = MetricDef['compute'];
const base =
  (field: BaseField): Compute =>
  (t) =>
    t[field] === null ? missing(NO_DATA) : ok(t[field] as number);

/** Varios tipos de resultado no se suman (Ads Manager tampoco lo hace). */
const singleResultType =
  (fn: Compute): Compute =>
  (t, ctx) =>
    ctx.resultTypes > 1 ? missing('varios tipos de resultado: ver el desglose') : fn(t, ctx);

/** El alcance es una estimación de personas únicas: no se suma entre días ni entre fuentes. */
const reachRule =
  (fn: Compute): Compute =>
  (t, ctx) => {
    if (ctx.days > 1) return missing('el alcance no se suma entre días');
    if (ctx.reachSources > 1) return missing('el alcance no se suma entre cuentas o anuncios');
    const v = fn(t, ctx);
    return v.value === null ? v : { ...v, state: 'estimated', reason: 'estimación de Meta' };
  };

type Def = Omit<MetricDef, 'id' | 'derived' | 'additive' | 'conversion'> &
  Partial<Pick<MetricDef, 'derived' | 'additive' | 'conversion'>>;

const DEFS = {
  spend: {
    label: 'Importe gastado',
    unit: 'currency',
    better: 'none',
    definition: 'Lo que se gastó en el periodo, en la moneda de la cuenta.',
    formula: 'Σ gasto diario',
    metaFields: ['spend'],
    additive: true,
    compute: base('spend'),
  },
  impressions: {
    label: 'Impresiones',
    unit: 'count',
    better: 'up',
    definition: 'Veces que los anuncios se mostraron en pantalla.',
    formula: 'Σ impresiones',
    metaFields: ['impressions'],
    additive: true,
    compute: base('impressions'),
  },
  reach: {
    label: 'Alcance',
    unit: 'count',
    better: 'up',
    definition:
      'Personas distintas que vieron los anuncios (estimación de Meta). No es sumable: solo se muestra para un día y una sola cuenta o entidad.',
    formula: 'alcance diario de Meta (sin sumar)',
    metaFields: ['reach'],
    compute: reachRule(base('reach')),
  },
  frequency: {
    label: 'Frecuencia',
    unit: 'decimal',
    better: 'none',
    definition:
      'Veces que, en promedio, cada persona vio los anuncios. Hereda las limitaciones del alcance.',
    formula: 'impresiones ÷ alcance',
    metaFields: ['impressions', 'reach'],
    derived: true,
    compute: reachRule((t) => safeDiv(t.impressions, t.reach, 'alcance')),
  },
  cpm: {
    label: 'CPM',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada mil impresiones.',
    formula: 'Σ gasto ÷ Σ impresiones × 1000',
    metaFields: ['spend', 'impressions'],
    derived: true,
    compute: (t) => safeDiv(t.spend, t.impressions, 'impresiones', 1000),
  },
  clicks: {
    label: 'Clics (todos)',
    unit: 'count',
    better: 'up',
    definition: 'Todos los clics en los anuncios, incluidos los que no salen hacia el destino.',
    formula: 'Σ clics',
    metaFields: ['clicks'],
    additive: true,
    compute: base('clicks'),
  },
  ctr: {
    label: 'CTR (todos)',
    unit: 'percent',
    better: 'up',
    definition: 'Porcentaje de impresiones que acabaron en un clic de cualquier tipo.',
    formula: 'Σ clics ÷ Σ impresiones',
    metaFields: ['clicks', 'impressions'],
    derived: true,
    compute: (t) => safeDiv(t.clicks, t.impressions, 'impresiones'),
  },
  linkClicks: {
    label: 'Clics en el enlace',
    unit: 'count',
    better: 'up',
    definition: 'Clics que llevan al destino del anuncio (web, app, WhatsApp…).',
    formula: 'Σ clics en el enlace',
    metaFields: ['inline_link_clicks'],
    additive: true,
    compute: base('inlineLinkClicks'),
  },
  linkCtr: {
    label: 'CTR del enlace',
    unit: 'percent',
    better: 'up',
    definition: 'Porcentaje de impresiones que acabaron en un clic en el enlace.',
    formula: 'Σ clics en el enlace ÷ Σ impresiones',
    metaFields: ['inline_link_clicks', 'impressions'],
    derived: true,
    compute: (t) => safeDiv(t.inlineLinkClicks, t.impressions, 'impresiones'),
  },
  cpc: {
    label: 'CPC del enlace',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada clic en el enlace.',
    formula: 'Σ gasto ÷ Σ clics en el enlace',
    metaFields: ['spend', 'inline_link_clicks'],
    derived: true,
    compute: (t) => safeDiv(t.spend, t.inlineLinkClicks, 'clics en el enlace'),
  },
  outboundClicks: {
    label: 'Clics salientes',
    unit: 'count',
    better: 'up',
    definition: 'Clics que sacan a la persona de Facebook o Instagram.',
    formula: 'Σ clics salientes',
    metaFields: ['outbound_clicks'],
    additive: true,
    compute: base('outboundClicks'),
  },
  landingPageViews: {
    label: 'Visitas a la página de destino',
    unit: 'count',
    better: 'up',
    definition: 'Veces que la página de destino terminó de cargar tras un clic.',
    formula: 'Σ visitas a la página de destino',
    metaFields: ['actions[landing_page_view]'],
    additive: true,
    conversion: true,
    compute: base('landingPageViews'),
  },
  costPerLandingPageView: {
    label: 'Costo por visita a la página',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada visita a la página de destino.',
    formula: 'Σ gasto ÷ Σ visitas a la página de destino',
    metaFields: ['spend', 'actions[landing_page_view]'],
    derived: true,
    conversion: true,
    compute: (t) => safeDiv(t.spend, t.landingPageViews, 'visitas a la página'),
  },
  results: {
    label: 'Resultados',
    unit: 'count',
    better: 'up',
    definition:
      'El resultado que optimiza cada campaña, igual que la columna "Resultados" de Ads Manager. Si hay varios tipos, no se suman.',
    formula: 'Σ resultados (un solo tipo)',
    metaFields: ['results'],
    additive: true,
    conversion: true,
    compute: singleResultType(base('results')),
  },
  costPerResult: {
    label: 'Costo por resultado',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada resultado. Solo con un único tipo de resultado.',
    formula: 'Σ gasto ÷ Σ resultados',
    metaFields: ['spend', 'results'],
    derived: true,
    conversion: true,
    compute: singleResultType((t) => safeDiv(t.spend, t.results, 'resultados')),
  },
  leads: {
    label: 'Clientes potenciales',
    unit: 'count',
    better: 'up',
    definition: 'Formularios o leads registrados por Meta.',
    formula: 'Σ clientes potenciales',
    metaFields: ['actions[lead]'],
    additive: true,
    conversion: true,
    compute: base('leads'),
  },
  costPerLead: {
    label: 'Costo por cliente potencial',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada cliente potencial.',
    formula: 'Σ gasto ÷ Σ clientes potenciales',
    metaFields: ['spend', 'actions[lead]'],
    derived: true,
    conversion: true,
    compute: (t) => safeDiv(t.spend, t.leads, 'clientes potenciales'),
  },
  messagingConversations: {
    label: 'Conversaciones iniciadas',
    unit: 'count',
    better: 'up',
    definition:
      'Conversaciones por mensajes (WhatsApp, Messenger, Instagram) iniciadas tras el anuncio.',
    formula: 'Σ conversaciones iniciadas',
    metaFields: ['actions[onsite_conversion.messaging_conversation_started_7d]'],
    additive: true,
    conversion: true,
    compute: base('messagingConversations'),
  },
  costPerConversation: {
    label: 'Costo por conversación',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada conversación iniciada.',
    formula: 'Σ gasto ÷ Σ conversaciones iniciadas',
    metaFields: ['spend', 'actions[onsite_conversion.messaging_conversation_started_7d]'],
    derived: true,
    conversion: true,
    compute: (t) => safeDiv(t.spend, t.messagingConversations, 'conversaciones'),
  },
  purchases: {
    label: 'Compras',
    unit: 'count',
    better: 'up',
    definition: 'Compras atribuidas a los anuncios.',
    formula: 'Σ compras',
    metaFields: ['actions[omni_purchase]'],
    additive: true,
    conversion: true,
    compute: base('purchases'),
  },
  costPerPurchase: {
    label: 'Costo por compra',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada compra.',
    formula: 'Σ gasto ÷ Σ compras',
    metaFields: ['spend', 'actions[omni_purchase]'],
    derived: true,
    conversion: true,
    compute: (t) => safeDiv(t.spend, t.purchases, 'compras'),
  },
  purchaseValue: {
    label: 'Valor de las compras',
    unit: 'currency',
    better: 'up',
    definition: 'Valor de conversión de las compras atribuidas.',
    formula: 'Σ valor de compra',
    metaFields: ['action_values[omni_purchase]'],
    additive: true,
    conversion: true,
    compute: base('purchaseValue'),
  },
  roas: {
    label: 'ROAS de compras',
    unit: 'decimal',
    better: 'up',
    definition:
      'Valor de las compras por cada unidad gastada. No aplica si no hay valor de compra.',
    formula: 'Σ valor de compra ÷ Σ gasto',
    metaFields: ['action_values[omni_purchase]', 'spend'],
    derived: true,
    conversion: true,
    compute: (t) =>
      t.purchaseValue === 0 && (t.purchases ?? 0) === 0
        ? { value: null, state: 'not_applicable', reason: 'sin valor de compra' }
        : safeDiv(t.purchaseValue, t.spend, 'gasto'),
  },
  appInstalls: {
    label: 'Instalaciones de la app',
    unit: 'count',
    better: 'up',
    definition: 'Instalaciones de la aplicación atribuidas.',
    formula: 'Σ instalaciones',
    metaFields: ['actions[omni_app_install]'],
    additive: true,
    conversion: true,
    compute: base('appInstalls'),
  },
  costPerInstall: {
    label: 'Costo por instalación',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada instalación de la app.',
    formula: 'Σ gasto ÷ Σ instalaciones',
    metaFields: ['spend', 'actions[omni_app_install]'],
    derived: true,
    conversion: true,
    compute: (t) => safeDiv(t.spend, t.appInstalls, 'instalaciones'),
  },
  thruplays: {
    label: 'ThruPlays',
    unit: 'count',
    better: 'up',
    definition: 'Reproducciones del video hasta el final o durante al menos 15 segundos.',
    formula: 'Σ ThruPlays',
    metaFields: ['video_thruplay_watched_actions'],
    additive: true,
    compute: base('thruplays'),
  },
  costPerThruplay: {
    label: 'Costo por ThruPlay',
    unit: 'currency',
    better: 'down',
    definition: 'Costo por cada ThruPlay.',
    formula: 'Σ gasto ÷ Σ ThruPlays',
    metaFields: ['spend', 'video_thruplay_watched_actions'],
    derived: true,
    compute: (t) => safeDiv(t.spend, t.thruplays, 'ThruPlays'),
  },
} satisfies Record<string, Def>;

export type MetricId = keyof typeof DEFS;

export const METRICS = Object.fromEntries(
  Object.entries(DEFS).map(([id, d]) => {
    const def = d as Def;
    const conversion = def.conversion ?? false;
    const compute: Compute = (t, ctx) => {
      const v = def.compute(t, ctx);
      return conversion && ctx.immature && v.value !== null
        ? { ...v, state: 'immature', reason: 'incluye días con conversiones aún por llegar' }
        : v;
    };
    return [
      id,
      {
        ...def,
        id,
        derived: def.derived ?? false,
        additive: def.additive ?? false,
        conversion,
        compute,
      },
    ];
  }),
) as Record<MetricId, MetricDef>;

export const METRIC_IDS = Object.keys(DEFS) as MetricId[];
export const isMetricId = (v: string): v is MetricId => v in DEFS;

/** Columnas por defecto de las tablas. */
export const DEFAULT_COLUMNS: MetricId[] = [
  'spend',
  'results',
  'costPerResult',
  'impressions',
  'cpm',
  'linkClicks',
  'linkCtr',
  'cpc',
];

export const compute = (id: MetricId, t: Totals, ctx: MetricContext) => METRICS[id].compute(t, ctx);

export const emptyTotals = (): Totals =>
  Object.fromEntries(BASE_FIELDS.map((f) => [f, null])) as Totals;

/** Suma de totales: null solo si todos lo son (no se inventan ceros). */
export function sumTotals(list: Totals[]): Totals {
  const out = emptyTotals();
  for (const t of list) {
    for (const f of BASE_FIELDS) {
      const v = t[f];
      if (v !== null) out[f] = (out[f] ?? 0) + v;
    }
  }
  return out;
}

/** Variación relativa; null si no hay base con la que comparar. */
export function change(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Si un cambio es bueno, malo o neutro según la métrica. */
export function changeTone(id: MetricId, delta: number | null): 'good' | 'bad' | 'neutral' {
  const better = METRICS[id].better;
  if (delta === null || delta === 0 || better === 'none') return 'neutral';
  return delta > 0 === (better === 'up') ? 'good' : 'bad';
}

// --- Etiquetas de valores de Meta

const RESULT_LABELS: Record<string, string> = {
  'onsite_conversion.messaging_conversation_started_7d': 'Conversaciones iniciadas',
  'onsite_conversion.total_messaging_connection': 'Contactos por mensajes',
  lead: 'Clientes potenciales',
  'onsite_conversion.lead_grouped': 'Clientes potenciales (formularios)',
  'offsite_conversion.fb_pixel_lead': 'Clientes potenciales (píxel)',
  omni_purchase: 'Compras',
  purchase: 'Compras',
  'offsite_conversion.fb_pixel_purchase': 'Compras (píxel)',
  link_click: 'Clics en el enlace',
  landing_page_view: 'Visitas a la página de destino',
  omni_landing_page_view: 'Visitas a la página de destino',
  post_engagement: 'Interacciones con la publicación',
  page_engagement: 'Interacciones con la página',
  video_view: 'Reproducciones de video',
  video_thruplay_watched_actions: 'ThruPlays',
  thruplay: 'ThruPlays',
  reach: 'Alcance',
  impressions: 'Impresiones',
  omni_app_install: 'Instalaciones de la app',
  mobile_app_install: 'Instalaciones de la app',
  like: 'Me gusta de la página',
  profile_visit: 'Visitas al perfil',
};

/** "actions:onsite_conversion.messaging_conversation_started_7d" → "Conversaciones iniciadas". */
export function resultLabel(indicator: string | null): string {
  if (!indicator) return 'Sin tipo';
  const type = indicator.replace(/^(actions|action_values|conversions):/, '');
  return (
    RESULT_LABELS[type] ?? type.replaceAll('_', ' ').replace(/^(onsite|offsite) conversion\./, '')
  );
}

/** "1d_view_7d_click" → "7 días tras clic y 1 día tras visualización". */
export function attributionLabel(setting: string | null): string {
  if (!setting) return 'Sin datos';
  if (setting === 'multiple') return 'Varias ventanas (según la campaña)';
  const kinds: Record<string, string> = {
    click: 'clic',
    view: 'visualización',
    ev: 'visualización interactiva',
  };
  const parts = [...setting.matchAll(/(\d+)d_(click|view|ev)/g)].map(
    ([, n, kind]) => `${n} ${n === '1' ? 'día' : 'días'} tras ${kinds[kind ?? ''] ?? kind}`,
  );
  if (parts.length === 0) return setting;
  // Ads Manager nombra primero la de clic.
  return parts
    .sort((a, b) => Number(a.includes('visualiz')) - Number(b.includes('visualiz')))
    .join(' y ');
}

export type Tone = 'good' | 'neutral' | 'warning' | 'critical';

/** Estado de entrega de una campaña, conjunto o anuncio. */
export function deliveryStatus(
  effective: string | null,
  opts: { deleted?: boolean; learning?: string | null } = {},
): { label: string; tone: Tone } {
  if (opts.deleted) return { label: 'Ya no aparece en Meta', tone: 'neutral' };
  if (effective === 'ACTIVE' && opts.learning === 'LEARNING')
    return { label: 'En aprendizaje', tone: 'warning' };
  if (effective === 'ACTIVE' && opts.learning === 'FAIL')
    return { label: 'Aprendizaje limitado', tone: 'warning' };
  const map: Record<string, { label: string; tone: Tone }> = {
    ACTIVE: { label: 'Activa', tone: 'good' },
    PAUSED: { label: 'Pausada', tone: 'neutral' },
    CAMPAIGN_PAUSED: { label: 'Campaña pausada', tone: 'neutral' },
    ADSET_PAUSED: { label: 'Conjunto pausado', tone: 'neutral' },
    ARCHIVED: { label: 'Archivada', tone: 'neutral' },
    DELETED: { label: 'Eliminada', tone: 'neutral' },
    IN_PROCESS: { label: 'En proceso', tone: 'warning' },
    PENDING_REVIEW: { label: 'En revisión', tone: 'warning' },
    PREAPPROVED: { label: 'Preaprobada', tone: 'warning' },
    PENDING_BILLING_INFO: { label: 'Falta la facturación', tone: 'critical' },
    WITH_ISSUES: { label: 'Con problemas', tone: 'critical' },
    DISAPPROVED: { label: 'Rechazada', tone: 'critical' },
  };
  return (effective && map[effective]) || { label: effective ?? 'Sin estado', tone: 'neutral' };
}

/** account_status de una cuenta publicitaria. */
export function accountStatus(code: number | null): { label: string; tone: Tone } {
  const map: Record<number, { label: string; tone: Tone }> = {
    1: { label: 'Activa', tone: 'good' },
    2: { label: 'Desactivada', tone: 'critical' },
    3: { label: 'Pago pendiente', tone: 'critical' },
    7: { label: 'En revisión de riesgo', tone: 'warning' },
    8: { label: 'Pendiente de liquidación', tone: 'warning' },
    9: { label: 'En periodo de gracia', tone: 'warning' },
    100: { label: 'Cierre pendiente', tone: 'warning' },
    101: { label: 'Cerrada', tone: 'neutral' },
  };
  return (
    (code !== null && map[code]) || {
      label: code === null ? 'Sin estado' : `Estado ${code}`,
      tone: 'neutral',
    }
  );
}

// --- Fechas: días locales de la cuenta ('YYYY-MM-DD'), con la semántica de los presets de Meta.

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (since: string, until: string) =>
  Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000) + 1;

export const PRESETS = {
  today: 'Hoy',
  yesterday: 'Ayer',
  last_7d: 'Últimos 7 días',
  last_14d: 'Últimos 14 días',
  last_30d: 'Últimos 30 días',
  last_90d: 'Últimos 90 días',
  this_month: 'Este mes',
  last_month: 'Mes pasado',
} as const;
export type Preset = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as [Preset, ...Preset[]];

export interface DateRange {
  since: string;
  until: string;
}

/** Como Meta: "últimos N días" termina ayer; "este mes" incluye hoy. */
export function resolvePreset(preset: Preset, today: string): DateRange {
  const last = (n: number) => ({ since: addDays(today, -n), until: addDays(today, -1) });
  switch (preset) {
    case 'today':
      return { since: today, until: today };
    case 'yesterday':
      return { since: addDays(today, -1), until: addDays(today, -1) };
    case 'last_7d':
      return last(7);
    case 'last_14d':
      return last(14);
    case 'last_30d':
      return last(30);
    case 'last_90d':
      return last(90);
    case 'this_month':
      return { since: `${today.slice(0, 7)}-01`, until: today };
    case 'last_month': {
      const firstOfThis = `${today.slice(0, 7)}-01`;
      const lastOfPrev = addDays(firstOfThis, -1);
      return { since: `${lastOfPrev.slice(0, 7)}-01`, until: lastOfPrev };
    }
  }
}

export const COMPARE_MODES = {
  previous: 'Periodo anterior',
  year: 'Mismo periodo del año anterior',
  none: 'Sin comparación',
} as const;
export type CompareMode = keyof typeof COMPARE_MODES;

/** Periodo con el que se compara: el inmediatamente anterior de igual duración, o el del año anterior. */
export function comparisonRange(range: DateRange, mode: CompareMode): DateRange | null {
  if (mode === 'none') return null;
  if (mode === 'previous') {
    const n = daysBetween(range.since, range.until);
    return { since: addDays(range.since, -n), until: addDays(range.since, -1) };
  }
  const yearBack = (day: string) =>
    `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`.replace(/-02-29$/, '-02-28');
  return { since: yearBack(range.since), until: yearBack(range.until) };
}

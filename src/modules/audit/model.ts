import { z } from 'zod';
import type { SEVERITIES } from '../../domain.ts';
import type { BaseField } from '../insights/catalog.ts';

// Modelo del motor de auditoría (ARCHITECTURE §6.5 y §6.6): taxonomía, perfiles por objetivo,
// datos de entrada y configuración. Todo umbral es un parámetro con esquema; las referencias
// salen de objetivos del cliente o de los propios datos (nunca de "benchmarks del sector").

// 1.1.0: el motor ya no abre hallazgos sobre entidades apagadas (pausadas, archivadas o borradas).
export const AUDIT_ENGINE_VERSION = '1.1.0';
export const HEALTH_FORMULA_VERSION = 'health-v1';

// --- Taxonomía de problemas

export const CATEGORIES = {
  efficiency: 'Eficiencia',
  performance: 'Rendimiento',
  stability: 'Estabilidad',
  fatigue: 'Fatiga creativa',
  delivery: 'Entrega',
  structure: 'Estructura',
  attribution: 'Atribución',
  tracking: 'Medición',
  change: 'Cambios bruscos',
  data: 'Calidad de datos',
} as const;
export type Category = keyof typeof CATEGORIES;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 1,
  high: 0.7,
  medium: 0.4,
  low: 0.2,
  info: 0.1,
};

export type AuditLevel = 'account' | 'campaign' | 'adset' | 'ad';

// --- Perfiles por objetivo: deciden el evento clave, las reglas aplicables y los pesos de salud

export const PROFILES = {
  awareness: 'Reconocimiento',
  traffic: 'Tráfico',
  engagement: 'Interacción',
  messages: 'Mensajes',
  leads: 'Clientes potenciales',
  sales: 'Ventas',
  app: 'Promoción de la app',
  other: 'Otro objetivo',
} as const;
export type Profile = keyof typeof PROFILES;
export const PROFILE_IDS = Object.keys(PROFILES) as [Profile, ...Profile[]];
/** Perfiles cuyo evento clave es una conversión que madura con los días. */
export const CONVERSION_PROFILES: Profile[] = ['messages', 'leads', 'sales', 'app'];

/** Evento clave de un perfil: qué se cuenta y cuál es su "costo por evento". */
export interface KpiEvent {
  field: BaseField;
  label: string;
  costLabel: string;
  /** Escala de presentación del costo (1000 para el CPM). */
  scale: number;
}

export function kpiOf(profile: Profile, opts: { hasLandingPageViews: boolean }): KpiEvent {
  switch (profile) {
    case 'awareness':
      return { field: 'impressions', label: 'impresiones', costLabel: 'CPM', scale: 1000 };
    case 'traffic':
      return opts.hasLandingPageViews
        ? {
            field: 'landingPageViews',
            label: 'visitas a la página',
            costLabel: 'costo por visita',
            scale: 1,
          }
        : {
            field: 'inlineLinkClicks',
            label: 'clics en el enlace',
            costLabel: 'CPC del enlace',
            scale: 1,
          };
    case 'messages':
      return {
        field: 'messagingConversations',
        label: 'conversaciones',
        costLabel: 'costo por conversación',
        scale: 1,
      };
    case 'leads':
      return {
        field: 'leads',
        label: 'clientes potenciales',
        costLabel: 'costo por cliente potencial',
        scale: 1,
      };
    case 'sales':
      return { field: 'purchases', label: 'compras', costLabel: 'costo por compra', scale: 1 };
    case 'app':
      return {
        field: 'appInstalls',
        label: 'instalaciones',
        costLabel: 'costo por instalación',
        scale: 1,
      };
    default:
      return { field: 'results', label: 'resultados', costLabel: 'costo por resultado', scale: 1 };
  }
}

const GOAL_PROFILE: Record<string, Profile> = {
  REACH: 'awareness',
  IMPRESSIONS: 'awareness',
  AD_RECALL_LIFT: 'awareness',
  LINK_CLICKS: 'traffic',
  LANDING_PAGE_VIEWS: 'traffic',
  THRUPLAY: 'engagement',
  POST_ENGAGEMENT: 'engagement',
  PAGE_LIKES: 'engagement',
  EVENT_RESPONSES: 'engagement',
  CONVERSATIONS: 'messages',
  LEAD_GENERATION: 'leads',
  QUALITY_LEAD: 'leads',
  APP_INSTALLS: 'app',
  VALUE: 'sales',
};
const OBJECTIVE_PROFILE: Record<string, Profile> = {
  OUTCOME_AWARENESS: 'awareness',
  BRAND_AWARENESS: 'awareness',
  REACH: 'awareness',
  OUTCOME_TRAFFIC: 'traffic',
  LINK_CLICKS: 'traffic',
  OUTCOME_ENGAGEMENT: 'engagement',
  POST_ENGAGEMENT: 'engagement',
  VIDEO_VIEWS: 'engagement',
  MESSAGES: 'messages',
  OUTCOME_LEADS: 'leads',
  LEAD_GENERATION: 'leads',
  OUTCOME_SALES: 'sales',
  CONVERSIONS: 'sales',
  PRODUCT_CATALOG_SALES: 'sales',
  OUTCOME_APP_PROMOTION: 'app',
  APP_INSTALLS: 'app',
};

/**
 * Perfil de una entidad (método portado de fortytwode, ARCHITECTURE §6.4): primero el objetivo de
 * optimización del conjunto y su evento promocionado; después el tipo de resultado de Meta; por
 * último el objetivo de la campaña.
 */
export function profileOf(e: {
  optimizationGoal?: string | null;
  promotedEvent?: string | null;
  objective?: string | null;
  resultTypes?: string[];
}): Profile {
  const event = e.promotedEvent?.toUpperCase();
  if (e.optimizationGoal === 'OFFSITE_CONVERSIONS' || e.optimizationGoal === 'VALUE') {
    if (event === 'LEAD' || event === 'COMPLETE_REGISTRATION') return 'leads';
    return 'sales';
  }
  if (e.optimizationGoal && GOAL_PROFILE[e.optimizationGoal])
    return GOAL_PROFILE[e.optimizationGoal] as Profile;
  const types = e.resultTypes ?? [];
  if (types.length === 1) {
    const t = types[0] as string;
    if (t.includes('messaging')) return 'messages';
    if (t.includes('lead')) return 'leads';
    if (t.includes('purchase')) return 'sales';
    if (t.includes('app_install')) return 'app';
    if (t.includes('landing_page_view') || t.includes('link_click')) return 'traffic';
  }
  return (e.objective && OBJECTIVE_PROFILE[e.objective]) || 'other';
}

// --- Datos de entrada (los carga service.ts; los tests los construyen a mano)

/** Un día de una entidad. Las sumas del motor tratan un día sin fila como cero entrega. */
export interface Day {
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  outboundClicks: number;
  results: number;
  resultIndicator: string | null;
  leads: number;
  purchases: number;
  purchaseValue: number;
  messagingConversations: number;
  appInstalls: number;
  landingPageViews: number;
  thruplays: number;
  attribution: string | null;
}

export interface EntityInput {
  level: Exclude<AuditLevel, 'account'>;
  id: string;
  name: string;
  /** Campaña de un conjunto; conjunto de un anuncio. */
  parentId: string | null;
  campaignId: string | null;
  status: string | null;
  deleted: boolean;
  objective: string | null;
  optimizationGoal: string | null;
  promotedEvent: string | null;
  /** Presupuestos y puja en unidades mayores de la moneda de la cuenta. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  bidStrategy: string | null;
  bidAmount: number | null;
  learning: string | null;
  hasIssues: boolean;
  days: Day[];
}

export interface AuditInput {
  account: {
    id: string;
    metaAccountId: string;
    name: string;
    currency: string;
    timezone: string;
    syncEnabled: boolean;
  };
  /** Último día completo evaluado (ayer en la zona horaria de la cuenta). */
  asOf: string;
  accountDays: Day[];
  entities: EntityInput[];
}

// --- Configuración (por defecto ← organización ← cliente), validada por esquema

export const SUBINDICES = {
  efficiency: 'Eficiencia',
  stability: 'Estabilidad',
  delivery: 'Entrega',
  measurement: 'Medición',
  fatigue: 'Fatiga',
} as const;
export type Subindex = keyof typeof SUBINDICES;
export const SUBINDEX_IDS = Object.keys(SUBINDICES) as Subindex[];

const w = (
  efficiency: number,
  stability: number,
  delivery: number,
  measurement: number,
  fatigue: number,
) => ({
  efficiency,
  stability,
  delivery,
  measurement,
  fatigue,
});
/** Pesos por perfil (suman 1). La medición solo pesa donde el evento es una conversión. */
export const DEFAULT_WEIGHTS: Record<Profile, Record<Subindex, number>> = {
  awareness: w(0.4, 0.15, 0.25, 0, 0.2),
  traffic: w(0.45, 0.15, 0.2, 0, 0.2),
  engagement: w(0.45, 0.15, 0.2, 0, 0.2),
  messages: w(0.4, 0.15, 0.2, 0.15, 0.1),
  leads: w(0.4, 0.15, 0.2, 0.15, 0.1),
  sales: w(0.4, 0.15, 0.2, 0.15, 0.1),
  app: w(0.4, 0.15, 0.2, 0.15, 0.1),
  other: w(0.45, 0.15, 0.25, 0, 0.15),
};

const share = z.number().min(0).max(1);
const Weights = z.record(
  z.enum(PROFILE_IDS),
  z.object(
    Object.fromEntries(SUBINDEX_IDS.map((s) => [s, share])) as Record<Subindex, typeof share>,
  ),
);
const Currency = z.string().regex(/^[A-Z]{3}$/);

export const AuditConfigSchema = z.object({
  windows: z.object({
    /** Días evaluados, hasta `asOf`. */
    evaluationDays: z.number().int().min(3).max(28),
    /** Días previos a la ventana que forman la línea base propia. */
    baselineDays: z.number().int().min(14).max(90),
    /** Días para la estabilidad y las anomalías. */
    stabilityDays: z.number().int().min(7).max(28),
    /** Días más recientes cuyas conversiones aún pueden llegar (no cuentan en las pruebas de conversión). */
    maturityDays: z.number().int().min(0).max(7),
    /** Días sin entrega que dispara la regla de entrega. */
    deliveryDays: z.number().int().min(1).max(7),
  }),
  /** Tasa de falsos descubrimientos para abrir hallazgos de severidad alta o crítica. */
  fdrQ: z.number().min(0.01).max(0.5),
  /** Evaluaciones seguidas sin la condición para resolver un hallazgo solo. */
  resolveAfterRuns: z.number().int().min(1).max(10),
  /** Severidad según el impacto frente al gasto de la cuenta en la ventana. */
  severityByImpactShare: z.object({ critical: share, high: share, medium: share }),
  /** Parte del gasto que se asume para la prioridad cuando la regla no estima impacto. */
  priorityShareWithoutImpact: share,
  health: z.object({
    /** Puntuación en la referencia (q = 1). */
    center: z.number().min(0).max(100),
    /** Puntos por cada duplicación (o mitad) de la razón q. */
    slope: z.number().min(1).max(100),
    /** Cobertura mínima de pesos evaluables para dar una puntuación. */
    minCoverage: share,
    weights: Weights,
  }),
  /** Objetivos del cliente: la referencia preferida (en la moneda de la cuenta). */
  targets: z.array(
    z.object({
      profile: z.enum(PROFILE_IDS),
      currency: Currency,
      costPerEvent: z.number().positive().optional(),
      roas: z.number().positive().optional(),
    }),
  ),
  rules: z.record(
    z.string(),
    z.object({
      enabled: z.boolean().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
export type AuditConfig = z.infer<typeof AuditConfigSchema>;

export const DEFAULT_CONFIG: AuditConfig = {
  windows: {
    evaluationDays: 7,
    baselineDays: 28,
    stabilityDays: 14,
    maturityDays: 3,
    deliveryDays: 2,
  },
  fdrQ: 0.1,
  resolveAfterRuns: 2,
  severityByImpactShare: { critical: 0.25, high: 0.1, medium: 0.03 },
  priorityShareWithoutImpact: 0.25,
  health: { center: 80, slope: 40, minCoverage: 0.6, weights: DEFAULT_WEIGHTS },
  targets: [],
  rules: {},
};

/** Cambios parciales que guarda una organización o un cliente. */
export const AuditConfigPatch = z
  .object({
    windows: AuditConfigSchema.shape.windows.partial(),
    fdrQ: AuditConfigSchema.shape.fdrQ,
    resolveAfterRuns: AuditConfigSchema.shape.resolveAfterRuns,
    severityByImpactShare: AuditConfigSchema.shape.severityByImpactShare.partial(),
    priorityShareWithoutImpact: share,
    health: z
      .object({
        center: AuditConfigSchema.shape.health.shape.center,
        slope: AuditConfigSchema.shape.health.shape.slope,
        minCoverage: share,
        weights: z.partialRecord(
          z.enum(PROFILE_IDS),
          z.object(
            Object.fromEntries(SUBINDEX_IDS.map((s) => [s, share.optional()])) as Record<
              Subindex,
              z.ZodOptional<typeof share>
            >,
          ),
        ),
      })
      .partial(),
    targets: AuditConfigSchema.shape.targets,
    rules: AuditConfigSchema.shape.rules,
  })
  .partial()
  .strict();
export type AuditConfigPatch = z.infer<typeof AuditConfigPatch>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch))
    out[k] = v === undefined ? base[k] : deepMerge(base[k], v);
  return out;
}

/** Configuración efectiva: por defecto ← organización ← cliente. Lanza si el resultado no es válido. */
export function mergeConfig(...patches: Array<AuditConfigPatch | null | undefined>): AuditConfig {
  return AuditConfigSchema.parse(
    patches.reduce<unknown>((acc, p) => (p ? deepMerge(acc, p) : acc), DEFAULT_CONFIG),
  );
}

import { z } from 'zod';
import {
  AI_TURN_STATUSES,
  CONSENT_SCOPES,
  FINDING_STATUSES,
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_STATUSES,
  ROLES,
  SEVERITIES,
} from './domain.ts';
import { Answer, SUFFICIENCY } from './modules/ai/answer.ts';
import { AuditConfigPatch } from './modules/audit/model.ts';
import { EVENT_CATEGORIES } from './modules/forecasting/calendar.ts';
import {
  BASE_FIELDS,
  type BaseField,
  daysBetween,
  NODE_LEVELS,
  PRESET_IDS,
} from './modules/insights/catalog.ts';

// Contrato de la API v1 (ADR-017): estos esquemas validan las peticiones, serializan las
// respuestas (no sale ningún campo que no esté aquí) y generan el OpenAPI. La web importa
// solo los tipos (`import type`).

const iso = z.iso.datetime({ offset: true });
const Role = z.enum(ROLES);
const Level = z.enum(['account', 'campaign', 'adset', 'ad']);
export const IdParams = z.object({ id: z.uuid() });

export const MeDto = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string() }),
  memberships: z.array(z.object({ tenantId: z.uuid(), tenantName: z.string(), role: Role })),
});

export const MemberDto = z.object({
  userId: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: Role,
  createdAt: iso,
});
export const UpdateMemberBody = z.object({ role: Role });

export const InvitationDto = z.object({
  id: z.uuid(),
  email: z.string(),
  role: Role,
  createdAt: iso,
  acceptedAt: iso.nullable(),
  revokedAt: iso.nullable(),
});
export const CreateInvitationBody = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: Role,
});

export const ClientDto = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['active', 'paused', 'offboarded']),
  createdAt: iso,
});
export const CreateClientBody = z.object({ name: z.string().trim().min(1).max(120) });
export const UpdateClientBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['active', 'paused', 'offboarded']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nada que actualizar');
export const PutAssignmentsBody = z.object({ userIds: z.array(z.uuid()).max(200) });

export const ConsentDto = z.object({
  id: z.uuid(),
  scope: z.array(z.enum(CONSENT_SCOPES)),
  grantedByName: z.string(),
  grantedByEmail: z.string(),
  evidenceRef: z.string().nullable(),
  grantedAt: iso,
  revokedAt: iso.nullable(),
});
export const CreateConsentBody = z.object({
  scope: z.array(z.enum(CONSENT_SCOPES)).min(1),
  grantedByName: z.string().trim().min(1).max(120),
  grantedByEmail: z.email(),
  evidenceRef: z.string().trim().max(500).optional(),
  grantedAt: iso,
});

/** Nunca incluye el token: solo su huella (docs/SECURITY.md §4.4). */
export const ConnectionDto = z.object({
  id: z.uuid(),
  kind: z.enum(['system_user', 'user', 'business_integration']),
  label: z.string(),
  metaAppId: z.string(),
  metaBusinessId: z.string().nullable(),
  tokenFingerprint: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['pending', 'active', 'invalid', 'revoked']),
  expiresAt: iso.nullable(),
  lastValidatedAt: iso.nullable(),
  createdAt: iso,
});
export const CreateConnectionBody = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(['system_user', 'user', 'business_integration']).default('system_user'),
  metaAppId: z.string().regex(/^\d+$/, 'solo dígitos'),
  metaBusinessId: z.string().regex(/^\d+$/, 'solo dígitos').optional(),
  accessToken: z.string().trim().min(20).max(1000), // campo de solo escritura
});

export const AdAccountDto = z.object({
  id: z.uuid(),
  metaAccountId: z.string(),
  name: z.string(),
  currency: z.string(),
  timezoneName: z.string(),
  accountStatus: z.number().int(),
  clientId: z.uuid().nullable(),
  syncEnabled: z.boolean(),
  userTasks: z.array(z.string()),
  lastDiscoveredAt: iso.nullable(),
  lastEntitiesSyncAt: iso.nullable(),
  lastInsightsSyncAt: iso.nullable(),
});
export const UpdateAdAccountBody = z
  .object({ clientId: z.uuid().nullable().optional(), syncEnabled: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, 'nada que actualizar');

export const SyncRunDto = z.object({
  id: z.number().int(),
  kind: z.string(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed', 'throttled']),
  apiVersion: z.string(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  startedAt: iso,
  finishedAt: iso.nullable(),
  apiCalls: z.number().int(),
  rowsUpserted: z.number().int(),
  errorCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(), // redactado al guardarlo
});

export const CampaignDto = z.object({
  metaId: z.string(),
  name: z.string(),
  objective: z.string().nullable(),
  status: z.string().nullable(),
  effectiveStatus: z.string().nullable(),
  dailyBudgetMinor: z.number().int().nullable(),
  lifetimeBudgetMinor: z.number().int().nullable(),
});

export const FindingDto = z.object({
  id: z.uuid(),
  adAccountId: z.uuid(),
  kind: z.enum(['audit', 'alert']),
  ruleId: z.string(),
  ruleVersion: z.number().int(),
  entityLevel: Level,
  entityMetaId: z.string(),
  severity: z.enum(SEVERITIES),
  confidence: z.string(),
  priority: z.string(),
  impact: z.unknown(),
  evidence: z.unknown(),
  recommendationKey: z.string(),
  status: z.enum(FINDING_STATUSES),
  firstSeenAt: iso,
  lastSeenAt: iso,
  decisionReason: z.string().nullable(),
  // Motor de auditoría (F3)
  category: z.string().nullable(),
  profile: z.string().nullable(),
  explanation: z.string().nullable(),
  recommendationText: z.string().nullable(),
  engineVersion: z.string().nullable(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  resolvedAt: iso.nullable(),
  /** Solo en selecciones agrupadas; recuento dentro del mismo alcance y estado. */
  groupedCount: z.number().int().positive().optional(),
});
export const FindingsQuery = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
  adAccountId: z.uuid().optional(),
  /** Selección acotada para la bandeja de revisión; los consumidores anteriores conservan su lista. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  groupBy: z.literal('account_rule').optional(),
});
export const FindingDecisionBody = z.object({
  status: z.enum(['acknowledged', 'dismissed', 'resolved']),
  reason: z.string().trim().min(3).max(1000),
});

export const RecommendationDto = z.object({
  id: z.uuid(),
  adAccountId: z.uuid(),
  findingId: z.uuid().nullable(),
  entityLevel: Level,
  entityMetaId: z.string(),
  actionType: z.enum(RECOMMENDATION_ACTIONS),
  params: z.unknown(),
  rationale: z.string(),
  expectedImpact: z.unknown(),
  source: z.enum(['rule', 'ai', 'user']),
  status: z.enum(RECOMMENDATION_STATUSES),
  createdAt: iso,
  decisionReason: z.string().nullable(),
});
export const RecommendationsQuery = z.object({
  status: z.enum(RECOMMENDATION_STATUSES).optional(),
  adAccountId: z.uuid().optional(),
});
export const RecommendationDecisionBody = z.object({
  status: z.enum(['accepted', 'dismissed']),
  reason: z.string().trim().min(3).max(1000),
});

export const AuditEventDto = z.object({
  id: z.number().int(),
  at: iso,
  actorType: z.enum(['user', 'system', 'ai']),
  actorId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  requestId: z.string().nullable(),
});
export const AuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

// --- Analítica (F2)
const day = z.iso.date();
const NodeLevel = z.enum(NODE_LEVELS);
const num = z.number().nullable();
const TotalsDto = z.object(
  Object.fromEntries(BASE_FIELDS.map((f) => [f, num])) as Record<BaseField, typeof num>,
);

const analyticsQueryShape = {
  level: NodeLevel.default('org'),
  /** uuid del cliente o la cuenta ("none": cuentas sin cliente); id de Meta de campaña, conjunto o anuncio. */
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  preset: z.enum(PRESET_IDS).optional(),
  since: day.optional(),
  until: day.optional(),
  compare: z.enum(['previous', 'year', 'none']).default('previous'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
};
const validRange = (q: { since?: string; until?: string }) =>
  (q.since === undefined) === (q.until === undefined) &&
  (!q.since || !q.until || (q.since <= q.until && daysBetween(q.since, q.until) <= 1130));
const RANGE_ERROR = {
  message: 'rango no válido: since y until juntos, en orden y como máximo 37 meses',
};

export const AnalyticsQuery = z.object(analyticsQueryShape).refine(validRange, RANGE_ERROR);
export const AnalyticsExportQuery = z
  .object({
    ...analyticsQueryShape,
    /** Ids de métricas del catálogo separados por comas. */
    columns: z
      .string()
      .regex(/^[A-Za-z,]{1,500}$/)
      .optional(),
  })
  .refine(validRange, RANGE_ERROR);

const StatusKind = z.enum(['client', 'account', 'delivery']);
const ChildRowDto = z.object({
  id: z.string(),
  name: z.string(),
  statusKind: StatusKind,
  status: z.string().nullable(),
  deleted: z.boolean(),
  learning: z.string().nullable(),
  objective: z.string().nullable(),
  currency: z.string().nullable(),
  lastSyncAt: iso.nullable(),
  accounts: z.number().int(),
  current: TotalsDto,
  previous: TotalsDto.nullable(),
  resultTypes: z.array(z.string()),
  previousResultTypes: z.array(z.string()),
  sources: z.number().int(),
});

export const AnalyticsReportDto = z.object({
  node: z.object({
    level: NodeLevel,
    id: z.string().nullable(),
    name: z.string(),
    statusKind: StatusKind,
    status: z.string().nullable(),
    deleted: z.boolean(),
    learning: z.string().nullable(),
    objective: z.string().nullable(),
    accountId: z.uuid().nullable(),
  }),
  path: z.array(z.object({ level: NodeLevel, id: z.string().nullable(), name: z.string() })),
  range: z.object({
    since: day,
    until: day,
    days: z.number().int(),
    preset: z.string().nullable(),
  }),
  compare: z
    .object({ mode: z.enum(['previous', 'year', 'none']), since: day, until: day })
    .nullable(),
  today: day,
  timezones: z.array(z.string()),
  currency: z.string().nullable(),
  currencies: z.array(z.object({ code: z.string(), accounts: z.number().int(), spend: num })),
  totals: z.object({
    current: TotalsDto,
    previous: TotalsDto.nullable(),
    resultTypes: z.array(z.string()),
    previousResultTypes: z.array(z.string()),
    sources: z.number().int(),
  }),
  attribution: z.array(z.string()),
  series: z.array(
    z.object({
      date: day,
      previousDate: day.nullable(),
      current: TotalsDto,
      previous: TotalsDto.nullable(),
    }),
  ),
  results: z.array(z.object({ indicator: z.string(), current: num, previous: num })),
  children: z.object({ level: NodeLevel, rows: z.array(ChildRowDto) }).nullable(),
  freshness: z.object({
    accounts: z.number().int(),
    syncEnabled: z.number().int(),
    neverSynced: z.number().int(),
    oldestSyncAt: iso.nullable(),
    newestSyncAt: iso.nullable(),
    dataUntil: day.nullable(),
    immatureFrom: day,
    finalBefore: day,
  }),
});

// --- Motor de auditoría y salud (F3)
const Grade = z.enum(['excellent', 'good', 'attention', 'critical', 'insufficient']);
export const HealthDto = z.object({
  level: Level,
  entityId: z.string(),
  date: day,
  formulaVersion: z.string(),
  profile: z.string(),
  windowDays: z.number().int(),
  score: z.number().nullable(),
  grade: Grade,
  coverage: z.number(),
  confidence: z.number().nullable(),
  /** [{id, status, value, reference, referenceSource, q, s, weight, confidence, n, note}] */
  components: z.array(z.record(z.string(), z.unknown())),
});
export const AuditEntityQuery = z.object({
  level: Level,
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});
export const AuditEntityDto = z.object({
  health: HealthDto.nullable(),
  history: z.array(z.object({ date: day, score: z.number().nullable(), grade: Grade })),
  findings: z.array(FindingDto.extend({ entityName: z.string().nullable() })),
  childrenHealth: z.record(z.string(), z.object({ score: z.number().nullable(), grade: Grade })),
});
export const AuditRunBody = z.object({ asOf: day.optional() });
export const AuditRunDto = z.object({
  runId: z.number().int(),
  asOf: day,
  inputHash: z.string(),
  engineVersion: z.string(),
  stats: z.record(z.string(), z.number()),
});
export const AuditCatalogDto = z.object({
  engineVersion: z.string(),
  formulaVersion: z.string(),
  categories: z.record(z.string(), z.string()),
  profiles: z.record(z.string(), z.string()),
  subindices: z.record(z.string(), z.string()),
  rules: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      category: z.string(),
      title: z.string(),
      description: z.string(),
      method: z.string(),
      minSample: z.string(),
      levels: z.array(z.string()),
      profiles: z.union([z.literal('all'), z.array(z.string())]),
      statistical: z.boolean(),
      defaults: z.record(z.string(), z.unknown()),
      paramsSchema: z.unknown(),
    }),
  ),
  defaults: z.unknown(),
});
export const AuditConfigQuery = z.object({ clientId: z.uuid().optional() });
export const AuditConfigDto = z.object({
  effective: z.unknown(),
  organization: z.unknown().nullable(),
  client: z.unknown().nullable(),
});
export const PutAuditConfigBody = z.object({
  clientId: z.uuid().nullable().default(null),
  patch: AuditConfigPatch,
});

// --- Asistente de IA (F4)

export const AiAskBody = z.object({
  conversationId: z.uuid().nullable().default(null),
  question: z.string().trim().min(3).max(2000),
  /** Vista desde la que se pregunta (contexto para el modelo, no un permiso). */
  view: z
    .object({ level: z.enum(NODE_LEVELS), id: z.string().max(64).nullable() })
    .nullable()
    .default(null),
});
export const AiAnswerDto = Answer.extend({
  recommendations: z.array(Answer.shape.recommendations.element.extend({ priority: z.number() })),
});
export const AiVerificationDto = z.object({
  status: z.enum(['verified', 'unverified']),
  issues: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
  figures: z.object({ checked: z.number(), verified: z.number() }),
});
export const AiEvidenceDto = z.object({
  toolUseId: z.string(),
  evidenceId: z.string().nullable(),
  tool: z.string(),
  input: z.unknown(),
  status: z.enum(['ok', 'error']),
  sufficiency: z.enum(SUFFICIENCY).nullable(),
  ms: z.number(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export const AiMessageDto = z.object({
  id: z.number(),
  role: z.enum(['user', 'assistant']),
  content: z.string().nullable(),
  status: z.enum(AI_TURN_STATUSES).nullable(),
  answer: AiAnswerDto.nullable(),
  verification: AiVerificationDto.nullable(),
  evidence: z.array(AiEvidenceDto),
  injectionFlags: z.number(),
  costUsd: z.number().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  createdAt: iso,
});
export const AiTurnDto = z.object({ conversationId: z.uuid(), message: AiMessageDto });
export const AiConversationDto = z.object({
  id: z.uuid(),
  title: z.string(),
  model: z.string(),
  createdAt: iso,
  updatedAt: iso,
});
export const AiConversationDetailDto = AiConversationDto.extend({
  messages: z.array(AiMessageDto),
});
export const AiTraceDto = z.object({
  messageId: z.number(),
  evidence: z.array(AiEvidenceDto.extend({ output: z.unknown() })),
  usage: z.unknown(),
});
export const AiStatusDto = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  unavailableReason: z.string().nullable(),
  costBasis: z.enum(['published_tariff', 'budget_estimate']),
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  budgets: z.object({
    monthlyUsd: z.number(),
    spentMonthUsd: z.number(),
    userDailyUsd: z.number(),
    spentTodayUsd: z.number(),
    perQuestionUsd: z.number(),
  }),
});
export const AiMessageParams = z.object({ id: z.coerce.number().int().positive() });
export const AiProposeParams = AiMessageParams.extend({
  index: z.coerce.number().int().min(0).max(5),
});

// --- Pronóstico y simulación (F6). Se calculan al pedirlos desde insights_daily; los
// experimentos de presupuesto guardan su diseño (budget_experiments).

const MetaOrUuid = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const CampaignId = z.string().regex(/^\d{1,30}$/);
const EventCategory = z.enum(EVENT_CATEGORIES);
/** Evento propio: promoción, festivo por decreto o incidencia (esta solo se excluye). */
const UserEventDto = z
  .object({
    since: day,
    until: day,
    label: z.string().trim().min(1).max(80),
    category: EventCategory,
    yearly: z.boolean().default(false),
  })
  .refine((r) => r.since <= r.until && daysBetween(r.since, r.until) <= 62, {
    message: 'since ≤ until y como mucho 62 días',
  });
const CalendarEventDto = z.object({
  key: z.string(),
  label: z.string(),
  category: EventCategory,
  since: day,
  until: day,
  source: z.enum(['builtin', 'user']),
});
const ForecastStatus = z.enum(['published', 'not_published', 'insufficient_data', 'paused']);
const Band = z.object({ point: z.number(), lower: z.number(), upper: z.number() });
const Quantiles = z.object({ p10: z.number(), p50: z.number(), p90: z.number() });
const calendarShape = {
  /** Eventos propios (se suman al calendario incorporado). */
  events: z.array(UserEventDto).max(50).default([]),
  /** Festivos y fechas comerciales incorporados (Honduras y región) y días de pago. */
  builtinCalendar: z.boolean().default(true),
};

export const ForecastBody = z.object({
  level: z.enum(['account', 'campaign']),
  id: MetaOrUuid,
  horizonDays: z.number().int().min(7).max(56).default(28),
  /** Último día observado (por defecto, ayer en la zona horaria de la cuenta). */
  asOf: day.optional(),
  ...calendarShape,
});
const ModelScoreDto = z.object({
  model: z.string(),
  label: z.string(),
  mae: z.number().nullable(),
  mase: num,
  relMae: num,
  wapeTotal: num,
  biasTotal: num,
});
const EventEffectDto = z.object({
  key: z.string(),
  label: z.string(),
  category: EventCategory,
  occurrences: z.number().int(),
  /** Multiplicador sobre el día normal: central e intervalo del 80 %. */
  effect: Band,
  source: z.enum(['history', 'prior']),
});
const ForecastMetricDto = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.enum(['currency', 'count']),
  conversion: z.boolean(),
  status: ForecastStatus,
  reasons: z.array(z.string()),
  usableDays: z.number().int(),
  requiredDays: z.number().int(),
  recentDailyMean: z.number(),
  anomalies: z.array(day),
  backtest: z
    .object({
      origins: z.number().int(),
      selectionOrigins: z.number().int(),
      evaluationOrigins: z.number().int(),
      selectionScores: z.array(ModelScoreDto),
      chosen: z.string().nullable(),
      chosenLabel: z.string().nullable(),
      method: z.string().nullable(),
      scores: z.array(ModelScoreDto),
      calibration: z
        .object({
          evaluated: z.number().int(),
          dailyCoverage: num,
          totalCoverage: num,
          eventDays: z.number().int(),
          eventCoverage: num,
        })
        .nullable(),
    })
    .nullable(),
  events: z.array(EventEffectDto),
  history: z.array(
    z.object({ date: day, value: num, immature: z.boolean(), event: z.string().nullable() }),
  ),
  forecast: z.array(Band.extend({ date: day, event: z.string().nullable() })).nullable(),
  total: Band.nullable(),
});
const ForecastRatioDto = z.object({
  id: z.string(),
  label: z.string(),
  status: ForecastStatus,
  reasons: z.array(z.string()),
  evaluated: z.number().int(),
  coverage: num,
  total: Band.nullable(),
});
export const ForecastDto = z.object({
  version: z.string(),
  node: z.object({
    level: z.enum(['account', 'campaign']),
    id: z.string(),
    name: z.string(),
    accountId: z.uuid(),
    currency: z.string(),
    timezone: z.string(),
  }),
  asOf: day,
  /** Último día que entra en el ajuste: asOf menos los días de maduración. */
  cut: day,
  horizonDays: z.number().int(),
  gapDays: z.number().int(),
  start: day.nullable(),
  usableDays: z.number().int(),
  requiredDays: z.number().int(),
  breaks: z.array(z.object({ date: day, reason: z.enum(['attribution', 'pause']) })),
  events: z.array(UserEventDto),
  builtinCalendar: z.boolean(),
  /** Eventos que caen en el horizonte. */
  calendar: z.array(CalendarEventDto),
  criteria: z.record(z.string(), z.unknown()),
  metrics: z.array(ForecastMetricDto),
  ratios: z.array(ForecastRatioDto),
  assumptions: z.array(z.string()),
  limitations: z.array(z.string()),
  inputHash: z.string(),
});

export const SimulationBody = z.object({
  adAccountId: z.uuid(),
  horizonDays: z.number().int().min(7).max(91).default(28),
  asOf: day.optional(),
  ...calendarShape,
  /** Gasto diario planificado por campaña; las demás mantienen el gasto actual. */
  changes: z
    .array(z.object({ campaignId: CampaignId, dailySpend: z.number().min(0).max(1e9) }))
    .max(500)
    .default([]),
  seed: z.number().int().min(0).max(2_147_483_647).default(1),
});
const CostQuantiles = z.object({ p10: num, p50: num, p90: num });
const ExperimentResultDto = z.object({
  periods: z.number().int(),
  analyzed: z.number().int(),
  complete: z.boolean(),
  elasticity: Band.extend({ se: z.number() }).nullable(),
  firstStage: z.object({ slope: z.number(), se: z.number(), f: z.number() }).nullable(),
  compliance: num,
  reasons: z.array(z.string()),
});
const SimulationCampaignDto = z.object({
  id: z.string(),
  name: z.string(),
  effectiveStatus: z.string().nullable(),
  profile: z.string(),
  profileLabel: z.string(),
  kpi: z.object({ field: z.string(), label: z.string(), costLabel: z.string() }),
  currentDailySpend: z.number(),
  plannedDailySpend: z.number(),
  status: z.enum(['published', 'not_published', 'insufficient_data']),
  reasons: z.array(z.string()),
  curve: z
    .object({
      weeks: z.number().int(),
      events: z.number(),
      /** Elasticidad observada en el gasto actual (ajustada por tendencia, eventos y otras campañas). */
      elasticity: Band,
      learned: z.number(),
      /** Elasticidad para un cambio de gasto: observada + confusión, o la del experimento. */
      causal: Band.extend({
        source: z.enum(['observational', 'experiment']),
      }),
      curvature: Band,
      /** Efecto del gasto de las otras campañas con el mismo evento (null si no hay). */
      spillover: Band.nullable(),
      trend: Band,
      phi: z.number(),
      shockSd: z.number(),
      spendRange: z.tuple([z.number(), z.number()]),
    })
    .nullable(),
  validation: z
    .object({
      oneStep: z.object({ evaluated: z.number().int(), coverage: num, relMae: num }),
      extremes: z.object({
        evaluated: z.number().int(),
        coverage: num,
        reachAbove: z.number(),
        reachBelow: z.number(),
      }),
    })
    .nullable(),
  /** Gasto diario con escenarios publicables (fuera, no se publica). */
  validatedRange: z
    .object({ minDaily: z.number(), maxDaily: z.number(), reliableShape: z.boolean() })
    .nullable(),
  experiment: z.object({ id: z.uuid(), startDate: day, result: ExperimentResultDto }).nullable(),
  outcome: z
    .object({
      spend: z.number(),
      events: Quantiles,
      cost: CostQuantiles,
      probNoEvents: z.number(),
      expectedChange: Quantiles,
      extrapolation: z.boolean(),
      largeChange: z.boolean(),
    })
    .nullable(),
});
export const SimulationDto = z.object({
  version: z.string(),
  account: z.object({ id: z.uuid(), name: z.string(), currency: z.string(), timezone: z.string() }),
  asOf: day,
  cut: day,
  horizonDays: z.number().int(),
  seed: z.number().int(),
  draws: z.number().int(),
  campaigns: z.array(SimulationCampaignDto),
  totals: z.array(
    z.object({
      field: z.string(),
      label: z.string(),
      costLabel: z.string(),
      campaigns: z.number().int(),
      spend: z.number(),
      events: Quantiles,
      cost: CostQuantiles,
      probNoEvents: z.number(),
      expectedChange: Quantiles,
      /** Correlación media de los choques semanales entre sus campañas. */
      correlation: num,
    }),
  ),
  spend: z.object({ current: z.number(), planned: z.number(), notSimulated: z.number() }),
  priors: z.record(z.string(), z.unknown()),
  confounding: z.object({
    sd: z.number(),
    source: z.enum(['default', 'experiments']),
    experiments: z.number().int(),
  }),
  assumptions: z.array(z.string()),
  limitations: z.array(z.string()),
  inputHash: z.string(),
});

export const ExperimentBody = z
  .object({
    adAccountId: z.uuid(),
    campaignId: CampaignId,
    /** Multiplicadores del gasto diario de referencia (p. ej. 0,8 · 1 · 1,25). */
    levels: z.array(z.number().min(0.3).max(3)).min(2).max(5).default([0.8, 1, 1.25]),
    /** Bloques: cada uno contiene cada nivel una vez (periodos = bloques × niveles). */
    blocks: z.number().int().min(2).max(8).default(3),
    startDate: day,
    burnInDays: z.number().int().min(0).max(5).default(2),
    /** Gasto diario de referencia; por defecto, la media de los últimos 28 días. */
    baseDailySpend: z.number().positive().max(1e9).optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .refine((b) => new Set(b.levels).size === b.levels.length, 'los niveles deben ser distintos');
export const ExperimentListQuery = z.object({ adAccountId: z.uuid() });
const ExperimentScheduleDto = z.array(
  z.object({
    period: z.number().int(),
    since: day,
    until: day,
    multiplier: z.number(),
    dailySpend: z.number(),
  }),
);
export const ExperimentPreviewDto = z.object({
  campaignId: z.string(),
  campaignName: z.string(),
  kpi: z.object({ field: z.string(), label: z.string() }),
  baseDailySpend: z.number(),
  burnInDays: z.number().int(),
  seed: z.number().int(),
  schedule: ExperimentScheduleDto,
  /** Error típico esperado de la elasticidad y diferencia detectable (α 0,05, potencia 80 %). */
  power: z.object({ se: z.number(), detectable: z.number() }).nullable(),
  observed: z.object({ mean: z.number(), sd: z.number() }).nullable(),
  warnings: z.array(z.string()),
});
export const ExperimentDto = ExperimentPreviewDto.extend({
  id: z.uuid(),
  status: z.enum(['planned', 'running', 'awaiting_data', 'complete', 'cancelled']),
  startDate: day,
  endDate: day,
  levels: z.array(z.number()),
  result: ExperimentResultDto,
  createdAt: iso,
  cancelledAt: iso.nullable(),
});

export type Me = z.infer<typeof MeDto>;
export type Member = z.infer<typeof MemberDto>;
export type Invitation = z.infer<typeof InvitationDto>;
export type Client = z.infer<typeof ClientDto>;
export type Consent = z.infer<typeof ConsentDto>;
export type Connection = z.infer<typeof ConnectionDto>;
export type AdAccount = z.infer<typeof AdAccountDto>;
export type Campaign = z.infer<typeof CampaignDto>;
export type SyncRun = z.infer<typeof SyncRunDto>;
export type Finding = z.infer<typeof FindingDto>;
export type Recommendation = z.infer<typeof RecommendationDto>;
export type AuditEvent = z.infer<typeof AuditEventDto>;
export type AnalyticsReport = z.infer<typeof AnalyticsReportDto>;
export type AnalyticsChildRow = z.infer<typeof ChildRowDto>;
export type Health = z.infer<typeof HealthDto>;
export type AuditEntity = z.infer<typeof AuditEntityDto>;
export type AuditCatalog = z.infer<typeof AuditCatalogDto>;
export type AiAnswer = z.infer<typeof AiAnswerDto>;
export type AiMessage = z.infer<typeof AiMessageDto>;
export type AiTurn = z.infer<typeof AiTurnDto>;
export type AiConversation = z.infer<typeof AiConversationDto>;
export type AiConversationDetail = z.infer<typeof AiConversationDetailDto>;
export type AiStatus = z.infer<typeof AiStatusDto>;
export type AiTrace = z.infer<typeof AiTraceDto>;
export type Forecast = z.infer<typeof ForecastDto>;
export type ForecastMetric = z.infer<typeof ForecastMetricDto>;
export type Simulation = z.infer<typeof SimulationDto>;
export type SimulationCampaign = z.infer<typeof SimulationCampaignDto>;
export type Experiment = z.infer<typeof ExperimentDto>;
export type ExperimentPreview = z.infer<typeof ExperimentPreviewDto>;

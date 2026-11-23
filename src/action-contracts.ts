import { z } from 'zod';

import { ACTION_STATES, ACTION_TYPES } from './domain.ts';

export { ACTION_STATES, ACTION_TYPES } from './domain.ts';

const minor = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})$/, 'Importe entero en unidades menores, sin decimales');
const reason = z.string().trim().min(8).max(1000);
export const ActionPolicy = z
  .object({
    enabled: z.boolean().default(false),
    allowedOperations: z.array(z.enum(ACTION_TYPES)).max(ACTION_TYPES.length).default(['pause']),
    maxBudgetMinor: minor.default('0'),
    maxDailyIncreaseMinor: minor.default('0'),
    maxChangePct: z.number().positive().max(100).default(20),
    maxCumulativeChangePct: z.number().positive().max(200).default(30),
    doubleApprovalPct: z.number().nonnegative().max(100).default(10),
    startHour: z.number().int().min(0).max(23).default(0),
    endHour: z.number().int().min(1).max(24).default(24),
  })
  .refine((p) => p.startHour < p.endHour, 'La ventana no puede cruzar medianoche');
export const ActionPolicyBody = z.object({ policy: ActionPolicy, reason });
export const ActionCreateBody = z.object({
  recommendationId: z.uuid(),
  idempotencyKey: z.uuid(),
  budgetMinor: minor.optional(),
  reason,
});
const AdSetProposal = z.object({
  adAccountId: z.uuid(),
  adSetId: z.string().regex(/^\d{1,30}$/),
  idempotencyKey: z.uuid(),
  reason,
});
export const AdSetStatusProposalBody = AdSetProposal.extend({
  operation: z.enum(['pause', 'activate']),
});
export const ScheduleProposalBody = AdSetProposal.extend({
  days: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'Los días deben ser únicos'),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
}).refine((body) => body.startHour < body.endHour, 'El horario debe terminar después de empezar');
export const ScheduleWindow = z.object({
  days: z.array(z.number().int().min(0).max(6)),
  start_minute: z.number().int().min(0).max(1439),
  end_minute: z.number().int().min(1).max(1440),
  timezone_type: z.enum(['USER', 'ADVERTISER']),
});
export const ActionDecisionBody = z.object({
  revision: z.number().int().nonnegative(),
  previewHash: z.string().length(64),
  authorize: z.literal(true),
  reason,
});
export const ActionRevisionBody = z.object({ revision: z.number().int().nonnegative() });
export const ActionCloseBody = ActionRevisionBody.extend({
  reason,
  acknowledgeUnknown: z.boolean().default(false),
});
export const ActionRollbackBody = z.object({ idempotencyKey: z.uuid(), reason });
export const ActionQuery = z.object({ adAccountId: z.uuid().optional() });
export const ActionSnapshot = z.object({
  id: z.string(),
  accountId: z.string(),
  status: z.string(),
  effectiveStatus: z.string(),
  dailyBudget: minor,
  lifetimeBudget: minor,
  scheduleEnabled: z.boolean(),
  weeklySchedule: z.string().optional(),
  pacing: z.array(z.string()).optional(),
  campaignId: z.string().nullable(),
  adsetId: z.string().nullable(),
  parentDailyBudget: minor,
  parentLifetimeBudget: minor,
  adsetDailyBudget: minor,
  adsetLifetimeBudget: minor,
  parentStatus: z.string().nullable(),
  adsetStatus: z.string().nullable(),
  endTime: z.string().nullable(),
  currency: z.string(),
  timezone: z.string(),
});
export const ActionPreview = z.object({
  snapshot: ActionSnapshot,
  field: z.enum(['status', 'daily_budget', 'lifetime_budget', 'adset_schedule']),
  before: z.string(),
  after: z.string(),
  hash: z.string(),
  policyHash: z.string(),
  expiresAt: z.iso.datetime(),
  changePct: z.number(),
  increaseMinor: minor,
  requiredApprovals: z.number().int(),
  warnings: z.array(z.string()),
});
export const ActionDto = z.object({
  id: z.uuid(),
  adAccountId: z.uuid(),
  recommendationId: z.uuid().nullable(),
  rollbackOf: z.uuid().nullable(),
  entityLevel: z.enum(['campaign', 'adset', 'ad']),
  entityMetaId: z.string(),
  operation: z.enum(ACTION_TYPES),
  desired: z.string(),
  reason: z.string(),
  state: z.enum(ACTION_STATES),
  revision: z.number().int(),
  proposedBy: z.uuid(),
  proposedByName: z.string().nullable().optional(),
  preview: ActionPreview.nullable(),
  approvals: z.array(z.object({ userId: z.uuid(), at: z.iso.datetime() })),
  after: ActionSnapshot.nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  dispatchAt: z.iso.datetime().nullable(),
  confirmedWrite: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const ActionEventDto = z.object({
  id: z.number(),
  event: z.string(),
  actorId: z.uuid().nullable(),
  at: z.iso.datetime(),
  data: z.unknown(),
});
export const ActionPolicyDto = z.object({
  adAccountId: z.uuid(),
  globalEnabled: z.boolean(),
  policy: ActionPolicy,
});
export type BudgetAction = z.infer<typeof ActionDto>;
export type Policy = z.infer<typeof ActionPolicy>;
export type Snapshot = z.infer<typeof ActionSnapshot>;
export type Preview = z.infer<typeof ActionPreview>;

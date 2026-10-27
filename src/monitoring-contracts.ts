import { z } from 'zod';
import { SEVERITIES } from './domain.ts';

export const MonitorRule = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    kind: z.enum([
      'cpr_increase',
      'results_drop',
      'spend_without_results',
      'audit',
      'connection',
      'sync_stale',
      'recommendation_stale',
      'action_failed',
    ]),
    enabled: z.boolean(),
    severity: z.enum(SEVERITIES),
    threshold: z.number().finite().nonnegative().max(100000000),
    minSpend: z.number().finite().nonnegative().max(100000000),
    minResults: z.number().int().min(1).max(1000000),
  })
  .superRefine((r, ctx) => {
    if (r.kind === 'results_drop' && (r.threshold <= 0 || r.threshold > 100))
      ctx.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'La caída debe ser mayor que 0 y como máximo 100%.',
      });
    if (
      ['sync_stale', 'recommendation_stale', 'action_failed', 'cpr_increase'].includes(r.kind) &&
      r.threshold <= 0
    )
      ctx.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'El umbral debe ser positivo.',
      });
    if (r.kind === 'audit' && (!Number.isInteger(r.threshold) || r.threshold < 1))
      ctx.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'Indica al menos un hallazgo.',
      });
  });
export const MonitorPolicy = z.object({
  enabled: z.boolean(),
  windowDays: z.number().int().min(1).max(28),
  baselineDays: z.number().int().min(7).max(84),
  maturityDays: z.number().int().min(1).max(28),
  openAfter: z.number().int().min(1).max(7),
  resolveAfter: z.number().int().min(1).max(7),
  cooldownHours: z.number().int().min(1).max(168),
  rules: z
    .array(MonitorRule)
    .min(1)
    .max(20)
    .refine((r) => new Set(r.map((x) => x.id)).size === r.length, 'IDs duplicados'),
  notifications: z.object({
    inApp: z.boolean(),
    email: z.boolean(),
    recipientIds: z
      .array(z.uuid())
      .max(20)
      .refine((r) => new Set(r).size === r.length, 'Destinatarios duplicados'),
    minSeverity: z.enum(SEVERITIES),
    quietStart: z.number().int().min(0).max(23),
    quietEnd: z.number().int().min(0).max(23),
    maxPerDay: z.number().int().min(1).max(24),
  }),
  followupDays: z.union([z.literal(7), z.literal(14), z.literal(28)]),
  reportEveryDays: z.union([z.literal(0), z.literal(1), z.literal(7), z.literal(28)]),
  externalEvents: z
    .array(
      z
        .object({
          since: z.iso.date(),
          until: z.iso.date(),
          label: z.string().trim().min(3).max(200),
        })
        .refine((e) => e.until >= e.since, 'Rango invertido'),
    )
    .max(50),
});
export type MonitoringPolicy = z.infer<typeof MonitorPolicy>;
export const PolicyBody = z.object({
  revision: z.number().int().min(0),
  reason: z.string().trim().min(5).max(1000),
  policy: MonitorPolicy,
});
export const IncidentDecision = z
  .object({
    revision: z.number().int().positive(),
    status: z.enum(['acknowledged', 'snoozed', 'dismissed', 'open']),
    reason: z.string().trim().min(5).max(1000),
    snoozeHours: z.number().int().min(1).max(168).optional(),
  })
  .refine((b) => b.status !== 'snoozed' || b.snoozeHours !== undefined, 'Indica horas de silencio');
export const ReportBody = z.object({
  days: z.union([z.literal(7), z.literal(28), z.literal(84)]).default(28),
});

export const defaultMonitorPolicy = (): MonitoringPolicy => ({
  enabled: false,
  windowDays: 7,
  baselineDays: 28,
  maturityDays: 3,
  openAfter: 2,
  resolveAfter: 2,
  cooldownHours: 24,
  rules: [
    {
      id: 'cpr',
      kind: 'cpr_increase',
      enabled: true,
      severity: 'high',
      threshold: 50,
      minSpend: 50,
      minResults: 10,
    },
    {
      id: 'results',
      kind: 'results_drop',
      enabled: true,
      severity: 'medium',
      threshold: 50,
      minSpend: 50,
      minResults: 10,
    },
    {
      id: 'no_results',
      kind: 'spend_without_results',
      enabled: true,
      severity: 'high',
      threshold: 100,
      minSpend: 100,
      minResults: 1,
    },
    {
      id: 'audit',
      kind: 'audit',
      enabled: true,
      severity: 'medium',
      threshold: 1,
      minSpend: 0,
      minResults: 1,
    },
    {
      id: 'connection',
      kind: 'connection',
      enabled: true,
      severity: 'critical',
      threshold: 1,
      minSpend: 0,
      minResults: 1,
    },
    {
      id: 'sync',
      kind: 'sync_stale',
      enabled: true,
      severity: 'high',
      threshold: 24,
      minSpend: 0,
      minResults: 1,
    },
    {
      id: 'recommendation',
      kind: 'recommendation_stale',
      enabled: true,
      severity: 'low',
      threshold: 7,
      minSpend: 0,
      minResults: 1,
    },
    {
      id: 'action',
      kind: 'action_failed',
      enabled: true,
      severity: 'high',
      threshold: 7,
      minSpend: 0,
      minResults: 1,
    },
  ],
  notifications: {
    inApp: true,
    email: false,
    recipientIds: [],
    minSeverity: 'high',
    quietStart: 22,
    quietEnd: 8,
    maxPerDay: 3,
  },
  followupDays: 14,
  reportEveryDays: 0,
  externalEvents: [],
});

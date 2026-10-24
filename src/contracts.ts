import { z } from 'zod';
import {
  CONSENT_SCOPES,
  FINDING_STATUSES,
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_STATUSES,
  ROLES,
  SEVERITIES,
} from './domain.ts';

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
});
export const FindingsQuery = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
  adAccountId: z.uuid().optional(),
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

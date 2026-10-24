// Esquema de datos (docs/DATABASE_SCHEMA.md). Las políticas RLS, los permisos y las funciones
// de contexto van en una migración SQL explícita (migrations/*_rls.sql).
//
// Aislamiento: toda tabla de un tenant lleva tenant_id y RLS forzado. Las referencias entre
// tablas de un tenant usan claves foráneas COMPUESTAS (tenant_id, id): Postgres comprueba las
// FK sin aplicar RLS, y una FK simple dejaría enlazar una fila propia con un id de otro tenant.
import { type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CONSENT_SCOPES,
  FINDING_STATUSES,
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_STATUSES,
  ROLES,
  SEVERITIES,
} from '../domain.ts';

export { ROLES, type Role } from '../domain.ts';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const oneOf = (column: SQL, values: readonly string[]) =>
  sql`${column} in (${sql.join(
    values.map((v) => sql.raw(`'${v}'`)),
    sql`, `,
  )})`;

// --- Autenticación (Better Auth, ADR-019). Tablas globales: un usuario puede pertenecer a
// varios tenants; el acceso a datos lo da `memberships`.
export const authUsers = pgTable('auth_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const authAccounts = pgTable('auth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'), // cifrados por Better Auth (account.encryptOAuthTokens)
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'), // sin uso: no hay contraseñas locales
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const authVerifications = pgTable('auth_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// --- Organizaciones (tenants) y acceso
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
  },
  (t) => [check('tenants_status_check', oneOf(sql`${t.status}`, ['active', 'suspended']))],
);

export const memberships = pgTable(
  'memberships',
  {
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    check('memberships_role_check', oneOf(sql`${t.role}`, ROLES)),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    email: text('email').notNull(), // siempre en minúsculas
    role: text('role', { enum: ROLES }).notNull(),
    invitedBy: uuid('invited_by').references(() => authUsers.id), // null: alta inicial (bootstrap)
    createdAt: createdAt(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    check('invitations_role_check', oneOf(sql`${t.role}`, ROLES)),
    check('invitations_email_lower', sql`${t.email} = lower(${t.email})`),
    uniqueIndex('invitations_one_pending')
      .on(t.tenantId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);

// --- Clientes de la agencia
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'paused', 'offboarded'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    offboardedAt: ts('offboarded_at'),
  },
  (t) => [
    unique('clients_tenant_id_id').on(t.tenantId, t.id),
    unique('clients_tenant_name').on(t.tenantId, t.name),
    check('clients_status_check', oneOf(sql`${t.status}`, ['active', 'paused', 'offboarded'])),
  ],
);

export const clientAssignments = pgTable(
  'client_assignments',
  {
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.clientId, t.userId] }),
    foreignKey({
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
  ],
);

export const clientConsents = pgTable(
  'client_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    scope: text('scope').array().notNull(),
    grantedByName: text('granted_by_name').notNull(),
    grantedByEmail: text('granted_by_email').notNull(),
    evidenceRef: text('evidence_ref'),
    grantedAt: ts('granted_at').notNull(),
    revokedAt: ts('revoked_at'),
    recordedBy: uuid('recorded_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    check(
      'client_consents_scope_check',
      sql`${t.scope} <@ array[${sql.raw(CONSENT_SCOPES.map((s) => `'${s}'`).join(','))}]::text[] and cardinality(${t.scope}) > 0`,
    ),
  ],
);

// --- Meta
export const metaConnections = pgTable(
  'meta_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text('kind', { enum: ['system_user', 'user', 'business_integration'] }).notNull(),
    label: text('label').notNull(),
    metaAppId: text('meta_app_id').notNull(),
    metaBusinessId: text('meta_business_id'),
    tokenCiphertext: bytea('token_ciphertext').notNull(),
    tokenNonce: bytea('token_nonce').notNull(),
    tokenKeyVersion: integer('token_key_version').notNull(),
    tokenFingerprint: text('token_fingerprint').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'`),
    expiresAt: ts('expires_at'),
    // pending: guardado pero aún sin validar contra Meta (la validación llega con la ingesta)
    status: text('status', { enum: ['pending', 'active', 'invalid', 'revoked'] })
      .notNull()
      .default('pending'),
    lastValidatedAt: ts('last_validated_at'),
    lastErrorCode: integer('last_error_code'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('meta_connections_tenant_id_id').on(t.tenantId, t.id),
    check(
      'meta_connections_kind_check',
      oneOf(sql`${t.kind}`, ['system_user', 'user', 'business_integration']),
    ),
    check(
      'meta_connections_status_check',
      oneOf(sql`${t.status}`, ['pending', 'active', 'invalid', 'revoked']),
    ),
  ],
);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    clientId: uuid('client_id'),
    metaAccountId: text('meta_account_id').notNull(),
    name: text('name').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    timezoneName: text('timezone_name').notNull(),
    accountStatus: integer('account_status').notNull(),
    userTasks: text('user_tasks').array().notNull().default(sql`'{}'`),
    syncEnabled: boolean('sync_enabled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ad_accounts_tenant_id_id').on(t.tenantId, t.id),
    unique('ad_accounts_tenant_meta').on(t.tenantId, t.metaAccountId),
    foreignKey({
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [metaConnections.tenantId, metaConnections.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    check('ad_accounts_meta_id_check', sql`${t.metaAccountId} ~ '^act_[0-9]+$'`),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    tenantId: tenantId(),
    metaId: text('meta_id').notNull(),
    adAccountId: uuid('ad_account_id').notNull(),
    name: text('name').notNull(),
    objective: text('objective'),
    status: text('status'),
    effectiveStatus: text('effective_status'),
    dailyBudgetMinor: bigint('daily_budget_minor', { mode: 'number' }),
    lifetimeBudgetMinor: bigint('lifetime_budget_minor', { mode: 'number' }),
    advantageState: text('advantage_state'),
    raw: jsonb('raw').notNull(),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSyncedAt: ts('last_synced_at').notNull(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.metaId] }),
    foreignKey({
      columns: [t.tenantId, t.adAccountId],
      foreignColumns: [adAccounts.tenantId, adAccounts.id],
    }),
    index('campaigns_account').on(t.tenantId, t.adAccountId),
  ],
);

// --- Auditoría de cuentas y recomendaciones (F3 las produce; el modelo existe desde F1)
export const auditRuns = pgTable(
  'audit_runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: tenantId(),
    adAccountId: uuid('ad_account_id').notNull(),
    trigger: text('trigger', { enum: ['post_sync', 'manual', 'scheduled'] }).notNull(),
    dataAsOf: ts('data_as_of').notNull(),
    engineVersion: text('engine_version').notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    unique('audit_runs_tenant_id_id').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.adAccountId],
      foreignColumns: [adAccounts.tenantId, adAccounts.id],
    }),
    check(
      'audit_runs_trigger_check',
      oneOf(sql`${t.trigger}`, ['post_sync', 'manual', 'scheduled']),
    ),
    check('audit_runs_status_check', oneOf(sql`${t.status}`, ['running', 'succeeded', 'failed'])),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    adAccountId: uuid('ad_account_id').notNull(),
    auditRunId: bigint('audit_run_id', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: ['audit', 'alert'] }).notNull(),
    ruleId: text('rule_id').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    entityLevel: text('entity_level', { enum: ['account', 'campaign', 'adset', 'ad'] }).notNull(),
    entityMetaId: text('entity_meta_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(), // 0..1, string exacto
    priority: numeric('priority').notNull(),
    impact: jsonb('impact').notNull(),
    evidence: jsonb('evidence').notNull(),
    recommendationKey: text('recommendation_key').notNull(),
    status: text('status', { enum: FINDING_STATUSES }).notNull().default('open'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    decisionReason: text('decision_reason'),
  },
  (t) => [
    unique('findings_tenant_id_id').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.adAccountId],
      foreignColumns: [adAccounts.tenantId, adAccounts.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.auditRunId],
      foreignColumns: [auditRuns.tenantId, auditRuns.id],
    }),
    uniqueIndex('findings_one_open')
      .on(t.tenantId, t.fingerprint)
      .where(sql`${t.status} in ('open', 'acknowledged', 'snoozed')`),
    index('findings_account_status').on(t.tenantId, t.adAccountId, t.status),
    check('findings_kind_check', oneOf(sql`${t.kind}`, ['audit', 'alert'])),
    check(
      'findings_level_check',
      oneOf(sql`${t.entityLevel}`, ['account', 'campaign', 'adset', 'ad']),
    ),
    check('findings_severity_check', oneOf(sql`${t.severity}`, SEVERITIES)),
    check('findings_status_check', oneOf(sql`${t.status}`, FINDING_STATUSES)),
    check('findings_confidence_check', sql`${t.confidence} between 0 and 1`),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    adAccountId: uuid('ad_account_id').notNull(),
    findingId: uuid('finding_id'),
    entityLevel: text('entity_level', { enum: ['account', 'campaign', 'adset', 'ad'] }).notNull(),
    entityMetaId: text('entity_meta_id').notNull(),
    actionType: text('action_type', { enum: RECOMMENDATION_ACTIONS }).notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    rationale: text('rationale').notNull(),
    expectedImpact: jsonb('expected_impact'),
    source: text('source', { enum: ['rule', 'ai', 'user'] }).notNull(),
    status: text('status', { enum: RECOMMENDATION_STATUSES }).notNull().default('open'),
    createdAt: createdAt(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    decisionReason: text('decision_reason'),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.adAccountId],
      foreignColumns: [adAccounts.tenantId, adAccounts.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.findingId],
      foreignColumns: [findings.tenantId, findings.id],
    }),
    index('recommendations_account_status').on(t.tenantId, t.adAccountId, t.status),
    check('recommendations_action_check', oneOf(sql`${t.actionType}`, RECOMMENDATION_ACTIONS)),
    check('recommendations_source_check', oneOf(sql`${t.source}`, ['rule', 'ai', 'user'])),
    check('recommendations_status_check', oneOf(sql`${t.status}`, RECOMMENDATION_STATUSES)),
  ],
);

// --- Registro de eventos (solo inserción: sin UPDATE ni DELETE para app_rw)
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id').references(() => tenants.id), // null: evento de plataforma
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type', { enum: ['user', 'system', 'ai'] }).notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_log_tenant_at').on(t.tenantId, t.at),
    check('audit_log_actor_check', oneOf(sql`${t.actorType}`, ['user', 'system', 'ai'])),
  ],
);

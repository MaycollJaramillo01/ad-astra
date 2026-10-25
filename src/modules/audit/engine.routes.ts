import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AuditCatalogDto,
  AuditConfigDto,
  AuditConfigQuery,
  AuditEntityDto,
  AuditEntityQuery,
  AuditRunBody,
  AuditRunDto,
  IdParams,
  PutAuditConfigBody,
} from '../../contracts.ts';
import { type Db, type Tx, withContext } from '../../db/client.ts';
import {
  ads,
  adsets,
  auditConfigs,
  campaigns,
  clients,
  findings,
  healthScores,
} from '../../db/schema.ts';
import { badRequest, forbidden, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { type TenantContext, tenantOf } from '../../platform/http.ts';
import { seesAllClients } from '../../platform/rbac.ts';
import { findAccount } from '../catalog/accounts.ts';
import { clientScope } from '../tenancy/clients.routes.ts';
import { ENGINE_VERSION } from './engine.ts';
import {
  type AuditConfigPatch,
  CATEGORIES,
  DEFAULT_CONFIG,
  HEALTH_FORMULA_VERSION,
  mergeConfig,
  PROFILES,
  SUBINDICES,
} from './model.ts';
import { RULES, RULES_BY_ID, ruleParams } from './rules.ts';
import { auditAccount } from './service.ts';

// API del motor de auditoría: ejecución manual, salud e historial de una entidad con los
// hallazgos de su rama, catálogo de reglas publicado y configuración por organización o cliente.

const OPEN = ['open', 'acknowledged', 'snoozed'] as const;
const CHILD = { account: 'campaign', campaign: 'adset', adset: 'ad', ad: null } as const;

/** Cuenta de una entidad (con el alcance por cliente) y los ids de Meta de toda su rama. */
export async function resolveEntity(
  tx: Tx,
  ctx: TenantContext,
  level: 'account' | 'campaign' | 'adset' | 'ad',
  id: string,
) {
  if (level === 'account') {
    if (!z.uuid().safeParse(id).success) throw notFound('Cuenta publicitaria');
    const account = await findAccount(tx, ctx, id);
    return { account, entityMetaId: account.metaAccountId, branch: null as string[] | null };
  }
  const table = level === 'campaign' ? campaigns : level === 'adset' ? adsets : ads;
  const [row] = await tx
    .select({ adAccountId: table.adAccountId })
    .from(table)
    .where(eq(table.metaId, id));
  const [scored] = row
    ? []
    : await tx
        .select({ adAccountId: healthScores.adAccountId })
        .from(healthScores)
        .where(and(eq(healthScores.entityLevel, level), eq(healthScores.entityMetaId, id)))
        .limit(1);
  const adAccountId = row?.adAccountId ?? scored?.adAccountId;
  if (!adAccountId) throw notFound();
  const account = await findAccount(tx, ctx, adAccountId);
  const branch = [id];
  if (level === 'campaign') {
    branch.push(
      ...(
        await tx.select({ id: adsets.metaId }).from(adsets).where(eq(adsets.campaignMetaId, id))
      ).map((r) => r.id),
    );
    branch.push(
      ...(await tx.select({ id: ads.metaId }).from(ads).where(eq(ads.campaignMetaId, id))).map(
        (r) => r.id,
      ),
    );
  } else if (level === 'adset') {
    branch.push(
      ...(await tx.select({ id: ads.metaId }).from(ads).where(eq(ads.adsetMetaId, id))).map(
        (r) => r.id,
      ),
    );
  }
  return { account, entityMetaId: id, branch };
}

const healthDto = (h: typeof healthScores.$inferSelect) => ({
  level: h.entityLevel,
  entityId: h.entityMetaId,
  date: h.date,
  formulaVersion: h.formulaVersion,
  profile: h.profile,
  windowDays: h.windowDays,
  score: h.score === null ? null : Number(h.score),
  grade: h.grade,
  coverage: Number(h.coverage),
  confidence: h.confidence === null ? null : Number(h.confidence),
  components: h.components as Array<Record<string, unknown>>,
});

/** Valida un parche: esquema general, reglas existentes y sus parámetros, y la configuración resultante. */
function validatePatch(
  patch: AuditConfigPatch,
  other: AuditConfigPatch | undefined,
  isClient: boolean,
) {
  for (const [ruleId, o] of Object.entries(patch.rules ?? {})) {
    const rule = RULES_BY_ID.get(ruleId);
    if (!rule) throw badRequest(`Regla desconocida: ${ruleId}`);
    const parsed = rule.params.safeParse(o.params ?? {});
    if (!parsed.success)
      throw badRequest(
        `Parámetros no válidos para ${ruleId}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
  }
  const merged = isClient ? mergeConfig(other, patch) : mergeConfig(patch, other);
  for (const [profile, weights] of Object.entries(merged.health.weights)) {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum <= 0) throw badRequest(`Los pesos del perfil ${profile} no pueden sumar 0`);
  }
  return merged;
}

/** Salud de una entidad, su historial, los hallazgos abiertos de su rama y la salud de sus hijos. */
export async function entityAudit(
  tx: Tx,
  ctx: TenantContext,
  level: 'account' | 'campaign' | 'adset' | 'ad',
  id: string,
) {
  const { account, entityMetaId, branch } = await resolveEntity(tx, ctx, level, id);
  const rows = await tx
    .select()
    .from(healthScores)
    .where(
      and(
        eq(healthScores.adAccountId, account.id),
        eq(healthScores.entityLevel, level),
        eq(healthScores.entityMetaId, entityMetaId),
      ),
    )
    .orderBy(desc(healthScores.date))
    .limit(30);
  const latest = rows[0] ?? null;

  const open = await tx
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.adAccountId, account.id),
        inArray(findings.status, [...OPEN]),
        branch ? inArray(findings.entityMetaId, branch) : undefined,
      ),
    )
    .orderBy(desc(findings.priority), desc(findings.lastSeenAt))
    .limit(200);
  const names = new Map<string, string>([[account.metaAccountId, account.name]]);
  for (const t of [campaigns, adsets, ads]) {
    const ids = open.map((f) => f.entityMetaId).filter((x) => !names.has(x));
    if (ids.length)
      for (const r of await tx
        .select({ id: t.metaId, name: t.name })
        .from(t)
        .where(inArray(t.metaId, ids)))
        names.set(r.id, r.name);
  }

  const childLevel = CHILD[level];
  const childrenHealth: Record<
    string,
    { score: number | null; grade: (typeof healthScores.$inferSelect)['grade'] }
  > = {};
  if (childLevel && latest) {
    const children = await tx
      .select()
      .from(healthScores)
      .where(
        and(
          eq(healthScores.adAccountId, account.id),
          eq(healthScores.entityLevel, childLevel),
          eq(healthScores.date, latest.date),
          branch ? inArray(healthScores.entityMetaId, branch) : undefined,
        ),
      );
    for (const c of children)
      childrenHealth[c.entityMetaId] = {
        score: c.score === null ? null : Number(c.score),
        grade: c.grade,
      };
  }

  return {
    health: latest ? healthDto(latest) : null,
    history: rows
      .map((r) => ({
        date: r.date,
        score: r.score === null ? null : Number(r.score),
        grade: r.grade,
      }))
      .reverse(),
    findings: open.map((f) => ({
      id: f.id,
      adAccountId: f.adAccountId,
      kind: f.kind,
      ruleId: f.ruleId,
      ruleVersion: f.ruleVersion,
      entityLevel: f.entityLevel,
      entityMetaId: f.entityMetaId,
      entityName: names.get(f.entityMetaId) ?? null,
      severity: f.severity,
      confidence: f.confidence,
      priority: f.priority,
      impact: f.impact,
      evidence: f.evidence,
      recommendationKey: f.recommendationKey,
      status: f.status,
      firstSeenAt: f.firstSeenAt.toISOString(),
      lastSeenAt: f.lastSeenAt.toISOString(),
      decisionReason: f.decisionReason,
      category: f.category,
      profile: f.profile,
      explanation: f.explanation,
      recommendationText: f.recommendationText,
      engineVersion: f.engineVersion,
      windowStart: f.windowStart,
      windowEnd: f.windowEnd,
      resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
    })),
    childrenHealth,
  };
}

export async function auditEngineRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/v1/ad-accounts/:id/audit',
    {
      config: { access: { permission: 'audit:run' } },
      schema: { params: IdParams, body: AuditRunBody, response: { 200: AuditRunDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      await withContext(db, ctx, (tx) => findAccount(tx, ctx, request.params.id)); // alcance por cliente
      const result = await auditAccount(db, ctx.tenantId, request.params.id, {
        trigger: 'manual',
        asOf: request.body.asOf,
      });
      if (!result) throw notFound('Cuenta publicitaria');
      await withContext(db, ctx, (tx) =>
        userEvent(tx, request, {
          action: 'audit.run',
          targetType: 'ad_account',
          targetId: request.params.id,
          after: { runId: result.runId, asOf: result.asOf },
        }),
      );
      return result;
    },
  );

  app.get(
    '/v1/audit/entity',
    {
      config: { access: { permission: 'findings:read' } },
      schema: { querystring: AuditEntityQuery, response: { 200: AuditEntityDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const { level, id } = request.query;
      return withContext(db, ctx, (tx) => entityAudit(tx, ctx, level, id));
    },
  );

  app.get(
    '/v1/audit/catalog',
    {
      config: { access: { permission: 'findings:read' } },
      schema: { response: { 200: AuditCatalogDto } },
    },
    async () => ({
      engineVersion: ENGINE_VERSION,
      formulaVersion: HEALTH_FORMULA_VERSION,
      categories: CATEGORIES,
      profiles: PROFILES,
      subindices: SUBINDICES,
      rules: RULES.map((r) => ({
        id: r.id,
        version: r.version,
        category: r.category,
        title: r.title,
        description: r.description,
        method: r.method,
        minSample: r.minSample,
        levels: r.levels,
        profiles: r.profiles,
        statistical: r.statistical,
        defaults: ruleParams(r, {}),
        paramsSchema: z.toJSONSchema(r.params, { io: 'input' }),
      })),
      defaults: DEFAULT_CONFIG,
    }),
  );

  const loadPatches = async (tx: Tx, clientId: string | null) => {
    const rows = await tx.select().from(auditConfigs);
    return {
      organization:
        (rows.find((r) => r.clientId === null)?.config as AuditConfigPatch | undefined) ?? null,
      client: clientId
        ? ((rows.find((r) => r.clientId === clientId)?.config as AuditConfigPatch | undefined) ??
          null)
        : null,
    };
  };
  const checkClient = async (tx: Tx, ctx: TenantContext, clientId: string) => {
    const [client] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, clientId), clientScope(tx, ctx, clients.id)));
    if (!client) throw notFound('Cliente');
  };

  app.get(
    '/v1/audit/config',
    {
      config: { access: { permission: 'findings:read' } },
      schema: { querystring: AuditConfigQuery, response: { 200: AuditConfigDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const clientId = request.query.clientId ?? null;
      return withContext(db, ctx, async (tx) => {
        if (clientId) await checkClient(tx, ctx, clientId);
        const patches = await loadPatches(tx, clientId);
        return { effective: mergeConfig(patches.organization, patches.client), ...patches };
      });
    },
  );

  app.put(
    '/v1/audit/config',
    {
      config: { access: { permission: 'audit:configure' } },
      schema: { body: PutAuditConfigBody, response: { 200: AuditConfigDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const { clientId, patch } = request.body;
      return withContext(db, ctx, async (tx) => {
        // La configuración de la organización es de owner y admin; la de un cliente, también de su manager.
        if (clientId) await checkClient(tx, ctx, clientId);
        else if (!seesAllClients(ctx.role))
          throw forbidden('Solo owner y admin cambian la configuración de la organización');
        const before = await loadPatches(tx, clientId);
        const effective = validatePatch(
          patch,
          clientId ? (before.organization ?? undefined) : (before.client ?? undefined),
          clientId !== null,
        );
        await tx
          .insert(auditConfigs)
          .values({ tenantId: ctx.tenantId, clientId, config: patch, updatedBy: ctx.userId })
          .onConflictDoUpdate({
            target: [auditConfigs.tenantId, auditConfigs.clientId],
            set: { config: patch, updatedBy: ctx.userId, updatedAt: new Date() },
          });
        await userEvent(tx, request, {
          action: 'audit_config.updated',
          targetType: clientId ? 'client' : 'tenant',
          targetId: clientId ?? ctx.tenantId,
          before: clientId ? before.client : before.organization,
          after: patch,
        });
        const after = await loadPatches(tx, clientId);
        return {
          effective: clientId ? effective : mergeConfig(after.organization, after.client),
          ...after,
        };
      });
    },
  );
}

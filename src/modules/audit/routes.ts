import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AuditEventDto,
  AuditLogQuery,
  FindingDecisionBody,
  FindingDto,
  FindingsQuery,
  IdParams,
  RecommendationDecisionBody,
  RecommendationDto,
  RecommendationsQuery,
} from '../../contracts.ts';
import { type Db, first, withContext } from '../../db/client.ts';
import { adAccounts, auditLog, findingEvents, findings, recommendations } from '../../db/schema.ts';
import { conflict, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { tenantOf } from '../../platform/http.ts';
import { clientScope } from '../tenancy/clients.routes.ts';

// Hallazgos de auditoría, recomendaciones y registro de eventos. El motor que los produce
// llega en F3; aquí se consultan y se deciden (con motivo, que queda en el registro).

const iso = (d: Date) => d.toISOString();

const findingDto = (f: typeof findings.$inferSelect) => ({
  id: f.id,
  adAccountId: f.adAccountId,
  kind: f.kind,
  ruleId: f.ruleId,
  ruleVersion: f.ruleVersion,
  entityLevel: f.entityLevel,
  entityMetaId: f.entityMetaId,
  severity: f.severity,
  confidence: f.confidence,
  priority: f.priority,
  impact: f.impact,
  evidence: f.evidence,
  recommendationKey: f.recommendationKey,
  status: f.status,
  firstSeenAt: iso(f.firstSeenAt),
  lastSeenAt: iso(f.lastSeenAt),
  decisionReason: f.decisionReason,
  category: f.category,
  profile: f.profile,
  explanation: f.explanation,
  recommendationText: f.recommendationText,
  engineVersion: f.engineVersion,
  windowStart: f.windowStart,
  windowEnd: f.windowEnd,
  resolvedAt: f.resolvedAt ? iso(f.resolvedAt) : null,
});

const recommendationDto = (r: typeof recommendations.$inferSelect) => ({
  id: r.id,
  adAccountId: r.adAccountId,
  findingId: r.findingId,
  entityLevel: r.entityLevel,
  entityMetaId: r.entityMetaId,
  actionType: r.actionType,
  params: r.params,
  rationale: r.rationale,
  expectedImpact: r.expectedImpact,
  source: r.source,
  status: r.status,
  createdAt: iso(r.createdAt),
  decisionReason: r.decisionReason,
});

export async function auditRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/findings',
    {
      config: { access: { permission: 'findings:read' } },
      schema: { querystring: FindingsQuery, response: { 200: z.array(FindingDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const { status, adAccountId, limit } = request.query;
      const rows = await withContext(db, ctx, (tx) => {
        const query = tx
          .select({ f: findings })
          .from(findings)
          .innerJoin(adAccounts, eq(adAccounts.id, findings.adAccountId))
          .where(
            and(
              clientScope(tx, ctx, adAccounts.clientId),
              status ? eq(findings.status, status) : undefined,
              adAccountId ? eq(findings.adAccountId, adAccountId) : undefined,
            ),
          )
          .orderBy(desc(findings.priority), desc(findings.lastSeenAt), findings.id);
        return limit ? query.limit(limit) : query;
      });
      return rows.map((r) => findingDto(r.f));
    },
  );

  app.post(
    '/v1/findings/:id/decision',
    {
      config: { access: { permission: 'findings:decide' } },
      schema: { params: IdParams, body: FindingDecisionBody, response: { 200: FindingDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const [found] = await tx
          .select({ f: findings })
          .from(findings)
          .innerJoin(adAccounts, eq(adAccounts.id, findings.adAccountId))
          .where(
            and(eq(findings.id, request.params.id), clientScope(tx, ctx, adAccounts.clientId)),
          );
        if (!found) throw notFound('Hallazgo');
        if (found.f.status === 'dismissed' || found.f.status === 'resolved') {
          throw conflict('El hallazgo ya está cerrado');
        }
        const after = first(
          await tx
            .update(findings)
            .set({
              status: request.body.status,
              decidedBy: ctx.userId,
              decidedAt: new Date(),
              decisionReason: request.body.reason,
            })
            .where(eq(findings.id, found.f.id))
            .returning(),
        );
        await tx.insert(findingEvents).values({
          tenantId: ctx.tenantId,
          findingId: found.f.id,
          event: 'decided',
          actorType: 'user',
          actorId: ctx.userId,
          data: { from: found.f.status, to: after.status, reason: request.body.reason },
        });
        await userEvent(tx, request, {
          action: 'finding.decided',
          targetType: 'finding',
          targetId: found.f.id,
          before: { status: found.f.status },
          after: { status: after.status, reason: request.body.reason },
        });
        return findingDto(after);
      });
    },
  );

  app.get(
    '/v1/recommendations',
    {
      config: { access: { permission: 'recommendations:read' } },
      schema: { querystring: RecommendationsQuery, response: { 200: z.array(RecommendationDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const { status, adAccountId } = request.query;
      const rows = await withContext(db, ctx, (tx) =>
        tx
          .select({ r: recommendations })
          .from(recommendations)
          .innerJoin(adAccounts, eq(adAccounts.id, recommendations.adAccountId))
          .where(
            and(
              clientScope(tx, ctx, adAccounts.clientId),
              status ? eq(recommendations.status, status) : undefined,
              adAccountId ? eq(recommendations.adAccountId, adAccountId) : undefined,
            ),
          )
          .orderBy(desc(recommendations.createdAt)),
      );
      return rows.map((r) => recommendationDto(r.r));
    },
  );

  app.post(
    '/v1/recommendations/:id/decision',
    {
      config: { access: { permission: 'recommendations:decide' } },
      schema: {
        params: IdParams,
        body: RecommendationDecisionBody,
        response: { 200: RecommendationDto },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const [found] = await tx
          .select({ r: recommendations })
          .from(recommendations)
          .innerJoin(adAccounts, eq(adAccounts.id, recommendations.adAccountId))
          .where(
            and(
              eq(recommendations.id, request.params.id),
              clientScope(tx, ctx, adAccounts.clientId),
            ),
          );
        if (!found) throw notFound('Recomendación');
        if (found.r.status !== 'open') throw conflict('La recomendación ya tiene una decisión');
        // Aceptar no ejecuta nada en Meta: eso será una acción con aprobación en F5 (ADR-013).
        const after = first(
          await tx
            .update(recommendations)
            .set({
              status: request.body.status,
              decidedBy: ctx.userId,
              decidedAt: new Date(),
              decisionReason: request.body.reason,
            })
            .where(eq(recommendations.id, found.r.id))
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'recommendation.decided',
          targetType: 'recommendation',
          targetId: found.r.id,
          before: { status: found.r.status },
          after: { status: after.status, reason: request.body.reason },
        });
        return recommendationDto(after);
      });
    },
  );

  app.get(
    '/v1/audit-log',
    {
      config: { access: { permission: 'audit_log:read' } },
      schema: { querystring: AuditLogQuery, response: { 200: z.array(AuditEventDto) } },
    },
    async (request) => {
      const { limit, before } = request.query;
      const rows = await withContext(db, tenantOf(request), (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(before ? lt(auditLog.id, before) : undefined)
          .orderBy(desc(auditLog.id))
          .limit(limit),
      );
      return rows.map((e) => ({
        id: e.id,
        at: iso(e.at),
        actorType: e.actorType,
        actorId: e.actorId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        before: e.before,
        after: e.after,
        requestId: e.requestId,
      }));
    },
  );
}

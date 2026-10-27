import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AiAnswerDto, AiVerificationDto } from '../../contracts.ts';
import {
  AiAskBody,
  AiConversationDetailDto,
  AiConversationDto,
  AiMessageParams,
  AiProposeParams,
  AiStatusDto,
  AiTraceDto,
  AiTurnDto,
  IdParams,
  RecommendationDto,
} from '../../contracts.ts';
import { type Db, first, withContext } from '../../db/client.ts';
import {
  adAccounts,
  aiConversations,
  aiMessages,
  findings,
  recommendations,
} from '../../db/schema.ts';
import type { Config } from '../../platform/config.ts';
import { AppError, conflict, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { tenantOf } from '../../platform/http.ts';
import { assertSideEffects } from '../../platform/operations.ts';
import { resolveEntity } from '../audit/engine.routes.ts';
import { findAccount } from '../catalog/accounts.ts';
import { ask, listConversations, spending, type TraceEntry } from './assistant.ts';
import type { LlmProvider } from './provider.ts';
import { assertConversationAccess } from './scope.ts';
import { consentedClients } from './tools.ts';

// API del asistente de IA (F4). Preguntar gasta presupuesto: rutas con su propio límite de ritmo.
// Las recomendaciones de la IA no se ejecutan: el usuario puede proponerlas a la cola de
// recomendaciones (estado open), donde un manager las acepta o descarta (ADR-013).

type Row = typeof aiMessages.$inferSelect;

const evidenceOf = (row: Row) =>
  ((row.trace as TraceEntry[] | null) ?? []).map((e) => ({
    toolUseId: e.toolUseId,
    evidenceId: e.evidenceId ?? null,
    tool: e.tool,
    input: e.input,
    status: e.status,
    sufficiency: e.sufficiency ?? null,
    ms: e.ms,
    error: e.error ?? null,
  }));

const messageDto = (row: Row) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  status: row.status,
  answer: row.answer as z.infer<typeof AiAnswerDto> | null,
  verification: row.verification as z.infer<typeof AiVerificationDto> | null,
  evidence: evidenceOf(row),
  injectionFlags: ((row.flags as string[] | null) ?? []).length,
  costUsd: row.costUsd === null ? null : Number(row.costUsd),
  model: row.model,
  promptVersion: row.promptVersion,
  createdAt: row.createdAt.toISOString(),
});

const conversationDto = (c: typeof aiConversations.$inferSelect) => ({
  id: c.id,
  title: c.title,
  model: c.model,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export async function aiRoutes(
  fastify: FastifyInstance,
  { db, config, llm }: { db: Db; config: Config; llm: LlmProvider | null },
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/ai/status',
    {
      config: { access: { permission: 'ai:use' } },
      schema: { response: { 200: AiStatusDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const spent = await spending(db, ctx);
      let unavailableReason: string | null = llm ? null : 'Falta la clave del proveedor de IA.';
      if (llm) {
        try {
          await withContext(db, ctx, (tx) => assertSideEffects(tx, config, ctx.tenantId));
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          unavailableReason = error.detail ?? error.message;
        }
      }
      return {
        enabled: llm !== null && unavailableReason === null,
        configured: llm !== null,
        unavailableReason,
        costBasis:
          llm?.costBasis ??
          (config.AI_PROVIDER === 'nvidia' ? 'budget_estimate' : 'published_tariff'),
        provider: config.AI_PROVIDER,
        model: llm?.model ?? config.AI_MODEL,
        effort: config.AI_EFFORT,
        budgets: {
          monthlyUsd: config.AI_MONTHLY_BUDGET_USD,
          spentMonthUsd: Number(spent.month.toFixed(4)),
          userDailyUsd: config.AI_USER_DAILY_BUDGET_USD,
          spentTodayUsd: Number(spent.day.toFixed(4)),
          perQuestionUsd: config.AI_QUESTION_BUDGET_USD,
        },
      };
    },
  );

  app.post(
    '/v1/ai/ask',
    {
      config: {
        access: { permission: 'ai:use' },
        // Por usuario y después de autenticar (preHandler): cada pregunta cuesta dinero.
        rateLimit: {
          max: config.AI_ASK_PER_MINUTE,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request) => `ai:${request.identity?.userId ?? request.ip}`,
        },
      },
      schema: { body: AiAskBody, response: { 200: AiTurnDto } },
    },
    async (request) => {
      const { conversationId, message } = await ask(
        { db, llm, config, request },
        tenantOf(request),
        request.body,
      );
      return { conversationId, message: messageDto(message) };
    },
  );

  app.get(
    '/v1/ai/conversations',
    {
      config: { access: { permission: 'ai:use' } },
      schema: { response: { 200: z.array(AiConversationDto) } },
    },
    async (request) => (await listConversations(db, tenantOf(request))).map(conversationDto),
  );

  app.get(
    '/v1/ai/conversations/:id',
    {
      config: { access: { permission: 'ai:use' } },
      schema: { params: IdParams, response: { 200: AiConversationDetailDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const [c] = await tx
          .select()
          .from(aiConversations)
          .where(eq(aiConversations.id, request.params.id));
        if (!c) throw notFound('Conversación');
        await assertConversationAccess(tx, ctx, c.id);
        const rows = await tx
          .select()
          .from(aiMessages)
          .where(eq(aiMessages.conversationId, c.id))
          .orderBy(aiMessages.id);
        return { ...conversationDto(c), messages: rows.map(messageDto) };
      });
    },
  );

  app.get(
    '/v1/ai/messages/:id/trace',
    {
      config: { access: { permission: 'ai:use' } },
      schema: { params: AiMessageParams, response: { 200: AiTraceDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const row = await withContext(db, ctx, async (tx) => {
        const [message] = await tx
          .select()
          .from(aiMessages)
          .where(eq(aiMessages.id, request.params.id));
        if (message) await assertConversationAccess(tx, ctx, message.conversationId);
        return message;
      });
      if (row?.role !== 'assistant') throw notFound('Mensaje');
      const trace = (row.trace as TraceEntry[] | null) ?? [];
      return {
        messageId: row.id,
        evidence: evidenceOf(row).map((e, i) => ({ ...e, output: trace[i]?.output ?? null })),
        usage: row.usage,
      };
    },
  );

  app.post(
    '/v1/ai/messages/:id/recommendations/:index/propose',
    {
      config: { access: { permission: 'ai:use' } },
      schema: { params: AiProposeParams, response: { 200: RecommendationDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const { id, index } = request.params;
      return withContext(db, ctx, async (tx) => {
        const [row] = await tx.select().from(aiMessages).where(eq(aiMessages.id, id));
        if (row?.role !== 'assistant') throw notFound('Mensaje');
        await assertConversationAccess(tx, ctx, row.conversationId);
        const answer = row.answer as z.infer<typeof AiAnswerDto> | null;
        const rec = answer?.recommendations[index];
        if (!rec) throw notFound('Recomendación');
        const verification = row.verification as z.infer<typeof AiVerificationDto>;
        if (verification.issues.some((i) => i.path.startsWith(`recommendations.${index}`)))
          throw conflict('La recomendación tiene evidencia o cifras sin verificar');

        // La entidad debe seguir en el alcance del usuario y su cliente con consentimiento de IA.
        const level = rec.action.entityLevel;
        const account =
          level === 'account'
            ? rec.action.entityId.startsWith('act_')
              ? await tx
                  .select()
                  .from(adAccounts)
                  .where(eq(adAccounts.metaAccountId, rec.action.entityId))
                  .then(([a]) => (a ? findAccount(tx, ctx, a.id) : Promise.reject(notFound())))
              : await findAccount(tx, ctx, rec.action.entityId)
            : (await resolveEntity(tx, ctx, level, rec.action.entityId)).account;
        if (!account.clientId || !(await consentedClients(tx)).has(account.clientId))
          throw conflict('El cliente no tiene consentimiento de procesamiento con IA');

        const [dup] = await tx
          .select({ id: recommendations.id })
          .from(recommendations)
          .where(
            and(
              eq(recommendations.source, 'ai'),
              sql`${recommendations.expectedImpact}->>'messageId' = ${String(id)}`,
              sql`${recommendations.expectedImpact}->>'index' = ${String(index)}`,
            ),
          );
        if (dup) throw conflict('Esta recomendación ya se propuso');
        const [finding] = rec.relatedFindingIds.length
          ? await tx
              .select({ id: findings.id })
              .from(findings)
              .where(
                and(
                  eq(findings.adAccountId, account.id),
                  sql`${findings.id}::text = any(${rec.relatedFindingIds})`,
                ),
              )
              .limit(1)
          : [];

        const created = first(
          await tx
            .insert(recommendations)
            .values({
              tenantId: ctx.tenantId,
              adAccountId: account.id,
              findingId: finding?.id ?? null,
              entityLevel: level,
              entityMetaId: level === 'account' ? account.metaAccountId : rec.action.entityId,
              actionType: rec.action.type,
              params: rec.action.amount === null ? {} : { amount: rec.action.amount },
              rationale: `${rec.title}. ${rec.rationale}`,
              expectedImpact: {
                ...rec.expectedImpact,
                confidence: rec.confidence,
                risk: rec.risk,
                dependencies: rec.dependencies,
                evidenceIds: rec.evidenceIds,
                figures: rec.figures,
                priority: rec.priority,
                actionDescription: rec.action.description,
                conversationId: row.conversationId,
                messageId: String(id),
                index: String(index),
              },
              source: 'ai',
            })
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'ai.recommendation_proposed',
          targetType: 'recommendation',
          targetId: created.id,
          after: { messageId: id, index, actionType: created.actionType },
        });
        return {
          id: created.id,
          adAccountId: created.adAccountId,
          findingId: created.findingId,
          entityLevel: created.entityLevel,
          entityMetaId: created.entityMetaId,
          actionType: created.actionType,
          params: created.params,
          rationale: created.rationale,
          expectedImpact: created.expectedImpact,
          source: created.source,
          status: created.status,
          createdAt: created.createdAt.toISOString(),
          decisionReason: created.decisionReason,
        };
      });
    },
  );
}

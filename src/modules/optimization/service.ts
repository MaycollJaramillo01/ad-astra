import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  type ActionCreateBody,
  ActionPolicy,
  type BudgetAction,
  type Policy,
  type Preview,
  type Snapshot,
} from '../../action-contracts.ts';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import {
  actionApprovals,
  actionEvents,
  actionPolicies,
  actions,
  adAccounts,
  ads,
  adsets,
  campaigns,
  clientConsents,
  clients,
  jobs,
  memberships,
  metaConnections,
  recommendations,
  tenants,
} from '../../db/schema.ts';
import type { Config } from '../../platform/config.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../platform/errors.ts';
import { recordEvent } from '../../platform/events.ts';
import type { TenantContext } from '../../platform/http.ts';
import { enqueue } from '../../platform/jobs.ts';
import { assertSideEffects } from '../../platform/operations.ts';
import { can } from '../../platform/rbac.ts';
import { findAccount } from '../catalog/accounts.ts';
import { clientScope } from '../tenancy/clients.routes.ts';
import type { ActionGateway, ActionRow, WriteContext } from './meta.ts';
import { checkPolicy, configuration, fieldOf, hash, previewOf } from './model.ts';

export const previewOfRow = (a: ActionRow) => a.preview as Preview | null;
export const policyFor = async (
  tx: Tx,
  accountId: string,
): Promise<Policy & { authorizationVersion: string }> => {
  const [p] = await tx
    .select()
    .from(actionPolicies)
    .where(eq(actionPolicies.adAccountId, accountId));
  const stored = (p?.config ?? {}) as Record<string, unknown>;
  return {
    ...ActionPolicy.parse(stored),
    authorizationVersion:
      typeof stored.authorizationVersion === 'string'
        ? stored.authorizationVersion
        : 'unconfigured',
  };
};
export async function record(tx: Tx, a: ActionRow, event: string, data: unknown, actorId?: string) {
  await tx
    .insert(actionEvents)
    .values({ tenantId: a.tenantId, actionId: a.id, event, actorId, data });
  await recordEvent(
    tx,
    { tenantId: a.tenantId, actorType: actorId ? 'user' : 'system', actorId },
    { action: `action.${event}`, targetType: 'action', targetId: a.id, after: data },
  );
}
export async function updateAction(
  tx: Tx,
  a: ActionRow,
  values: Partial<typeof actions.$inferInsert>,
) {
  return first(
    await tx
      .update(actions)
      .set({ ...values, revision: a.revision + 1, updatedAt: new Date() })
      .where(and(eq(actions.id, a.id), eq(actions.revision, a.revision)))
      .returning(),
  );
}
export const assertRevision = (a: ActionRow, revision: number) => {
  if (a.revision !== revision) throw conflict('La acción cambió: recarga antes de continuar.');
};
export async function rowFor(tx: Tx, ctx: TenantContext, id: string, lock = false) {
  const q = tx.select().from(actions).where(eq(actions.id, id));
  const [a] = await (lock ? q.for('update') : q);
  if (!a) throw notFound('Acción');
  await findAccount(tx, ctx, a.adAccountId);
  return a;
}
export async function dto(tx: Tx, a: ActionRow): Promise<BudgetAction> {
  const p = previewOfRow(a);
  const approvals = p
    ? await tx
        .select()
        .from(actionApprovals)
        .where(and(eq(actionApprovals.actionId, a.id), eq(actionApprovals.previewHash, p.hash)))
    : [];
  return {
    id: a.id,
    adAccountId: a.adAccountId,
    recommendationId: a.recommendationId,
    rollbackOf: a.rollbackOf,
    entityLevel: a.entityLevel,
    entityMetaId: a.entityMetaId,
    operation: a.operation,
    desired: a.desired,
    reason: a.reason,
    state: a.state,
    revision: a.revision,
    proposedBy: a.proposedBy,
    preview: p,
    approvals: approvals.map((x) => ({ userId: x.userId, at: x.at.toISOString() })),
    after: a.after as Snapshot | null,
    result: a.result,
    error: a.error,
    dispatchAt: a.dispatchAt?.toISOString() ?? null,
    confirmedWrite: a.confirmedWrite,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function authorization(
  tx: Tx,
  a: ActionRow,
  config: Config,
  readOnly = false,
): Promise<WriteContext> {
  if (!readOnly) await assertSideEffects(tx, config, a.tenantId);
  const [account] = await tx.select().from(adAccounts).where(eq(adAccounts.id, a.adAccountId));
  if (!account?.clientId)
    throw forbidden('La cuenta necesita un cliente y consentimiento de escritura.');
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, a.tenantId));
  const [client] = await tx.select().from(clients).where(eq(clients.id, account.clientId));
  const [connection] = await tx
    .select()
    .from(metaConnections)
    .where(eq(metaConnections.id, account.connectionId));
  if (
    tenant?.status !== 'active' ||
    client?.status !== 'active' ||
    connection?.status !== 'active' ||
    connection.metaAppId !== config.META_APP_ID ||
    (connection.expiresAt && connection.expiresAt <= new Date())
  )
    throw forbidden('Organización, cliente o conexión no disponibles para escribir.');
  const scope = readOnly
    ? 'read_insights'
    : fieldOf(a.operation) === 'status'
      ? 'write_status'
      : 'write_budget';
  const [consent] = await tx
    .select()
    .from(clientConsents)
    .where(
      and(
        eq(clientConsents.clientId, account.clientId),
        isNull(clientConsents.revokedAt),
        sql`${scope} = any(${clientConsents.scope})`,
        sql`${clientConsents.grantedAt} <= now()`,
      ),
    );
  if (!consent) throw forbidden(`Falta consentimiento vigente ${scope}.`);
  const table = a.entityLevel === 'campaign' ? campaigns : a.entityLevel === 'adset' ? adsets : ads;
  const [entity] = await tx
    .select({ id: table.metaId })
    .from(table)
    .where(and(eq(table.metaId, a.entityMetaId), eq(table.adAccountId, account.id)));
  if (!entity) throw notFound('Entidad publicitaria');
  if (a.recommendationId && !a.rollbackOf && a.state !== 'closed' && !readOnly) {
    const [r] = await tx
      .select()
      .from(recommendations)
      .where(eq(recommendations.id, a.recommendationId));
    if (r?.status !== 'accepted') throw conflict('La recomendación ya no está aceptada.');
  }
  return { account, connection };
}

export async function eligibleApprover(tx: Tx, a: ActionRow, userId: string): Promise<boolean> {
  if (userId === a.proposedBy) return false;
  const [m] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, a.tenantId)));
  if (
    !m ||
    !can(m.role, 'actions:approve') ||
    (fieldOf(a.operation) !== 'status' && m.role === 'manager')
  )
    return false;
  try {
    await findAccount(tx, { tenantId: a.tenantId, userId, role: m.role }, a.adAccountId);
    return true;
  } catch {
    return false;
  }
}
export async function validApprovalCount(tx: Tx, a: ActionRow, p: Preview) {
  const all = await tx
    .select()
    .from(actionApprovals)
    .where(and(eq(actionApprovals.actionId, a.id), eq(actionApprovals.previewHash, p.hash)));
  let n = 0;
  for (const x of all) if (await eligibleApprover(tx, a, x.userId)) n++;
  return n;
}
export function ensurePreview(_a: ActionRow, p: Preview | null, policy: Policy) {
  if (!p || Date.parse(p.expiresAt) <= Date.now())
    throw conflict('La previsualización caducó: vuelve a revisar.');
  if (p.policyHash !== hash(policy))
    throw conflict('La política cambió: se necesitan nueva revisión y aprobaciones.');
}

/** Límites acumulados en ventanas móviles, incluyendo envíos de resultado desconocido.
 * La reserva por acción no es una autorización para repetir un POST. */
export async function checkFrequency(tx: Tx, a: ActionRow, p: Preview, policy: Policy) {
  const recent = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.adAccountId, a.adAccountId),
        ne(actions.id, a.id),
        gte(actions.reservedAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  const same = recent.filter((x) => x.entityMetaId === a.entityMetaId);
  const last = same.reduce((n, x) => Math.max(n, x.reservedAt?.getTime() ?? 0), 0);
  if (Date.now() - last < 30_000)
    throw conflict('Espera al menos 30 segundos entre ediciones del mismo objeto.');
  if (p.field !== 'status') {
    if (
      same.filter(
        (x) =>
          fieldOf(x.operation) !== 'status' &&
          (x.reservedAt?.getTime() ?? 0) > Date.now() - 3_600_000,
      ).length >= 4
    )
      throw conflict('Máximo de cuatro cambios presupuestarios por objeto y hora.');
    const cumulative = same.reduce((s, x) => s + (previewOfRow(x)?.changePct ?? 0), 0);
    if (cumulative + p.changePct > policy.maxCumulativeChangePct + 1e-9)
      throw conflict('Supera el cambio acumulado de presupuesto en 24 horas.');
    const increases = recent.reduce(
      (s, x) => s + BigInt(previewOfRow(x)?.increaseMinor ?? '0'),
      0n,
    );
    if (increases + BigInt(p.increaseMinor) > BigInt(policy.maxDailyIncreaseMinor))
      throw conflict(
        'Supera el aumento presupuestario acumulado autorizado por cuenta en 24 horas.',
      );
  }
}

export interface ActionDeps {
  db: Db;
  config: Config;
  gateway: ActionGateway;
}
export function createActionService(deps: ActionDeps) {
  const { db, config, gateway } = deps;
  return {
    async list(ctx: TenantContext, accountId?: string) {
      return withContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ a: actions })
          .from(actions)
          .innerJoin(adAccounts, eq(adAccounts.id, actions.adAccountId))
          .where(
            and(
              clientScope(tx, ctx, adAccounts.clientId),
              accountId ? eq(actions.adAccountId, accountId) : undefined,
            ),
          )
          .orderBy(desc(actions.createdAt))
          .limit(100);
        const out: BudgetAction[] = [];
        for (const { a } of rows) out.push(await dto(tx, a));
        return out;
      });
    },
    async get(ctx: TenantContext, id: string) {
      return withContext(db, ctx, async (tx) => dto(tx, await rowFor(tx, ctx, id)));
    },
    async events(ctx: TenantContext, id: string) {
      return withContext(db, ctx, async (tx) => {
        await rowFor(tx, ctx, id);
        return (
          await tx
            .select()
            .from(actionEvents)
            .where(eq(actionEvents.actionId, id))
            .orderBy(actionEvents.id)
        ).map((e) => ({ ...e, at: e.at.toISOString() }));
      });
    },
    async policy(ctx: TenantContext, id: string) {
      return withContext(db, ctx, async (tx) => {
        await findAccount(tx, ctx, id);
        return {
          adAccountId: id,
          globalEnabled: config.META_WRITES_ENABLED,
          policy: await policyFor(tx, id),
        };
      });
    },
    async setPolicy(ctx: TenantContext, id: string, policy: Policy, reason: string) {
      return withContext(db, ctx, async (tx) => {
        await findAccount(tx, ctx, id);
        const authorizationVersion = randomUUID();
        await tx
          .insert(actionPolicies)
          .values({
            tenantId: ctx.tenantId,
            adAccountId: id,
            config: { ...policy, authorizationVersion },
            updatedBy: ctx.userId,
          })
          .onConflictDoUpdate({
            target: actionPolicies.adAccountId,
            set: {
              config: { ...policy, authorizationVersion },
              updatedBy: ctx.userId,
              updatedAt: new Date(),
            },
          });
        await recordEvent(
          tx,
          { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId },
          {
            action: 'action.policy_changed',
            targetType: 'ad_account',
            targetId: id,
            after: { policy, reason, authorizationVersion },
          },
        );
        return { adAccountId: id, globalEnabled: config.META_WRITES_ENABLED, policy };
      });
    },
    async propose(ctx: TenantContext, body: z.infer<typeof ActionCreateBody>) {
      return withContext(db, ctx, async (tx) => {
        const fingerprint = hash(body);
        const [existing] = await tx
          .select()
          .from(actions)
          .where(eq(actions.idempotencyKey, body.idempotencyKey));
        if (existing) {
          await findAccount(tx, ctx, existing.adAccountId);
          if (existing.requestHash !== fingerprint)
            throw conflict('Clave de idempotencia reutilizada con otro contenido.');
          return dto(tx, existing);
        }
        const [r] = await tx
          .select()
          .from(recommendations)
          .where(eq(recommendations.id, body.recommendationId))
          .for('update');
        if (!r) throw notFound('Recomendación');
        await findAccount(tx, ctx, r.adAccountId);
        // Otro POST con la misma clave pudo confirmar mientras esperábamos esta fila.
        const [duplicate] = await tx
          .select()
          .from(actions)
          .where(eq(actions.idempotencyKey, body.idempotencyKey));
        if (duplicate) {
          if (duplicate.requestHash !== fingerprint)
            throw conflict('Clave de idempotencia reutilizada con otro contenido.');
          return dto(tx, duplicate);
        }
        if (r.status !== 'accepted')
          throw conflict('Acepta primero la recomendación; aceptarla no autoriza ejecutar.');
        if (
          r.actionType === 'review' ||
          r.entityLevel === 'account' ||
          !/^\d{1,30}$/.test(r.entityMetaId)
        )
          throw badRequest('Esta recomendación no corresponde a una operación simple ejecutable.');
        const budget = fieldOf(r.actionType) !== 'status';
        if (budget && (!body.budgetMinor || body.budgetMinor === '0'))
          throw badRequest('Indica explícitamente el presupuesto en unidades menores.');
        if (!budget && body.budgetMinor !== undefined)
          throw badRequest('Una acción de estado no recibe presupuesto.');
        const a = first(
          await tx
            .insert(actions)
            .values({
              tenantId: ctx.tenantId,
              adAccountId: r.adAccountId,
              recommendationId: r.id,
              entityLevel: r.entityLevel,
              entityMetaId: r.entityMetaId,
              operation: r.actionType,
              desired: budget
                ? (body.budgetMinor as string)
                : r.actionType === 'pause'
                  ? 'PAUSED'
                  : 'ACTIVE',
              reason: body.reason,
              idempotencyKey: body.idempotencyKey,
              requestHash: fingerprint,
              proposedBy: ctx.userId,
            })
            .returning(),
        );
        await record(
          tx,
          a,
          'proposed',
          {
            recommendationId: r.id,
            operation: a.operation,
            desired: a.desired,
            reason: body.reason,
          },
          ctx.userId,
        );
        return dto(tx, a);
      });
    },
    async preview(ctx: TenantContext, id: string, revision: number) {
      return withContext(db, ctx, async (tx) => {
        const a = await rowFor(tx, ctx, id, true);
        assertRevision(a, revision);
        if (!['proposed', 'review', 'failed'].includes(a.state) || a.dispatchAt)
          throw conflict('Solo se revisan propuestas sin envío pendiente de reconciliar.');
        const auth = await authorization(tx, a, config),
          policy = await policyFor(tx, a.adAccountId);
        checkPolicy(policy, a.operation, auth.account.timezoneName);
        const snapshot = await gateway.inspect(auth, a);
        if (a.rollbackOf) {
          const [original] = await tx.select().from(actions).where(eq(actions.id, a.rollbackOf));
          if (
            !original?.after ||
            hash(configuration(snapshot)) !== hash(configuration(original.after as Snapshot))
          )
            throw conflict(
              'La configuración cambió desde la acción original; no es seguro revertir.',
            );
        }
        const p: Preview = {
          ...previewOf(snapshot, a.operation, a.desired, a.entityLevel, policy),
          policyHash: hash(policy),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          hash: '',
        };
        p.hash = hash({ ...p, nonce: randomUUID(), revision: a.revision });
        await checkFrequency(tx, a, p, policy);
        const after = await updateAction(tx, a, {
          state: 'review',
          preview: p,
          error: null,
          result: null,
        });
        await record(tx, after, 'reviewed', p, ctx.userId);
        return dto(tx, after);
      });
    },
    async approve(
      ctx: TenantContext,
      id: string,
      body: { revision: number; previewHash: string; reason: string },
    ) {
      return withContext(db, ctx, async (tx) => {
        const a = await rowFor(tx, ctx, id, true);
        assertRevision(a, body.revision);
        if (a.state !== 'review') throw conflict('La acción no está en revisión.');
        if (!config.META_WRITES_ENABLED)
          throw conflict('Interruptor global de escrituras desactivado.');
        if (!(await eligibleApprover(tx, a, ctx.userId)))
          throw forbidden(
            'Se necesita otro aprobador autorizado; los presupuestos solo los aprueban owner/admin.',
          );
        const auth = await authorization(tx, a, config),
          policy = await policyFor(tx, a.adAccountId),
          p = previewOfRow(a);
        ensurePreview(a, p, policy);
        const preview = p as Preview;
        if (preview.hash !== body.previewHash)
          throw conflict('El diff aprobado no coincide con la revisión actual.');
        checkPolicy(policy, a.operation, auth.account.timezoneName);
        const live = await gateway.inspect(auth, a);
        if (hash(configuration(live)) !== hash(configuration(preview.snapshot)))
          throw conflict('Meta cambió desde la revisión: previsualiza de nuevo.');
        await checkFrequency(tx, a, preview, policy);
        const inserted = await tx
          .insert(actionApprovals)
          .values({
            tenantId: a.tenantId,
            actionId: id,
            userId: ctx.userId,
            previewHash: preview.hash,
            reason: body.reason,
          })
          .onConflictDoNothing()
          .returning();
        const enough = (await validApprovalCount(tx, a, preview)) >= preview.requiredApprovals;
        const after = inserted.length
          ? await updateAction(tx, a, { state: enough ? 'approved' : 'review' })
          : a;
        if (inserted.length)
          await record(
            tx,
            after,
            'approved',
            { previewHash: preview.hash, reason: body.reason, quorum: enough },
            ctx.userId,
          );
        if (enough)
          await enqueue(tx, {
            tenantId: a.tenantId,
            kind: 'action_execute',
            payload: { actionId: id },
            dedupeKey: `action:${id}:${after.revision}`,
          });
        return dto(tx, after);
      });
    },
    async close(
      ctx: TenantContext,
      id: string,
      body: { revision: number; reason: string; acknowledgeUnknown: boolean },
    ) {
      return withContext(db, ctx, async (tx) => {
        const a = await rowFor(tx, ctx, id, true);
        assertRevision(a, body.revision);
        if (!['proposed', 'review', 'approved', 'failed'].includes(a.state))
          throw conflict('No se puede cerrar durante una ejecución o verificación.');
        if (a.dispatchAt && !body.acknowledgeUnknown)
          throw conflict('Debes reconocer explícitamente que el resultado puede ser desconocido.');
        const after = await updateAction(tx, a, {
          state: 'closed',
          result: a.dispatchAt ? 'abandoned_unknown' : 'cancelled',
        });
        await record(
          tx,
          after,
          'closed',
          { reason: body.reason, result: after.result },
          ctx.userId,
        );
        return dto(tx, after);
      });
    },
    async reconcile(ctx: TenantContext, id: string) {
      return withContext(db, ctx, async (tx) => {
        const a = await rowFor(tx, ctx, id, true);
        // Si el trabajo agotó sus intentos (p. ej. BD caída tras el marcador), nadie relee la
        // acción y no se puede cerrar en ejecución/verificación: se permite pedir otra lectura.
        const [active] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.tenantId, a.tenantId),
              eq(jobs.kind, 'action_execute'),
              inArray(jobs.status, ['queued', 'running']),
              sql`${jobs.payload}->>'actionId' = ${a.id}`,
            ),
          )
          .limit(1);
        const stalled = ['executing', 'verifying'].includes(a.state) && !active;
        if (!a.dispatchAt || !(a.state === 'failed' || stalled))
          throw conflict('Solo se reconcilian envíos pendientes de verificar sin trabajo activo.');
        const after = await updateAction(tx, a, { state: 'verifying', verificationAttempts: 0 });
        await enqueue(tx, {
          tenantId: a.tenantId,
          kind: 'action_execute',
          payload: { actionId: id },
          dedupeKey: `action-reconcile:${id}:${after.revision}`,
        });
        await record(tx, after, 'reconciliation_requested', {}, ctx.userId);
        return dto(tx, after);
      });
    },
    async rollback(ctx: TenantContext, id: string, key: string, reason: string) {
      return withContext(db, ctx, async (tx) => {
        const a = await rowFor(tx, ctx, id, true),
          p = previewOfRow(a);
        if (a.state !== 'closed' || a.result !== 'verified' || !a.confirmedWrite || !p || !a.after)
          throw conflict('Solo se revierte una escritura confirmada y verificada.');
        const [existing] = await tx.select().from(actions).where(eq(actions.rollbackOf, id));
        if (existing) {
          if (existing.idempotencyKey !== key || existing.requestHash !== hash({ id, key, reason }))
            throw conflict('Ya existe una propuesta de reversión.');
          return dto(tx, existing);
        }
        const operation =
          p.field === 'status' ? (p.before === 'ACTIVE' ? 'activate' : 'pause') : a.operation;
        const auth = await authorization(tx, a, config),
          live = await gateway.inspect(auth, a);
        if (hash(configuration(live)) !== hash(configuration(a.after as Snapshot)))
          throw conflict('Meta cambió después de verificar: rollback bloqueado.');
        const r = first(
          await tx
            .insert(actions)
            .values({
              tenantId: a.tenantId,
              adAccountId: a.adAccountId,
              rollbackOf: id,
              entityLevel: a.entityLevel,
              entityMetaId: a.entityMetaId,
              operation,
              desired: p.before,
              reason,
              proposedBy: ctx.userId,
              idempotencyKey: key,
              requestHash: hash({ id, key, reason }),
            })
            .returning(),
        );
        await record(tx, r, 'rollback_proposed', { originalActionId: id, reason }, ctx.userId);
        return dto(tx, r);
      });
    },
  };
}

/** No guardar mensajes crudos de Graph: pueden repetir credenciales o contenido de terceros. */
export const safeError = (err: unknown) =>
  err instanceof AppError
    ? (err.detail ?? err.message)
    : 'No se pudo confirmar la operación con Meta; consulta la bitácora y reconcilia.';

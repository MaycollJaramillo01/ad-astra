import { createHash, timingSafeEqual } from 'node:crypto';
import { eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, type Tx, withContext } from '../db/client.ts';
import {
  actions,
  deploymentState,
  jobs,
  llmBudgetHolds,
  llmUsage,
  metaConnections,
  monitoringDeliveries,
  syncRuns,
  technicalIncidents,
} from '../db/schema.ts';
import type { Config } from './config.ts';
import { AppError, conflict, notFound, unauthorized } from './errors.ts';
import { recordEvent } from './events.ts';
import { type TenantContext, tenantOf } from './http.ts';

export const SCHEMA_VERSION = 17;

/** El operador llama dentro de una transacción; ingesta autorizada sin liberar efectos externos. */
export async function activateReadOnly(
  tx: Tx,
  input: { tenantId: string; environment: Config['APP_ENV']; reason: string },
) {
  if (input.reason.trim().length < 10) throw conflict('Se requiere un motivo de activación.');
  const [state] = await tx
    .select()
    .from(deploymentState)
    .where(eq(deploymentState.id, 1))
    .for('update');
  if (!state || state.environment !== input.environment || state.schemaVersion < SCHEMA_VERSION)
    throw conflict('Entorno incompatible o migraciones pendientes.');
  if (state.readOnlyMode && !state.recoveryMode) return state;
  if (!state.recoveryMode) throw conflict('Activar solo lectura exige cuarentena previa.');
  const [running] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.status, 'running'))
    .limit(1);
  if (running) throw conflict('Hay trabajos en curso; detener y conciliar antes de activar.');
  const [updated] = await tx
    .update(deploymentState)
    .set({ readOnlyMode: true, recoveryMode: false, updatedAt: new Date() })
    .where(eq(deploymentState.id, 1))
    .returning();
  await recordEvent(
    tx,
    { tenantId: input.tenantId, actorType: 'system' },
    {
      action: 'operations.read-only',
      targetType: 'deployment',
      targetId: input.environment,
      after: { reason: input.reason, readOnlyMode: true, externalEffectsEnabled: false },
    },
  );
  if (!updated) throw conflict('No se pudo activar el modo de lectura.');
  return updated;
}
export async function assertDeployment(db: Db, config: Config) {
  const [state] = await db.select().from(deploymentState).where(eq(deploymentState.id, 1));
  if (!state || state.schemaVersion < SCHEMA_VERSION || state.environment !== config.APP_ENV)
    throw new AppError(
      503,
      'environment-mismatch',
      'Base de datos sin migrar o vinculada a otro entorno',
    );
  const { rows } = await db.execute<{ unsafe: boolean }>(
    sql`select (r.rolsuper or r.rolbypassrls or exists(select 1 from pg_class c where c.relowner=r.oid and c.relkind in ('r','p') and c.relnamespace='public'::regnamespace)) as unsafe from pg_roles r where r.rolname=current_user`,
  );
  if (rows[0]?.unsafe !== false)
    throw new AppError(
      503,
      'unsafe-db-role',
      'El runtime requiere un rol sin propiedad ni bypass de RLS',
    );
  return state;
}
export async function assertSideEffects(tx: Tx, config: Config, tenantId: string) {
  const [state] = await tx.select().from(deploymentState).where(eq(deploymentState.id, 1));
  if (!state || state.recoveryMode || state.readOnlyMode || state.environment !== config.APP_ENV)
    throw conflict(
      'Efectos externos bloqueados por recuperación, solo lectura o entorno no vinculado.',
    );
  if (config.APP_ENV === 'production' && !config.WRITE_TENANT_ALLOWLIST.includes(tenantId))
    throw conflict('Tenant fuera del grupo autorizado para esta fase de despliegue.');
}
export async function technicalSnapshot(db: Db, ctx: TenantContext) {
  return withContext(db, ctx, async (tx) => {
    const [state] = await tx.select().from(deploymentState);
    const [queue] = await tx
      .select({
        queued: sql<number>`count(*) filter(where status='queued')::int`,
        failed: sql<number>`count(*) filter(where status='failed' and updated_at>now()-interval '24 hours')::int`,
        expired: sql<number>`count(*) filter(where status='running' and locked_until<now())::int`,
        oldestDue: sql<
          string | null
        >`min(run_after) filter(where status='queued' and run_after<=now())`,
      })
      .from(jobs)
      .where(eq(jobs.tenantId, ctx.tenantId));
    const [meta] = await tx
      .select({
        calls: sql<number>`coalesce(sum(api_calls),0)::int`,
        failures: sql<number>`count(*) filter(where status='failed')::int`,
        throttled: sql<number>`count(*) filter(where status='throttled')::int`,
      })
      .from(syncRuns)
      .where(gte(syncRuns.startedAt, new Date(Date.now() - 86400000)));
    const [cost] = await tx
      .select({
        usd: sql<string>`coalesce(sum(cost_usd),0)`,
        input: sql<string>`coalesce(sum(input_tokens),0)`,
        output: sql<string>`coalesce(sum(output_tokens),0)`,
      })
      .from(llmUsage)
      .where(sql`${llmUsage.createdAt}>=date_trunc('month',now())`);
    const [holds] = await tx
      .select({ count: sql<number>`count(*)::int`, usd: sql<string>`coalesce(sum(amount_usd),0)` })
      .from(llmBudgetHolds)
      .where(inArray(llmBudgetHolds.status, ['reserved', 'unknown']));
    const [writes] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(actions)
      .where(eq(actions.result, 'unknown'));
    const [notices] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(monitoringDeliveries)
      .where(inArray(monitoringDeliveries.status, ['unknown', 'sending']));
    const [connections] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(metaConnections)
      .where(eq(metaConnections.status, 'invalid'));
    const now = Date.now(),
      age = (at: Date | null | undefined) => (at ? now - at.getTime() : Infinity);
    const observations = [
      {
        code: 'meta_connection_invalid',
        severity: 'critical' as const,
        hit: (connections?.count ?? 0) > 0,
        evidence: { count: connections?.count ?? 0 },
      },
      {
        code: 'worker_stale',
        severity: 'critical' as const,
        hit: age(state?.workerFinishedAt) > 15 * 60000,
        evidence: { lastFinishedAt: state?.workerFinishedAt ?? null },
      },
      {
        code: 'queue_delayed',
        severity: 'high' as const,
        hit: !!queue?.oldestDue && now - Date.parse(queue.oldestDue) > 15 * 60000,
        evidence: { oldestDue: queue?.oldestDue ?? null },
      },
      {
        code: 'dead_jobs',
        severity: 'high' as const,
        hit: (queue?.failed ?? 0) > 0,
        evidence: { count: queue?.failed ?? 0, windowHours: 24 },
      },
      {
        code: 'expired_leases',
        severity: 'high' as const,
        hit: (queue?.expired ?? 0) > 0,
        evidence: { count: queue?.expired ?? 0 },
      },
      {
        code: 'unknown_writes',
        severity: 'critical' as const,
        hit: (writes?.count ?? 0) > 0,
        evidence: { count: writes?.count ?? 0 },
      },
      {
        code: 'unknown_notifications',
        severity: 'high' as const,
        hit: (notices?.count ?? 0) > 0,
        evidence: { count: notices?.count ?? 0 },
      },
      {
        code: 'llm_holds',
        severity: 'medium' as const,
        hit: (holds?.count ?? 0) > 0,
        evidence: { count: holds?.count ?? 0, reservedUsd: Number(holds?.usd ?? 0) },
      },
      {
        code: 'backup_stale',
        severity: 'critical' as const,
        hit: age(state?.backupAt) > 86400000,
        evidence: { lastBackupAt: state?.backupAt ?? null },
      },
      {
        code: 'restore_drill_stale',
        severity: 'high' as const,
        hit: age(state?.restoreDrillAt) > 30 * 86400000,
        evidence: { lastDrillAt: state?.restoreDrillAt ?? null },
      },
      {
        code: 'recovery_mode',
        severity: 'critical' as const,
        hit: state?.recoveryMode !== false,
        evidence: { enabled: state?.recoveryMode ?? true },
      },
    ];
    return {
      environment: state?.environment ?? 'unbound',
      schemaVersion: state?.schemaVersion ?? 0,
      recoveryMode: state?.recoveryMode ?? true,
      readOnlyMode: state?.readOnlyMode ?? true,
      worker: { startedAt: state?.workerStartedAt, finishedAt: state?.workerFinishedAt },
      queue,
      meta24h: meta,
      llmMonth: {
        usd: Number(cost?.usd ?? 0),
        inputTokens: Number(cost?.input ?? 0),
        outputTokens: Number(cost?.output ?? 0),
        reservedUsd: Number(holds?.usd ?? 0),
      },
      observations,
      at: new Date().toISOString(),
    };
  });
}
export async function evaluateTechnical(db: Db, tenantId: string) {
  const snapshot = await technicalSnapshot(db, {
    tenantId,
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'owner',
  });
  await withContext(db, { tenantId }, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`technical:${tenantId}`},0))`,
    );
    for (const o of snapshot.observations) {
      const [old] = await tx
        .select()
        .from(technicalIncidents)
        .where(eq(technicalIncidents.code, o.code));
      const status = o.hit ? 'open' : 'resolved';
      if (!old && !o.hit) continue;
      await tx
        .insert(technicalIncidents)
        .values({ tenantId, code: o.code, severity: o.severity, status, evidence: o.evidence })
        .onConflictDoUpdate({
          target: [technicalIncidents.tenantId, technicalIncidents.code],
          set: { status, evidence: o.evidence, updatedAt: new Date() },
        });
      if (old?.status !== status)
        await recordEvent(
          tx,
          { tenantId, actorType: 'system' },
          {
            action: 'operations.alert',
            targetType: 'technical_incident',
            targetId: o.code,
            after: { status, severity: o.severity, evidence: o.evidence },
          },
        );
    }
  });
  return snapshot;
}
export async function operationsRoutes(
  app: FastifyInstance,
  { db, config }: { db: Db; config: Config },
) {
  app.get(
    '/v1/operations',
    { config: { access: { permission: 'operations:read' } } },
    async (r) => {
      await assertDeployment(db, config);
      return technicalSnapshot(db, tenantOf(r));
    },
  );
  app.get(
    '/v1/internal/operations',
    { config: { access: { public: true } }, schema: { hide: true } },
    async (r, reply) => {
      if (!config.OPS_MONITOR_SECRET) throw notFound();
      const digest = (s: string) => createHash('sha256').update(s).digest();
      if (
        !timingSafeEqual(
          digest(r.headers.authorization ?? ''),
          digest(`Bearer ${config.OPS_MONITOR_SECRET}`),
        )
      )
        throw unauthorized();
      const state = await assertDeployment(db, config),
        now = Date.now();
      const [queue] = await db
        .select({
          delayed: sql<number>`count(*) filter(where status='queued' and run_after<now()-interval '15 minutes')::int`,
        })
        .from(jobs);
      const heartbeatAgeSeconds = state.workerFinishedAt
        ? Math.round((now - state.workerFinishedAt.getTime()) / 1000)
        : null;
      const backupFresh = state.backupAt !== null && now - state.backupAt.getTime() < 26 * 3600000;
      const drillFresh =
        state.restoreDrillAt !== null && now - state.restoreDrillAt.getTime() < 30 * 86400000;
      const status =
        !state.recoveryMode &&
        !state.readOnlyMode &&
        backupFresh &&
        drillFresh &&
        heartbeatAgeSeconds !== null &&
        heartbeatAgeSeconds <= 900 &&
        (queue?.delayed ?? 0) === 0
          ? 'ready'
          : 'degraded';
      return reply.code(status === 'ready' ? 200 : 503).send({
        status,
        environment: state.environment,
        schemaVersion: state.schemaVersion,
        heartbeatAgeSeconds,
        backupAt: state.backupAt,
        restoreDrillAt: state.restoreDrillAt,
        delayedJobs: queue?.delayed ?? 0,
      });
    },
  );
}

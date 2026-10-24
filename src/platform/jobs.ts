import { and, eq, like, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db, Tx } from '../db/client.ts';
import { jobs } from '../db/schema.ts';
import { redact } from './logging.ts';

// Cola de trabajos sobre Postgres drenada por un tick programado (ADR-022). Sin procesos
// permanentes: Vercel Cron llama al tick cada pocos minutos y este procesa lo vencido hasta su
// plazo; lo que no termine queda para el siguiente.

export type Job = typeof jobs.$inferSelect;

export type JobOutcome =
  /** Terminado. Si es recurrente, vuelve a la cola dentro de `recurringEverySeconds`. */
  | { type: 'done' }
  /** Terminado para siempre aunque sea recurrente (p. ej. sincronización desactivada). */
  | { type: 'end'; reason: string }
  /** Esperar sin gastar un intento (cuota de Meta, trabajo previo pendiente). */
  | { type: 'reschedule'; runAfter: Date; reason: string }
  /** Seguir más tarde con otro payload sin gastar intento (trabajo por tramos, p. ej. backfill). */
  | { type: 'continue'; payload: Record<string, unknown>; runAfter?: Date }
  /** Error transitorio: reintento con backoff exponencial hasta `maxAttempts`. */
  | { type: 'retry'; error: string }
  /** Error permanente: el trabajo se detiene (aunque sea recurrente). */
  | { type: 'stop'; error: string };

export type JobHandler = (job: Job) => Promise<JobOutcome>;

const LEASE_MINUTES = 15;

export interface EnqueueInput {
  tenantId: string;
  kind: string;
  /** Solo identificadores (lo comprueba test/rls.test.ts). */
  payload?: Record<string, unknown>;
  dedupeKey: string;
  recurringEverySeconds?: number;
  runAfter?: Date;
}

/** Encola si no hay ya uno activo (en cola o en curso) con la misma clave. */
export async function enqueue(tx: Db | Tx, input: EnqueueInput): Promise<void> {
  await tx
    .insert(jobs)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey,
      recurringEverySeconds: input.recurringEverySeconds ?? null,
      runAfter: input.runAfter ?? new Date(),
    })
    .onConflictDoNothing({
      target: jobs.dedupeKey,
      where: sql`${jobs.status} in ('queued', 'running')`,
    });
}

/** Cancela los trabajos en cola cuya clave empieza por el prefijo (p. ej. `entities:<id>`). */
export async function cancelQueued(tx: Db | Tx, dedupePrefix: string): Promise<void> {
  await tx
    .delete(jobs)
    .where(and(eq(jobs.status, 'queued'), like(jobs.dedupeKey, `${dedupePrefix}%`)));
}

/**
 * Reclama un trabajo vencido. `FOR UPDATE SKIP LOCKED`: varios ticks o workers en paralelo no
 * se pisan. Un trabajo en curso con el lease caducado (tick que murió) se vuelve a reclamar.
 */
export async function claimJob(db: Db, tenantId?: string): Promise<Job | null> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    update jobs set status = 'running', attempts = attempts + 1, updated_at = now(),
                    locked_until = now() + make_interval(mins => ${LEASE_MINUTES})
    where id = (
      select id from jobs
      where ((status = 'queued' and run_after <= now()) or (status = 'running' and locked_until < now()))
        and (${tenantId ?? null}::uuid is null or tenant_id = ${tenantId ?? null}::uuid)
      order by run_after
      limit 1
      for update skip locked
    )
    returning id`);
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, Number(id)));
  return job ?? null;
}

const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

export async function finishJob(db: Db, job: Job, outcome: JobOutcome): Promise<void> {
  const base = { lockedUntil: null, updatedAt: new Date() };
  const requeueRecurring = (lastError: string | null) => ({
    ...base,
    status: 'queued' as const,
    attempts: 0,
    lastError,
    runAfter: new Date(Date.now() + (job.recurringEverySeconds ?? 0) * 1000),
  });

  let set: Partial<Job>;
  switch (outcome.type) {
    case 'done':
      set = job.recurringEverySeconds
        ? requeueRecurring(null)
        : { ...base, status: 'succeeded', lastError: null };
      break;
    case 'end':
      set = { ...base, status: 'succeeded', lastError: redact(outcome.reason) };
      break;
    case 'reschedule':
      set = {
        ...base,
        status: 'queued',
        runAfter: outcome.runAfter,
        attempts: Math.max(0, job.attempts - 1),
        lastError: redact(outcome.reason),
      };
      break;
    case 'continue':
      set = {
        ...base,
        status: 'queued',
        payload: outcome.payload,
        runAfter: outcome.runAfter ?? new Date(),
        attempts: 0,
        lastError: null,
      };
      break;
    case 'retry':
      if (job.attempts < job.maxAttempts) {
        set = {
          ...base,
          status: 'queued',
          runAfter: new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
          lastError: redact(outcome.error),
        };
      } else {
        // Agotados los reintentos: un recurrente sigue con su calendario; uno puntual falla.
        set = job.recurringEverySeconds
          ? requeueRecurring(redact(outcome.error))
          : { ...base, status: 'failed', lastError: redact(outcome.error) };
      }
      break;
    case 'stop':
      set = { ...base, status: 'failed', lastError: redact(outcome.error) };
      break;
  }
  await db.update(jobs).set(set).where(eq(jobs.id, job.id));
}

export interface TickResult {
  processed: number;
  outcomes: Record<JobOutcome['type'], number>;
}

/**
 * Procesa trabajos vencidos hasta agotarlos o hasta el plazo, con `concurrency` trabajadores.
 * Un handler que lanza una excepción se trata como error transitorio (reintento).
 */
export async function runTick(opts: {
  db: Db;
  handlers: Record<string, JobHandler>;
  budgetMs: number;
  concurrency?: number;
  log: Logger;
  /** Limitar a un tenant (operación puntual o tests). */
  tenantId?: string;
}): Promise<TickResult> {
  const deadline = Date.now() + opts.budgetMs;
  const result: TickResult = {
    processed: 0,
    outcomes: { done: 0, end: 0, reschedule: 0, continue: 0, retry: 0, stop: 0 },
  };

  const worker = async () => {
    while (Date.now() < deadline) {
      const job = await claimJob(opts.db, opts.tenantId);
      if (!job) return;
      const log = opts.log.child({ job: job.id, kind: job.kind, tenant: job.tenantId });
      const handler = opts.handlers[job.kind];
      let outcome: JobOutcome;
      try {
        outcome = handler
          ? await handler(job)
          : { type: 'stop', error: `Tipo de trabajo desconocido: ${job.kind}` };
      } catch (err) {
        log.error({ err }, 'el trabajo lanzó una excepción');
        outcome = { type: 'retry', error: err instanceof Error ? err.message : String(err) };
      }
      await finishJob(opts.db, job, outcome);
      result.processed++;
      result.outcomes[outcome.type]++;
      log.info({ outcome: outcome.type }, 'trabajo procesado');
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  return result;
}

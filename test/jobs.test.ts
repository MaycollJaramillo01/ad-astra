import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { jobs } from '../src/db/schema.ts';
import { claimJob, enqueue, finishJob, type Job, runTick } from '../src/platform/jobs.ts';
import { createLogger } from '../src/platform/logging.ts';
import { seedTenant, testDb } from './seed.ts';

// Cola de trabajos del tick (ADR-022). Cada test usa su propio tenant: la tabla es global.
const db = testDb();
const log = createLogger(undefined, 'silent');
let tenantId: string;

beforeEach(async () => {
  tenantId = (await seedTenant(db)).tenantId;
});

const add = (key: string, extra: Partial<Parameters<typeof enqueue>[1]> = {}) =>
  enqueue(db, { tenantId, kind: 'test', dedupeKey: `${tenantId}:${key}`, ...extra });
const load = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0] as Job;
const claim = async () => {
  const job = await claimJob(db, tenantId);
  if (!job) throw new Error('no se reclamó ningún trabajo');
  return job;
};

describe('encolar y reclamar', () => {
  it('no duplica un trabajo activo con la misma clave', async () => {
    await add('a');
    await add('a');
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from jobs where tenant_id = ${tenantId}`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('no reclama trabajos futuros', async () => {
    await add('futuro', { runAfter: new Date(Date.now() + 60_000) });
    expect(await claimJob(db, tenantId)).toBeNull();
  });

  it('reclamaciones simultáneas nunca obtienen el mismo trabajo (SKIP LOCKED)', async () => {
    for (let i = 0; i < 6; i++) await add(`p${i}`);
    const claimed = await Promise.all(Array.from({ length: 8 }, () => claimJob(db, tenantId)));
    const ids = claimed.filter((j) => j !== null).map((j) => j.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('un trabajo en curso con el lease caducado se vuelve a reclamar', async () => {
    await add('huerfano');
    const job = await claim();
    await db
      .update(jobs)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id));
    expect((await claim()).id).toBe(job.id);
  });
});

describe('resultados', () => {
  it('done: un recurrente vuelve a la cola; uno puntual termina', async () => {
    await add('rec', { recurringEverySeconds: 3600 });
    const rec = await claim();
    await finishJob(db, rec, { type: 'done' });
    const after = await load(rec.id);
    expect(after).toMatchObject({ status: 'queued', attempts: 0, lockedUntil: null });
    expect(after.runAfter.getTime()).toBeGreaterThan(Date.now() + 3500_000);

    await add('una');
    const once = await claim();
    await finishJob(db, once, { type: 'done' });
    expect((await load(once.id)).status).toBe('succeeded');
  });

  it('reschedule y continue no gastan intentos; continue cambia el payload', async () => {
    await add('cuota');
    const job = await claim();
    expect(job.attempts).toBe(1);
    const until = new Date(Date.now() + 300_000);
    await finishJob(db, job, { type: 'reschedule', runAfter: until, reason: 'cuota' });
    expect(await load(job.id)).toMatchObject({ status: 'queued', attempts: 0, runAfter: until });

    await db.update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, job.id));
    const again = await claim();
    await finishJob(db, again, { type: 'continue', payload: { monthsDone: 3 } });
    expect(await load(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      payload: { monthsDone: 3 },
    });
  });

  it('retry aplica backoff y, agotados los intentos, falla (puntual) o sigue su calendario (recurrente)', async () => {
    await add('fragil', {});
    let job = await claim();
    await finishJob(db, job, { type: 'retry', error: 'timeout' });
    const queued = await load(job.id);
    expect(queued).toMatchObject({ status: 'queued', lastError: 'timeout' });
    expect(queued.runAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);

    await db.update(jobs).set({ attempts: 5, runAfter: new Date() }).where(eq(jobs.id, job.id));
    job = await claim(); // attempts = 6 > maxAttempts
    await finishJob(db, job, { type: 'retry', error: 'timeout' });
    expect((await load(job.id)).status).toBe('failed');

    await add('fragil-rec', { recurringEverySeconds: 600 });
    const rec = await claim();
    await db.update(jobs).set({ attempts: 5 }).where(eq(jobs.id, rec.id));
    await finishJob(db, { ...rec, attempts: 5 }, { type: 'retry', error: 'caída' });
    expect(await load(rec.id)).toMatchObject({ status: 'queued', attempts: 0, lastError: 'caída' });
  });

  it('stop detiene incluso un recurrente; end termina sin error', async () => {
    await add('auth', { recurringEverySeconds: 600 });
    const job = await claim();
    await finishJob(db, job, { type: 'stop', error: 'token inválido' });
    expect((await load(job.id)).status).toBe('failed');

    await add('fin', { recurringEverySeconds: 600 });
    const end = await claim();
    await finishJob(db, end, { type: 'end', reason: 'sincronización desactivada' });
    expect((await load(end.id)).status).toBe('succeeded');
  });

  it('el error guardado se redacta', async () => {
    await add('secreto');
    const job = await claim();
    await finishJob(db, job, {
      type: 'stop',
      error: 'fallo en https://x/?access_token=EAAsecreto123',
    });
    expect((await load(job.id)).lastError).not.toContain('EAAsecreto123');
  });
});

describe('tick', () => {
  it('procesa lo vencido con varios trabajadores y trata excepciones y tipos desconocidos', async () => {
    for (let i = 0; i < 4; i++) await add(`ok${i}`);
    await enqueue(db, { tenantId, kind: 'explota', dedupeKey: `${tenantId}:explota` });
    await enqueue(db, { tenantId, kind: 'desconocido', dedupeKey: `${tenantId}:desconocido` });
    const seen: number[] = [];
    const result = await runTick({
      db,
      log,
      tenantId,
      budgetMs: 10_000,
      concurrency: 3,
      handlers: {
        test: async (job) => {
          seen.push(job.id);
          return { type: 'done' };
        },
        explota: async () => {
          throw new Error('fallo inesperado');
        },
      },
    });
    expect(result.processed).toBe(6);
    expect(result.outcomes).toMatchObject({ done: 4, retry: 1, stop: 1 });
    expect(new Set(seen).size).toBe(4);
  });

  it('sin presupuesto no procesa nada', async () => {
    await add('espera');
    const result = await runTick({ db, log, tenantId, budgetMs: 0, handlers: {} });
    expect(result.processed).toBe(0);
  });
});

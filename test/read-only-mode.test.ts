import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, type Tx } from '../src/db/client.ts';
import { auditLog, deploymentState, jobs } from '../src/db/schema.ts';
import { claimJob, enqueue, finishJob } from '../src/platform/jobs.ts';
import { activateReadOnly, assertSideEffects } from '../src/platform/operations.ts';
import { config } from './app.ts';
import { testEnv } from './env.ts';

// Tablas temporales con el esquema real: no se cambia el estado global que usan las otras suites.
async function isolated(run: (tx: Tx, tenantId: string) => Promise<void>) {
  const owner = createDb(testEnv.DATABASE_URL_OWNER);
  try {
    await owner.db.transaction(async (tx) => {
      await tx.execute(
        sql`create temporary table deployment_state (like public.deployment_state including all) on commit drop`,
      );
      await tx.execute(
        sql`create temporary table jobs (like public.jobs including all) on commit drop`,
      );
      await tx.execute(
        sql`create temporary table audit_log (like public.audit_log including all) on commit drop`,
      );
      await tx
        .insert(deploymentState)
        .values({ environment: 'production', recoveryMode: true, schemaVersion: 17 });
      await run(tx, randomUUID());
    });
  } finally {
    await owner.pool.end();
  }
}
it('solo lectura procesa ingesta y auditoría, conserva pendientes los envíos y registra la activación una sola vez', async () => {
  await isolated(async (tx, tenantId) => {
    const input = {
      tenantId,
      environment: 'production' as const,
      reason: 'Autorización explícita para importar datos de las cuentas',
    };
    await activateReadOnly(tx, input);
    await activateReadOnly(tx, input);
    for (const kind of ['action_execute', 'monitoring_deliver', 'unknown', 'entities', 'audit'])
      await enqueue(tx, { tenantId, kind, dedupeKey: kind, runAfter: new Date(0) });
    const claimed = [];
    for (let i = 0; i < 2; i++) {
      const job = await claimJob(tx, tenantId);
      if (!job) throw Error('Falta trabajo de lectura');
      claimed.push(job.kind);
      await finishJob(tx, job, { type: 'done' });
    }
    expect(claimed.sort()).toEqual(['audit', 'entities']);
    expect(await claimJob(tx, tenantId)).toBeNull();
    expect((await tx.select().from(jobs)).filter((j) => j.status === 'queued')).toHaveLength(3);
    expect(await tx.select().from(auditLog)).toHaveLength(1);
    const allowed = {
      ...config,
      APP_ENV: 'production' as const,
      WRITE_TENANT_ALLOWLIST: [tenantId],
    };
    await expect(assertSideEffects(tx, allowed, tenantId)).rejects.toMatchObject({ status: 409 });
    await tx.update(deploymentState).set({ readOnlyMode: false });
    await expect(assertSideEffects(tx, allowed, tenantId)).resolves.toBeUndefined();
  });
});
it('la recuperación sigue bloqueando la lectura incluso con solo lectura configurado', async () => {
  await isolated(async (tx, tenantId) => {
    await tx.update(deploymentState).set({ readOnlyMode: true, recoveryMode: true });
    await enqueue(tx, { tenantId, kind: 'entities', dedupeKey: 'read' });
    expect(await claimJob(tx, tenantId)).toBeNull();
  });
});
it('la activación rechaza otro entorno y trabajos en curso sin quitar la cuarentena', async () => {
  await isolated(async (tx, tenantId) => {
    await expect(
      activateReadOnly(tx, { tenantId, environment: 'staging', reason: 'Intento de otro entorno' }),
    ).rejects.toMatchObject({ status: 409 });
    await enqueue(tx, { tenantId, kind: 'entities', dedupeKey: 'running' });
    await tx.update(jobs).set({ status: 'running' });
    await expect(
      activateReadOnly(tx, {
        tenantId,
        environment: 'production',
        reason: 'Importación con trabajo previo en curso',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await tx.select().from(deploymentState).where(eq(deploymentState.id, 1)))[0]?.recoveryMode,
    ).toBe(true);
  });
});

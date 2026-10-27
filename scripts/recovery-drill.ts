import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { createDb, withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { tokenAad } from '../src/modules/meta/sync.ts';
import { createTokenCipher } from '../src/platform/crypto.ts';
import { claimJob, enqueue, finishJob } from '../src/platform/jobs.ts';
import { seedTenant } from '../test/seed.ts';
import { backupDatabase, restoreDatabase } from './backup.ts';
import { runMigrations } from './migrate.ts';

/** Solo bases nuevas de laboratorio en el Postgres local; jamás borra la BD de trabajo/test. */
export async function recoveryDrill() {
  const root = new URL(
    process.env.DRILL_ADMIN_URL ?? 'postgres://postgres:postgres_local@localhost:55432/postgres',
  );
  if (
    !['localhost', '127.0.0.1'].includes(root.hostname) ||
    root.port !== '55432' ||
    root.pathname !== '/postgres'
  )
    throw new Error('Simulacro limitado al laboratorio local :55432/postgres');
  const id = randomUUID().replaceAll('-', '').slice(0, 10),
    names = [
      `ad_astra_drill_${id}_source`,
      `ad_astra_drill_${id}_restore`,
      `ad_astra_drill_${id}_corrupt`,
    ] as const;
  const admin = new pg.Client({ connectionString: root.href });
  await admin.connect();
  const url = (name: string, role = 'postgres') => {
    const u = new URL(root);
    u.pathname = `/${name}`;
    if (role === 'app_owner') {
      u.username = role;
      u.password = 'app_owner_local';
    }
    if (role === 'app_rw') {
      u.username = role;
      u.password = 'app_rw_local';
    }
    return u.href;
  };
  const pools: Array<pg.Pool> = [],
    evidenceDir = join('spike-output', 'readiness');
  await mkdir(evidenceDir, { recursive: true });
  const start = performance.now();
  try {
    for (const name of names) {
      assert.match(name, /^ad_astra_drill_[a-f0-9]{10}_(source|restore|corrupt)$/);
      await admin.query(`create database ${name} owner app_owner`);
    }
    const grant = new pg.Client({ connectionString: url(names[0], 'app_owner') });
    await grant.connect();
    await grant.query(
      'grant usage on schema public to app_rw; alter default privileges for role app_owner in schema public grant select,insert,update,delete on tables to app_rw; alter default privileges for role app_owner in schema public grant usage,select on sequences to app_rw',
    );
    await grant.end();
    await runMigrations(url(names[0], 'app_owner'));
    const source = createDb(url(names[0], 'app_rw'));
    pools.push(source.pool);
    const bind = new pg.Client({ connectionString: url(names[0]) });
    await bind.connect();
    await bind.query("update deployment_state set environment='test',recovery_mode=false");
    await bind.end();
    const a = await seedTenant(source.db, 'drill-a'),
      b = await seedTenant(source.db, 'drill-b');
    const cipher = createTokenCipher(new Map([[1, randomBytes(32)]]), 1),
      canary = 'EAARecoverySyntheticCanary0123456789',
      sealed = cipher.seal(canary, tokenAad(a.tenantId, a.connection.id));
    await withContext(source.db, { tenantId: a.tenantId }, async (tx) => {
      await tx
        .update(s.metaConnections)
        .set({
          tokenCiphertext: sealed.ciphertext,
          tokenNonce: sealed.nonce,
          tokenKeyVersion: sealed.keyVersion,
        })
        .where(eq(s.metaConnections.id, a.connection.id));
      const [action] = await tx
        .insert(s.actions)
        .values({
          tenantId: a.tenantId,
          adAccountId: a.account.id,
          entityLevel: 'campaign',
          entityMetaId: a.campaign.metaId,
          operation: 'pause',
          desired: 'PAUSED',
          reason: 'SIMULACRO SINTÉTICO',
          idempotencyKey: randomUUID(),
          requestHash: 'drill',
          proposedBy: a.owner.id,
          state: 'approved',
        })
        .returning();
      assert(action);
      await tx.insert(s.jobs).values({
        tenantId: a.tenantId,
        kind: 'action_execute',
        payload: { actionId: action.id },
        dedupeKey: `drill:${id}`,
      });
    });
    const oldLease = await claimJob(source.db, a.tenantId);
    assert(oldLease);
    await source.db
      .update(s.jobs)
      .set({ lockedUntil: new Date(0) })
      .where(eq(s.jobs.id, oldLease.id));
    const newLease = await claimJob(source.db, a.tenantId);
    assert(newLease);
    assert.notEqual(oldLease.leaseId, newLease.leaseId);
    await assert.rejects(
      source.db.update(s.jobs).set({ status: 'succeeded' }).where(eq(s.jobs.id, newLease.id)),
      (e) => (e as { cause?: { code?: string } }).cause?.code === '55000',
    );
    await finishJob(source.db, oldLease, { type: 'done' });
    assert.equal(
      (await source.db.select().from(s.jobs).where(eq(s.jobs.id, newLease.id)))[0]?.leaseId,
      newLease.leaseId,
    );
    await finishJob(source.db, newLease, {
      type: 'reschedule',
      runAfter: new Date(),
      reason: 'Simulacro de fencing',
    });
    const key = randomBytes(32).toString('base64'),
      backup = await backupDatabase({
        url: url(names[0]),
        environment: 'test',
        directory: join(evidenceDir, 'backups'),
        key,
      });
    const encrypted = await readFile(backup.path);
    assert(!encrypted.includes(Buffer.from(canary)));
    encrypted[encrypted.length - 18] = (encrypted[encrypted.length - 18] ?? 0) ^ 1;
    const corrupt = join(evidenceDir, `corrupt-${id}.aab`);
    await writeFile(corrupt, encrypted, { mode: 0o600 });
    await assert.rejects(
      restoreDatabase({ url: url(names[2]), archive: corrupt, key, environment: 'test' }),
    );
    const check = new pg.Client({ connectionString: url(names[2]) });
    await check.connect();
    const untouched = await check.query(
      "select count(*)::int as n from pg_tables where schemaname='public'",
    );
    assert.equal(untouched.rows[0].n, 0);
    await check.end();
    const recovery = await restoreDatabase({
      url: url(names[1]),
      archive: backup.path,
      key,
      environment: 'test',
    });
    const restored = createDb(url(names[1], 'app_rw'));
    pools.push(restored.pool);
    const [state] = await restored.db.select().from(s.deploymentState);
    assert.equal(state?.recoveryMode, true);
    assert.equal(state?.restoreDrillAt, null); // Restaurar no acredita por sí solo un simulacro completo.
    await withContext(restored.db, { tenantId: a.tenantId }, async (tx) => {
      const clients = await tx.select().from(s.clients);
      assert.equal(clients.length, 1);
      assert.equal(clients[0]?.id, a.client.id);
      const foreign = await tx.select().from(s.clients).where(eq(s.clients.id, b.client.id));
      assert.equal(foreign.length, 0);
      const [connection] = await tx
        .select()
        .from(s.metaConnections)
        .where(eq(s.metaConnections.id, a.connection.id));
      assert(connection);
      assert.equal(
        cipher.open(
          {
            ciphertext: connection.tokenCiphertext,
            nonce: connection.tokenNonce,
            keyVersion: connection.tokenKeyVersion,
          },
          tokenAad(a.tenantId, a.connection.id),
        ),
        canary,
      );
      const [action] = await tx.select().from(s.actions);
      assert.equal(action?.state, 'failed');
      assert.equal(action?.result, 'unknown');
      assert(action?.dispatchAt);
      const events = await tx.select().from(s.actionEvents);
      assert(events.some((e) => e.event === 'restore_quarantined'));
    });
    const jobs = await restored.db.select().from(s.jobs);
    assert(jobs.every((j) => j.status === 'failed' && j.recurringEverySeconds === null));
    await enqueue(restored.db, { tenantId: a.tenantId, kind: 'noop', dedupeKey: `restored:${id}` });
    assert.equal(await claimJob(restored.db, a.tenantId), null);
    const evidence = {
      at: new Date().toISOString(),
      synthetic: true,
      tenants: 2,
      runtimeRlsVerified: true,
      encryptedCredentialRoundtrip: true,
      tamperRejectedBeforeSql: true,
      quarantineVerified: true,
      workerFencingVerified: true,
      recoveryClaimBlocked: true,
      recovery,
      encryptedBytes: backup.bytes,
      durationMs: Math.round(performance.now() - start),
      productionRpoVerified: false,
      productionRtoVerified: false,
    };
    await writeFile(join(evidenceDir, 'recovery.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    for (const name of names) {
      assert.match(name, /^ad_astra_drill_[a-f0-9]{10}_(source|restore|corrupt)$/);
      await admin.query(`drop database if exists ${name} with (force)`);
    }
    await admin.end();
  }
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await recoveryDrill(), null, 2));
  } catch {
    console.error(
      'El simulacro falló; no certifica recuperación. Revisa prerrequisitos del laboratorio.',
    );
    process.exitCode = 1;
  }
}

import { createServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { reserveBudget } from '../src/modules/ai/budget.ts';
import { LlmError, type LlmProvider } from '../src/modules/ai/provider.ts';
import { claimJob, enqueue, finishJob } from '../src/platform/jobs.ts';
import { createNodeHandler } from '../src/platform/node-handler.ts';
import { assertDeployment, evaluateTechnical } from '../src/platform/operations.ts';
import { config, testApp } from './app.ts';
import { testEnv } from './env.ts';
import { scripted } from './scripted-llm.ts';
import { addMember, pgError, seedTenant, testDb } from './seed.ts';

const db = testDb();
it('una conexión inválida abre una alerta técnica crítica sin depender de email y sin duplicar transiciones', async () => {
  const a = await seedTenant(db);
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx
      .update(s.metaConnections)
      .set({ status: 'invalid' })
      .where(eq(s.metaConnections.id, a.connection.id)),
  );
  await evaluateTechnical(db, a.tenantId);
  await evaluateTechnical(db, a.tenantId);
  const rows = await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.select().from(s.technicalIncidents),
  );
  expect(rows.find((r) => r.code === 'meta_connection_invalid')).toMatchObject({
    status: 'open',
    severity: 'critical',
  });
  const events = await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.select().from(s.auditLog),
  );
  expect(
    events.filter(
      (e) => e.action === 'operations.alert' && e.targetId === 'meta_connection_invalid',
    ),
  ).toHaveLength(1);
});
it('la caché de lectura vuelve a resolver el alcance y no conserva datos tras revocar una asignación', async () => {
  const a = await seedTenant(db),
    analyst = await addMember(db, a.tenantId, 'analyst', [a.client.id]),
    t = await testApp({ config: { ANALYTICS_CACHE_MS: 15000 } }),
    as = t.as(analyst, a.tenantId),
    path = '/v1/analytics?level=org&since=2026-10-01&until=2026-10-01&compare=none';
  const first = await as.get(path);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.body).toContain(a.client.name);
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.delete(s.clientAssignments).where(eq(s.clientAssignments.userId, analyst.id)),
  );
  const revoked = await as.get(path);
  expect(revoked.statusCode, revoked.body).toBe(200);
  expect(revoked.body).not.toContain(a.client.name);
  expect(revoked.json().children.rows).toEqual([]);
  await t.app.close();
});
it('la previsión bloqueada no genera escenarios aunque la petición tenga permiso de lectura', async () => {
  const a = await seedTenant(db),
    t = await testApp({ config: { FORECASTING_ENABLED: false } });
  const result = await t
    .as(a.owner, a.tenantId)
    .post('/v1/forecasts', { level: 'campaign', id: a.campaign.metaId, horizonDays: 28, seed: 42 });
  expect(result.statusCode).toBe(503);
  await t.app.close();
});
it('un worker vencido no confirma ni reprograma el lease de otro', async () => {
  const a = await seedTenant(db);
  await enqueue(db, { tenantId: a.tenantId, kind: 'guard', dedupeKey: `guard:${a.tenantId}` });
  const first = await claimJob(db, a.tenantId);
  expect(first).not.toBeNull();
  await db
    .update(s.jobs)
    .set({ lockedUntil: new Date(0) })
    .where(eq(s.jobs.id, first!.id));
  const second = await claimJob(db, a.tenantId);
  expect(second?.leaseId).not.toBe(first?.leaseId);
  await finishJob(db, first!, { type: 'done' });
  expect((await db.select().from(s.jobs).where(eq(s.jobs.id, first!.id)))[0]).toMatchObject({
    status: 'running',
    leaseId: second?.leaseId,
  });
  await finishJob(db, second!, { type: 'done' });
  expect((await db.select().from(s.jobs).where(eq(s.jobs.id, first!.id)))[0]?.status).toBe(
    'succeeded',
  );
});
it('reserva el presupuesto de manera atómica entre peticiones y conserva importes ambiguos', async () => {
  const a = await seedTenant(db),
    ctx = { tenantId: a.tenantId, userId: a.owner.id, role: 'owner' as const };
  const holds = await Promise.all([
    reserveBudget(db, ctx, { ...config, AI_MONTHLY_BUDGET_USD: 1 }, 0.6),
    reserveBudget(db, ctx, { ...config, AI_MONTHLY_BUDGET_USD: 1 }, 0.6),
  ]);
  expect(holds.filter(Boolean)).toHaveLength(1);
  const b = await seedTenant(db);
  const provider: LlmProvider = {
      id: 'anthropic',
      model: 'claude-opus-5-5',
      generate: async () => {
        throw new LlmError('unavailable', 'timeout');
      },
    },
    t = await testApp({ llm: provider });
  expect(
    (
      await t
        .as(b.owner, b.tenantId)
        .post('/v1/ai/ask', { question: 'Pregunta sintética de prueba' })
    ).statusCode,
  ).toBe(200);
  const unknown = await withContext(db, { tenantId: b.tenantId }, (tx) =>
    tx.select().from(s.llmBudgetHolds),
  );
  expect(unknown[0]?.status).toBe('unknown');
  expect(Number(unknown[0]?.amountUsd)).toBeGreaterThan(0);
  await t.app.close();
});
it('revocar el alcance impide leer trazas o reenviar una conversación al proveedor', async () => {
  const a = await seedTenant(db),
    analyst = await addMember(db, a.tenantId, 'analyst', [a.client.id]),
    play = scripted([() => ({ refusal: true })]),
    t = await testApp({ llm: play.provider }),
    as = t.as(analyst, a.tenantId);
  const answer = await as.post('/v1/ai/ask', { question: 'Pregunta sintética' });
  expect(answer.statusCode, answer.body).toBe(200);
  const conversation = answer.json();
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.delete(s.clientAssignments).where(eq(s.clientAssignments.userId, analyst.id)),
  );
  expect((await as.get(`/v1/ai/conversations/${conversation.conversationId}`)).statusCode).toBe(
    404,
  );
  expect((await as.get(`/v1/ai/messages/${conversation.message.id}/trace`)).statusCode).toBe(404);
  expect(
    (
      await as.post('/v1/ai/ask', {
        conversationId: conversation.conversationId,
        question: 'Repite los datos previos',
      })
    ).statusCode,
  ).toBe(404);
  expect(play.requests).toHaveLength(1);
  await t.app.close();
});
it('rechaza base de otro entorno y rol propietario; el runtime no puede desactivar la cuarentena', async () => {
  await expect(assertDeployment(db, { ...config, APP_ENV: 'staging' })).rejects.toMatchObject({
    status: 503,
  });
  const owner = createDb(testEnv.DATABASE_URL_OWNER);
  try {
    await expect(assertDeployment(owner.db, config)).rejects.toMatchObject({ status: 503 });
  } finally {
    await owner.pool.end();
  }
  expect(await pgError(db.update(s.deploymentState).set({ recoveryMode: false }))).toMatchObject({
    code: '42501',
  });
  expect(await pgError(db.update(s.deploymentState).set({ readOnlyMode: false }))).toMatchObject({
    code: '42501',
  });
});
it('el adaptador serverless conserva ruta, respuesta y cookies de Fastify', async () => {
  const t = await testApp({ realAuth: true }),
    server = createServer(createNodeHandler(async () => t.app));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Sin puerto');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
    await t.app.close();
  }
});

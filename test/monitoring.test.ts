import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { addDays, localDate } from '../src/modules/insights/catalog.ts';
import { buildPlan, type FollowupPlan } from '../src/modules/monitoring/model.ts';
import {
  captureBeforeAction,
  createMonitoringService,
  evaluateAccount,
} from '../src/modules/monitoring/service.ts';
import { createMonitoringHandlers } from '../src/modules/monitoring/worker.ts';
import { defaultMonitorPolicy } from '../src/monitoring-contracts.ts';
import type { Job } from '../src/platform/jobs.ts';
import { config, testApp } from './app.ts';
import { addMember, pgError, seedTenant, testDb } from './seed.ts';

const db = testDb(),
  reason = 'Autorización explícita de reglas y destinatarios';
async function setup() {
  const a = await seedTenant(db),
    t = await testApp(),
    ctx = { tenantId: a.tenantId, userId: a.owner.id, role: 'owner' as const },
    api = t.as(a.owner, a.tenantId),
    service = createMonitoringService(db),
    p = defaultMonitorPolicy();
  p.enabled = true;
  p.openAfter = 1;
  p.rules = p.rules.filter((r) => r.kind === 'connection');
  p.notifications = { ...p.notifications, quietStart: 0, quietEnd: 0, recipientIds: [a.owner.id] };
  await withContext(db, { tenantId: a.tenantId }, (tx) =>
    tx.insert(s.clientConsents).values({
      tenantId: a.tenantId,
      clientId: a.client.id,
      scope: ['read_insights'],
      grantedByName: 'Cliente sintético',
      grantedByEmail: 'cliente@agencia.test',
      grantedAt: new Date('2026-01-01'),
      recordedBy: a.owner.id,
    }),
  );
  const save = async (revision = 0) => {
    const r = await api.put(`/v1/monitoring/${a.account.id}/policy`, {
      revision,
      reason,
      policy: p,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r;
  };
  const evaluate = () => evaluateAccount(db, a.tenantId, a.account.id);
  const deliveries = () => withContext(db, ctx, (tx) => tx.select().from(s.monitoringDeliveries));
  return { a, t, ctx, api, service, p, save, evaluate, deliveries };
}
const job = (tenantId: string, id: string): Job => ({
  id: 1,
  tenantId,
  kind: 'monitor_notify',
  payload: { deliveryId: id },
  dedupeKey: id,
  status: 'running',
  runAfter: new Date(),
  lockedUntil: null,
  leaseId: null,
  attempts: 1,
  maxAttempts: 6,
  lastError: null,
  recurringEverySeconds: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
describe('monitoreo: API, persistencia, canales y bitácora', () => {
  it('corrige datos de una observación sin duplicar rachas y no resuelve una ventana desconocida', async () => {
    const x = await setup(),
      now = new Date();
    x.p.rules = defaultMonitorPolicy().rules.filter((r) => r.kind === 'spend_without_results');
    x.p.windowDays = 1;
    x.p.openAfter = 2;
    x.p.resolveAfter = 1;
    await x.save();
    const asOf = addDays(localDate(x.a.account.timezoneName, now), -1 - x.p.maturityDays);
    await withContext(db, x.ctx, async (tx) => {
      const run = await tx
        .insert(s.syncRuns)
        .values({
          tenantId: x.a.tenantId,
          adAccountId: x.a.account.id,
          kind: 'insights_incremental',
          apiVersion: 'v26.0',
        })
        .returning();
      await tx.insert(s.insightsDaily).values({
        tenantId: x.a.tenantId,
        adAccountId: x.a.account.id,
        level: 'campaign',
        entityMetaId: x.a.campaign.metaId,
        date: asOf,
        currency: 'EUR',
        spend: '200',
        results: '0',
        resultIndicator: 'lead',
        attributionSetting: '7d_click',
        extractionVersion: 1,
        syncRunId: run[0]!.id,
        fetchedAt: now,
      });
    });
    await x.evaluate();
    let i = (await x.service.overview(x.ctx, x.a.account.id)).incidents[0]!;
    expect(i.hitCount).toBe(1);
    await withContext(db, x.ctx, (tx) =>
      tx
        .update(s.insightsDaily)
        .set({ spend: '300' })
        .where(eq(s.insightsDaily.entityMetaId, x.a.campaign.metaId)),
    );
    await x.evaluate();
    i = (await x.service.overview(x.ctx, x.a.account.id)).incidents[0]!;
    expect(i.hitCount).toBe(1);
    await withContext(db, x.ctx, (tx) =>
      tx
        .update(s.insightsDaily)
        .set({ results: null })
        .where(eq(s.insightsDaily.entityMetaId, x.a.campaign.metaId)),
    );
    await x.evaluate();
    i = (await x.service.overview(x.ctx, x.a.account.id)).incidents[0]!;
    expect(i.status).toBe('pending');
    expect(i.clearCount).toBe(0);
    expect(i.severity).toBe('high');
    await x.t.app.close();
  });
  it('genera un solo informe programado por período y cambia de trabajo al reautorizar', async () => {
    const x = await setup();
    x.p.reportEveryDays = 7;
    await x.save();
    await x.evaluate();
    await x.evaluate();
    expect((await x.service.overview(x.ctx, x.a.account.id)).reports).toHaveLength(1);
    x.p.enabled = false;
    await x.save(1);
    x.p.enabled = true;
    await x.save(2);
    const jobs = await db.select().from(s.jobs).where(eq(s.jobs.tenantId, x.a.tenantId));
    const recurring = jobs.filter((j) => j.kind === 'monitor_evaluate' && j.status === 'queued');
    expect(recurring).toHaveLength(1);
    expect(recurring[0]?.dedupeKey).toContain(':3');
    await x.t.app.close();
  });
  it('deduplica evaluaciones concurrentes, agrupa y entrega una sola notificación en aplicación', async () => {
    const x = await setup();
    await x.save();
    await Promise.all([x.evaluate(), x.evaluate()]);
    const view = await x.service.overview(x.ctx, x.a.account.id);
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]).toMatchObject({ status: 'open', hitCount: 1, severity: 'critical' });
    expect(view.runs).toHaveLength(1);
    const d = await x.deliveries();
    expect(d).toHaveLength(1);
    let sent = 0;
    const handlers = createMonitoringHandlers(db, config, async () => {
      sent++;
      return 'provider';
    });
    const handler = handlers.monitor_notify!;
    await Promise.all([handler(job(x.a.tenantId, d[0]!.id)), handler(job(x.a.tenantId, d[0]!.id))]);
    expect(sent).toBe(0);
    expect((await x.deliveries())[0]?.status).toBe('sent');
    expect(
      (await x.service.events(x.ctx, x.a.account.id)).some((e) => e.event === 'notification_sent'),
    ).toBe(true);
    await x.t.app.close();
  });
  it('no cuenta reintentos para abrir/resolver; no resuelve con conexión desconocida por falta de sync', async () => {
    const x = await setup();
    x.p.openAfter = 2;
    x.p.resolveAfter = 2;
    await x.save();
    const now = new Date(),
      later = new Date(now.getTime() + 16 * 60000);
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, now);
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, now);
    let v = await x.service.overview(x.ctx, x.a.account.id);
    expect(v.incidents[0]?.status).toBe('pending');
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, later);
    v = await x.service.overview(x.ctx, x.a.account.id);
    expect(v.incidents[0]?.status).toBe('open');
    await withContext(db, x.ctx, (tx) =>
      tx
        .update(s.metaConnections)
        .set({ status: 'active' })
        .where(eq(s.metaConnections.id, x.a.connection.id)),
    );
    const clean = new Date(later.getTime() + 16 * 60000);
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, clean);
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, clean);
    v = await x.service.overview(x.ctx, x.a.account.id);
    expect(v.incidents[0]?.clearCount).toBe(1);
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, new Date(clean.getTime() + 16 * 60000));
    v = await x.service.overview(x.ctx, x.a.account.id);
    expect(v.incidents[0]?.status).toBe('resolved');
    await x.t.app.close();
  });
  it('exige alcance, autorización, versión y motivos; respeta descarte y silencio', async () => {
    const x = await setup(),
      other = await seedTenant(db),
      viewer = await addMember(db, x.a.tenantId, 'viewer', [x.a.client.id]),
      outsider = await addMember(db, x.a.tenantId, 'manager');
    expect(
      (await x.t.as(outsider, x.a.tenantId).get(`/v1/monitoring/${x.a.account.id}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await x.t
          .as(viewer, x.a.tenantId)
          .put(`/v1/monitoring/${x.a.account.id}/policy`, { revision: 0, reason, policy: x.p })
      ).statusCode,
    ).toBe(403);
    expect((await x.api.get(`/v1/monitoring/${other.account.id}`)).statusCode).toBe(404);
    x.p.notifications.recipientIds = [outsider.id];
    expect(
      (
        await x.api.put(`/v1/monitoring/${x.a.account.id}/policy`, {
          revision: 0,
          reason,
          policy: x.p,
        })
      ).statusCode,
    ).toBe(400);
    x.p.notifications.recipientIds = [x.a.owner.id];
    await x.save();
    expect(
      (
        await x.api.put(`/v1/monitoring/${x.a.account.id}/policy`, {
          revision: 0,
          reason,
          policy: x.p,
        })
      ).statusCode,
    ).toBe(409);
    await x.evaluate();
    let i = (await x.service.overview(x.ctx, x.a.account.id)).incidents[0]!;
    expect(
      (
        await x.api.post(`/v1/monitoring/incidents/${i.id}/decide`, {
          status: 'dismissed',
          revision: i.revision,
          reason: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await x.api.post(`/v1/monitoring/incidents/${i.id}/decide`, {
          status: 'dismissed',
          revision: i.revision,
          reason,
        })
      ).statusCode,
    ).toBe(200);
    await evaluateAccount(db, x.a.tenantId, x.a.account.id, new Date(Date.now() + 1800000));
    i = (await x.service.overview(x.ctx, x.a.account.id)).incidents[0]!;
    expect(i.status).toBe('dismissed');
    await x.t.app.close();
  });
  it('cancela correo al revocar acceso y no repite un envío ambiguo', async () => {
    const x = await setup(),
      recipient = await addMember(db, x.a.tenantId, 'analyst', [x.a.client.id]);
    x.p.notifications = {
      ...x.p.notifications,
      email: true,
      inApp: false,
      recipientIds: [recipient.id],
    };
    await x.save();
    await x.evaluate();
    const d = (await x.deliveries())[0]!;
    let calls = 0;
    const c = {
        ...config,
        NOTIFICATIONS_EMAIL_ENABLED: true,
        RESEND_API_KEY: 'synthetic-resend-key-not-real',
        NOTIFICATIONS_FROM: 'notificaciones@agencia.test',
      },
      handler = createMonitoringHandlers(db, c, async () => {
        calls++;
        throw new Error('timeout after accepted');
      }).monitor_notify!;
    await handler(job(x.a.tenantId, d.id));
    await handler(job(x.a.tenantId, d.id));
    expect(calls).toBe(1);
    expect((await x.deliveries())[0]?.status).toBe('unknown');
    await withContext(db, x.ctx, (tx) =>
      tx.delete(s.clientAssignments).where(eq(s.clientAssignments.userId, recipient.id)),
    );
    await withContext(db, x.ctx, (tx) =>
      tx.insert(s.monitoringDeliveries).values({
        id: randomUUID(),
        tenantId: x.a.tenantId,
        adAccountId: x.a.account.id,
        userId: recipient.id,
        channel: 'email',
        policyRevision: 1,
        digestKey: 'revoked',
        incidentIds: d.incidentIds,
      }),
    );
    const next = (await x.deliveries()).find((v) => v.digestKey === 'revoked')!;
    await handler(job(x.a.tenantId, next.id));
    expect(calls).toBe(1);
    expect((await x.deliveries()).find((v) => v.id === next.id)?.status).toBe('cancelled');
    await x.t.app.close();
  });
  it('separa horarios silenciosos, cupos y desactivación global del correo', async () => {
    const x = await setup();
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: x.a.account.timezoneName,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
    );
    x.p.notifications.quietStart = hour;
    x.p.notifications.quietEnd = (hour + 1) % 24;
    await x.save();
    await x.evaluate();
    expect(await x.deliveries()).toHaveLength(0);
    x.p.notifications.quietStart = 0;
    x.p.notifications.quietEnd = 0;
    x.p.notifications.email = true;
    x.p.notifications.maxPerDay = 1;
    await x.save(1);
    await x.evaluate();
    const d = await x.deliveries();
    expect(d).toHaveLength(2);
    let calls = 0;
    await createMonitoringHandlers(db, config, async () => {
      calls++;
      return 'blocked';
    }).monitor_notify!(job(x.a.tenantId, d.find((v) => v.channel === 'email')!.id));
    expect(calls).toBe(0);
    const sent = (await x.deliveries()).find((v) => v.channel === 'email');
    expect(sent?.status).toBe('cancelled');
    await x.evaluate();
    expect((await x.deliveries()).filter((v) => v.channel === 'in_app')).toHaveLength(1);
    await x.t.app.close();
  });
  it('conserva planes e informes inmutables, genera ambos niveles y no fabrica CRM', async () => {
    const x = await setup();
    await x.save();
    await x.evaluate();
    const a = await withContext(db, x.ctx, (tx) =>
      tx
        .insert(s.actions)
        .values({
          tenantId: x.a.tenantId,
          adAccountId: x.a.account.id,
          recommendationId: x.a.recommendation.id,
          entityLevel: 'campaign',
          entityMetaId: x.a.campaign.metaId,
          operation: 'pause',
          desired: 'PAUSED',
          reason,
          idempotencyKey: randomUUID(),
          requestHash: 'test-monitor',
          proposedBy: x.a.owner.id,
        })
        .returning(),
    );
    await withContext(db, x.ctx, (tx) => captureBeforeAction(tx, a[0]!, x.a.account));
    const f = await withContext(db, x.ctx, (tx) => tx.select().from(s.actionFollowups));
    expect((f[0]?.plan as FollowupPlan | undefined)?.retrospective).toBe(false);
    expect(
      await pgError(
        withContext(db, x.ctx, (tx) =>
          tx
            .update(s.actionFollowups)
            .set({
              plan: buildPlan(
                { id: a[0]!.id, entityLevel: 'campaign', entityMetaId: 'fake', dispatchAt: null },
                [],
                x.p,
                new Date(),
                '2026-10-01',
              ),
            })
            .where(eq(s.actionFollowups.actionId, a[0]!.id)),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    const response = await x.api.post(`/v1/monitoring/${x.a.account.id}/reports`, { days: 28 });
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json();
    expect(report.snapshot.executive.nextSteps.length).toBeGreaterThan(0);
    expect(report.snapshot.technical.crm).toMatchObject({
      status: 'unavailable',
      leadQuality: null,
      confirmedCalls: null,
    });
    expect(report.snapshot.limitations.join(' ')).toMatch(/no causal/);
    expect((await x.api.get(`/v1/monitoring/reports/${report.id}`)).statusCode).toBe(200);
    for (const table of [s.monitoringReports, s.monitoringRuns, s.monitoringEvents])
      expect(await pgError(withContext(db, x.ctx, (tx) => tx.delete(table)))).toMatchObject({
        code: '42501',
      });
    expect(
      await pgError(withContext(db, x.ctx, (tx) => tx.delete(s.actionFollowups))),
    ).toMatchObject({ code: '42501' });
    await x.t.app.close();
  });
});

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ActionPolicy, type BudgetAction, type Policy } from '../src/action-contracts.ts';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { tokenAad } from '../src/modules/meta/sync.ts';
import { createActionGateway } from '../src/modules/optimization/meta.ts';
import { createActionHandler } from '../src/modules/optimization/worker.ts';
import { createTokenCipher } from '../src/platform/crypto.ts';
import { runTick } from '../src/platform/jobs.ts';
import { createLogger } from '../src/platform/logging.ts';
import { config, testApp } from './app.ts';
import { fakeActionMeta } from './fake-actions.ts';
import { addMember, pgError, seedTenant, testDb } from './seed.ts';

const db = testDb(),
  reason = 'Revisión humana de la operación propuesta';
async function setup(
  operation: 'pause' | 'activate' | 'set_daily_budget' | 'set_lifetime_budget' = 'pause',
  enabled = true,
) {
  const a = await seedTenant(db),
    admin = await addMember(db, a.tenantId, 'admin'),
    admin2 = await addMember(db, a.tenantId, 'admin');
  const c = {
    ...config,
    META_APP_ID: '98765',
    META_APP_SECRET: 'action-test-app-secret',
    META_WRITES_ENABLED: enabled,
  };
  const cipher = createTokenCipher(c.TOKEN_ENCRYPTION_KEYS, c.TOKEN_ENCRYPTION_KEY_VERSION);
  const token = `EAActionTestCanary${randomUUID().replaceAll('-', '')}SecretCanary`;
  const sealed = cipher.seal(token, tokenAad(a.tenantId, a.connection.id));
  await withContext(db, { tenantId: a.tenantId }, async (tx) => {
    await tx
      .update(s.metaConnections)
      .set({
        tokenCiphertext: sealed.ciphertext,
        tokenNonce: sealed.nonce,
        tokenKeyVersion: sealed.keyVersion,
        metaAppId: c.META_APP_ID,
        status: 'active',
      })
      .where(eq(s.metaConnections.id, a.connection.id));
    await tx
      .update(s.recommendations)
      .set({ status: 'accepted', actionType: operation })
      .where(eq(s.recommendations.id, a.recommendation.id));
    await tx.insert(s.clientConsents).values({
      tenantId: a.tenantId,
      clientId: a.client.id,
      scope: ['write_status', 'write_budget', 'read_insights'],
      grantedByName: 'Cliente sintético',
      grantedByEmail: 'consent@agencia.test',
      grantedAt: new Date(),
      recordedBy: a.owner.id,
    });
  });
  const meta = fakeActionMeta({
    appId: c.META_APP_ID,
    appSecret: c.META_APP_SECRET,
    token,
    accountId: a.account.metaAccountId,
    entityId: a.campaign.metaId,
  });
  if (operation === 'activate') {
    const e = meta.state.objects.get(a.campaign.metaId)!;
    e.status = 'PAUSED';
    e.effective_status = 'PAUSED';
  }
  if (operation === 'set_lifetime_budget') {
    const e = meta.state.objects.get(a.campaign.metaId)!;
    e.daily_budget = '0';
    e.lifetime_budget = '10000';
  }
  const gateway = createActionGateway({ db, config: c, cipher, fetch: meta.fetch });
  const t = await testApp({ config: c, actionGateway: gateway });
  const policy = ActionPolicy.parse({
    enabled: true,
    allowedOperations: ['pause', 'activate', 'set_daily_budget', 'set_lifetime_budget'],
    maxBudgetMinor: '100000',
    maxDailyIncreaseMinor: '20000',
    maxChangePct: 25,
    maxCumulativeChangePct: 40,
  });
  const setPolicy = (p: Policy) =>
    t.as(a.owner, a.tenantId).put(`/v1/action-policies/${a.account.id}`, { policy: p, reason });
  expect((await setPolicy(policy)).statusCode).toBe(200);
  const propose = async (key = randomUUID(), budgetMinor?: string) =>
    t.as(a.owner, a.tenantId).post('/v1/actions', {
      recommendationId: a.recommendation.id,
      idempotencyKey: key,
      reason,
      ...(budgetMinor ? { budgetMinor } : {}),
    });
  const preview = async (action: BudgetAction) =>
    t
      .as(a.owner, a.tenantId)
      .post(`/v1/actions/${action.id}/preview`, { revision: action.revision });
  const approve = async (action: BudgetAction, user = admin) =>
    t.as(user, a.tenantId).post(`/v1/actions/${action.id}/approve`, {
      revision: action.revision,
      previewHash: action.preview?.hash,
      authorize: true,
      reason,
    });
  const get = async (id: string) =>
    (await t.as(a.owner, a.tenantId).get(`/v1/actions/${id}`)).json<BudgetAction>();
  const handler = createActionHandler({ db, config: c, gateway });
  const tick = () =>
    runTick({
      db,
      handlers: { action_execute: handler },
      budgetMs: 2000,
      concurrency: 2,
      tenantId: a.tenantId,
      log: createLogger(undefined, 'silent'),
    });
  const due = () =>
    db
      .update(s.jobs)
      .set({ runAfter: new Date(0) })
      .where(eq(s.jobs.tenantId, a.tenantId));
  const ready = async (budgetMinor?: string) => {
    const r = await propose(undefined, budgetMinor);
    expect(r.statusCode, r.body).toBe(200);
    const p = await preview(r.json<BudgetAction>());
    expect(p.statusCode, p.body).toBe(200);
    return p.json<BudgetAction>();
  };
  return {
    a,
    t,
    meta,
    policy,
    setPolicy,
    propose,
    preview,
    approve,
    get,
    handler,
    tick,
    due,
    ready,
    admin,
    admin2,
    token,
  };
}

describe('Action Center: contratos, aprobación y ejecución real contra Graph simulado', () => {
  it('recorre propuesta → revisión → aprobación → ejecución → verificación → cierre con bitácora inmutable', async () => {
    const x = await setup(),
      p = await x.ready();
    expect(p.state).toBe('review');
    expect(p.preview).toMatchObject({
      field: 'status',
      before: 'ACTIVE',
      after: 'PAUSED',
      requiredApprovals: 1,
    });
    expect(x.meta.writes).toHaveLength(0);
    const denied = await x.approve(p, x.a.owner);
    expect(denied.statusCode).toBe(403);
    const approvedResponse = await x.approve(p);
    expect(approvedResponse.statusCode, approvedResponse.body + x.t.logs()).toBe(200);
    expect(approvedResponse.json<BudgetAction>().state).toBe('approved');
    await x.tick();
    const a = await x.get(p.id);
    expect(a).toMatchObject({
      state: 'closed',
      result: 'verified',
      confirmedWrite: true,
      after: { status: 'PAUSED' },
    });
    expect(x.meta.writes).toEqual([{ id: x.a.campaign.metaId, params: { status: 'PAUSED' } }]);
    const [followup] = await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx.select().from(s.actionFollowups).where(eq(s.actionFollowups.actionId, p.id)),
    );
    expect(followup?.plan).toMatchObject({ actionId: p.id, retrospective: false });
    await x.due();
    await x.tick();
    expect(x.meta.writes).toHaveLength(1);
    const events = (await x.t.as(x.a.owner, x.a.tenantId).get(`/v1/actions/${p.id}/events`)).json<
      Array<{ event: string }>
    >();
    expect(events.map((e) => e.event)).toEqual([
      'proposed',
      'reviewed',
      'approved',
      'dispatch',
      'write_acknowledged',
      'verified',
      'closed',
    ]);
    for (const table of [s.actionEvents, s.actionApprovals])
      expect(
        await pgError(withContext(db, { tenantId: x.a.tenantId }, (tx) => tx.delete(table))),
      ).toMatchObject({ code: '42501' });
    expect(JSON.stringify(events) + x.t.logs()).not.toContain(x.token);
  });
  it('exige aceptar la recomendación, authorize=true, revisión vigente e idempotencia de contenido', async () => {
    const x = await setup();
    await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx
        .update(s.recommendations)
        .set({ status: 'open' })
        .where(eq(s.recommendations.id, x.a.recommendation.id)),
    );
    expect((await x.propose()).statusCode).toBe(409);
    await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx
        .update(s.recommendations)
        .set({ status: 'accepted' })
        .where(eq(s.recommendations.id, x.a.recommendation.id)),
    );
    const key = randomUUID();
    const concurrent = await Promise.all([x.propose(key), x.propose(key)]);
    expect(concurrent.map((r) => r.statusCode)).toEqual([200, 200]);
    const first = concurrent[0]!.json<BudgetAction>();
    expect(concurrent[1]!.json<BudgetAction>().id).toBe(first.id);
    expect((await x.propose(key)).json<BudgetAction>().id).toBe(first.id);
    expect((await x.propose(key, '500')).statusCode).toBe(409);
    const p = (await x.preview(first)).json<BudgetAction>();
    expect(
      (
        await x.t.as(x.admin, x.a.tenantId).post(`/v1/actions/${p.id}/approve`, {
          revision: p.revision,
          previewHash: p.preview?.hash,
          reason,
        })
      ).statusCode,
    ).toBe(400);
    const changed = (await x.preview(p)).json<BudgetAction>();
    expect((await x.approve(p)).statusCode).toBe(409);
    expect(changed.preview?.hash).not.toBe(p.preview?.hash);
  });
  it('presupuestos necesitan dos aprobadores independientes y se aplican como importes absolutos', async () => {
    const x = await setup('set_daily_budget'),
      p = await x.ready('12000');
    expect(p.preview?.changePct).toBe(20);
    expect(p.preview?.requiredApprovals).toBe(2);
    const first = (await x.approve(p)).json<BudgetAction>();
    expect(first.state).toBe('review');
    const duplicate = (await x.approve(first)).json<BudgetAction>();
    expect(duplicate.approvals).toHaveLength(1);
    const approved = (await x.approve(duplicate, x.admin2)).json<BudgetAction>();
    expect(approved.state).toBe('approved');
    await x.tick();
    expect((await x.get(p.id)).result).toBe('verified');
    expect(x.meta.writes[0]?.params).toEqual({ daily_budget: '12000' });
  });
  it('ajusta presupuesto total sin convertir el modo presupuestario', async () => {
    const x = await setup('set_lifetime_budget'),
      p = await x.ready('11000');
    const first = (await x.approve(p)).json<BudgetAction>();
    await x.approve(first, x.admin2);
    await x.tick();
    expect((await x.get(p.id)).result).toBe('verified');
    expect(x.meta.writes[0]?.params).toEqual({ lifetime_budget: '11000' });
    expect(x.meta.state.objects.get(x.a.campaign.metaId)?.daily_budget).toBe('0');
  });
  it('ajusta presupuesto propio de un conjunto ABO leyendo también su campaña', async () => {
    const x = await setup('set_daily_budget');
    const [set] = await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx.select().from(s.adsets).where(eq(s.adsets.adAccountId, x.a.account.id)),
    );
    const parent = x.meta.state.objects.get(x.a.campaign.metaId)!;
    x.meta.state.objects.set(set!.metaId, {
      ...parent,
      id: set!.metaId,
      campaign_id: x.a.campaign.metaId,
      end_time: parent.stop_time,
    });
    parent.daily_budget = '0';
    await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx
        .update(s.recommendations)
        .set({ entityLevel: 'adset', entityMetaId: set!.metaId })
        .where(eq(s.recommendations.id, x.a.recommendation.id)),
    );
    const p = await x.ready('11000'),
      first = (await x.approve(p)).json<BudgetAction>();
    await x.approve(first, x.admin2);
    await x.tick();
    expect((await x.get(p.id)).result).toBe('verified');
    expect(x.meta.writes[0]).toEqual({ id: set!.metaId, params: { daily_budget: '11000' } });
  });
  it('pausa un anuncio sin modificar el estado de sus padres', async () => {
    const x = await setup(),
      adId = String(Math.floor(Math.random() * 1e12));
    const [set] = await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx.select().from(s.adsets).where(eq(s.adsets.adAccountId, x.a.account.id)),
    );
    await withContext(db, { tenantId: x.a.tenantId }, async (tx) => {
      await tx.insert(s.ads).values({
        tenantId: x.a.tenantId,
        metaId: adId,
        adAccountId: x.a.account.id,
        campaignMetaId: x.a.campaign.metaId,
        adsetMetaId: set!.metaId,
        name: 'Anuncio sintético',
        raw: {},
        lastSyncedAt: new Date(),
      });
      await tx
        .update(s.recommendations)
        .set({ entityLevel: 'ad', entityMetaId: adId })
        .where(eq(s.recommendations.id, x.a.recommendation.id));
    });
    const parent = x.meta.state.objects.get(x.a.campaign.metaId)!;
    x.meta.state.objects.set(set!.metaId, {
      ...parent,
      id: set!.metaId,
      campaign_id: x.a.campaign.metaId,
    });
    x.meta.state.objects.set(adId, {
      ...parent,
      id: adId,
      campaign_id: x.a.campaign.metaId,
      adset_id: set!.metaId,
    });
    const p = await x.ready();
    await x.approve(p);
    await x.tick();
    expect((await x.get(p.id)).result).toBe('verified');
    expect(x.meta.writes[0]).toEqual({ id: adId, params: { status: 'PAUSED' } });
    expect(parent.status).toBe('ACTIVE');
    expect(x.meta.state.objects.get(set!.metaId)?.status).toBe('ACTIVE');
  });
  it('el kill switch global, el de cuenta, la revocación y el drift impiden escribir', async () => {
    const global = await setup('pause', false),
      p = await global.ready();
    expect((await global.approve(p)).statusCode).toBe(409);
    for (const mode of ['kill', 'consent', 'role', 'drift', 'scope'] as const) {
      const x = await setup(),
        p = await x.ready();
      await x.approve(p);
      if (mode === 'kill') await x.setPolicy({ ...x.policy, enabled: false });
      if (mode === 'consent')
        await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
          tx
            .update(s.clientConsents)
            .set({ revokedAt: new Date() })
            .where(eq(s.clientConsents.clientId, x.a.client.id)),
        );
      if (mode === 'role')
        await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
          tx.delete(s.memberships).where(eq(s.memberships.userId, x.admin.id)),
        );
      if (mode === 'drift') x.meta.state.objects.get(x.a.campaign.metaId)!.daily_budget = '11000';
      if (mode === 'scope') x.meta.state.scopes = ['ads_read'];
      await x.tick();
      expect(x.meta.writes, mode).toHaveLength(0);
      expect((await x.get(p.id)).state, mode).toBe('failed');
    }
  });
  it('el timeout después de aplicar se reconcilia sin reenviar; sin aplicar exige intervención', async () => {
    for (const mode of ['timeout-applied', 'timeout-unapplied'] as const) {
      const x = await setup(),
        p = await x.ready();
      await x.approve(p);
      x.meta.state.mode = mode;
      await x.tick();
      for (let i = 0; i < 7; i++) {
        await x.due();
        await x.tick();
      }
      const a = await x.get(p.id);
      expect(x.meta.writes, mode).toHaveLength(1);
      expect(a.state).toBe(mode === 'timeout-applied' ? 'closed' : 'failed');
      expect(a.confirmedWrite).toBe(false);
      if (mode === 'timeout-unapplied') {
        expect(
          (await x.t.as(x.admin, x.a.tenantId).post(`/v1/actions/${a.id}/reconcile`, {}))
            .statusCode,
        ).toBe(200);
        await x.due();
        await x.tick();
        expect(x.meta.writes).toHaveLength(1);
      }
    }
  });
  it('613 reprograma un rechazo explícito y no duplica la escritura que sí se aplica', async () => {
    const x = await setup(),
      p = await x.ready();
    await x.approve(p);
    x.meta.state.mode = 'throttle';
    await x.tick();
    expect((await x.get(p.id)).state).toBe('approved');
    const [job] = await db
      .select()
      .from(s.jobs)
      .where(and(eq(s.jobs.tenantId, x.a.tenantId), eq(s.jobs.kind, 'action_execute')));
    expect(job?.attempts).toBe(0);
    await x.due();
    await x.tick();
    expect((await x.get(p.id)).result).toBe('verified');
    expect(x.meta.writes).toHaveLength(2); // 1 rechazado + 1 aceptado
  });
  it('dos workers en paralelo no envían dos POST y recuperan un marcador de envío persistido', async () => {
    const x = await setup(),
      p = await x.ready();
    await x.approve(p);
    await Promise.all([x.tick(), x.tick()]);
    expect(x.meta.writes).toHaveLength(1);
    const y = await setup(),
      q = await y.ready();
    await y.approve(q);
    await withContext(db, { tenantId: y.a.tenantId }, (tx) =>
      tx
        .update(s.actions)
        .set({ state: 'executing', dispatchAt: new Date() })
        .where(eq(s.actions.id, q.id)),
    );
    y.meta.state.objects.get(y.a.campaign.metaId)!.status = 'PAUSED';
    await y.tick();
    expect(y.meta.writes).toHaveLength(0);
    expect((await y.get(q.id)).result).toBe('verified');
  });
  it('un trabajo agotado tras el marcador no deja la acción sin salida: se reconcilia por lectura', async () => {
    const x = await setup(),
      p = await x.ready();
    await x.approve(p);
    await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx
        .update(s.actions)
        .set({ state: 'executing', dispatchAt: new Date() })
        .where(eq(s.actions.id, p.id)),
    );
    const reconcile = () => x.t.as(x.admin, x.a.tenantId).post(`/v1/actions/${p.id}/reconcile`, {});
    expect((await reconcile()).statusCode).toBe(409); // aún hay un trabajo que la relee
    await db.update(s.jobs).set({ status: 'failed' }).where(eq(s.jobs.tenantId, x.a.tenantId));
    x.meta.state.objects.get(x.a.campaign.metaId)!.status = 'PAUSED';
    expect((await reconcile()).statusCode).toBe(200);
    await x.tick();
    expect(x.meta.writes).toHaveLength(0);
    expect(await x.get(p.id)).toMatchObject({ state: 'closed', result: 'verified' });
  });
  it('rollback crea una nueva propuesta; requiere aprobación y bloquea deriva posterior', async () => {
    const x = await setup(),
      p = await x.ready();
    await x.approve(p);
    await x.tick();
    const key = randomUUID(),
      url = `/v1/actions/${p.id}/rollback`;
    x.meta.state.objects.get(x.a.campaign.metaId)!.daily_budget = '12000';
    expect(
      (await x.t.as(x.admin, x.a.tenantId).post(url, { idempotencyKey: key, reason })).statusCode,
    ).toBe(409);
    x.meta.state.objects.get(x.a.campaign.metaId)!.daily_budget = '10000';
    const inverse = (
      await x.t.as(x.admin, x.a.tenantId).post(url, { idempotencyKey: key, reason })
    ).json<BudgetAction>();
    expect(inverse).toMatchObject({ state: 'proposed', operation: 'activate', rollbackOf: p.id });
    expect(x.meta.writes).toHaveLength(1);
    // La política conserva el cooldown de la acción original: un rollback tampoco lo evita.
    expect((await x.preview(inverse)).statusCode).toBe(409);
    await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx
        .update(s.actions)
        .set({ reservedAt: new Date(Date.now() - 31000) })
        .where(eq(s.actions.id, p.id)),
    );
    const reviewed = (await x.preview(inverse)).json<BudgetAction>();
    expect(reviewed.state).toBe('review');
    const once = (await x.approve(reviewed, x.a.owner)).json<BudgetAction>();
    expect(once.state).toBe('review');
    expect((await x.approve(once, x.admin2)).statusCode).toBe(200);
    await x.tick();
    expect((await x.get(inverse.id)).result).toBe('verified');
    expect(x.meta.state.objects.get(x.a.campaign.metaId)?.status).toBe('ACTIVE');
    expect(x.meta.writes).toHaveLength(2);
  });
  it('caducidad y cambios de política invalidan aprobaciones; permite volver a revisar un bloqueo sin envío', async () => {
    const x = await setup(),
      p = await x.ready();
    await withContext(db, { tenantId: x.a.tenantId }, (tx) =>
      tx
        .update(s.actions)
        .set({ preview: { ...p.preview, expiresAt: new Date(0).toISOString() } })
        .where(eq(s.actions.id, p.id)),
    );
    expect((await x.approve(p)).statusCode).toBe(409);
    const refreshed = (await x.preview(await x.get(p.id))).json<BudgetAction>();
    await x.approve(refreshed);
    await x.setPolicy(x.policy); // mismo contenido, nueva autorización: no resucitar aprobaciones viejas
    await x.tick();
    expect(x.meta.writes).toHaveLength(0);
    const blocked = await x.get(p.id);
    expect(blocked.state).toBe('failed');
    const reviewed = (await x.preview(blocked)).json<BudgetAction>();
    expect(reviewed.approvals).toHaveLength(0);
    await x.approve(reviewed);
    await x.tick();
    expect((await x.get(p.id)).result).toBe('verified');
  });
  it('comprueba límites acumulados de aumento y los permisos del manager para presupuesto', async () => {
    const x = await setup('set_daily_budget');
    await x.setPolicy({ ...x.policy, maxDailyIncreaseMinor: '500' });
    const proposed = (await x.propose(undefined, '12000')).json<BudgetAction>();
    expect((await x.preview(proposed)).statusCode).toBe(409);
    await x.setPolicy(x.policy);
    const p = (await x.preview(await x.get(proposed.id))).json<BudgetAction>();
    const manager = await addMember(db, x.a.tenantId, 'manager', [x.a.client.id]);
    expect((await x.approve(p, manager)).statusCode).toBe(403);
    expect(x.meta.writes).toHaveLength(0);
  });
  it('aplica alcance de cliente, roles y aislamiento, incluidos eventos y políticas', async () => {
    const x = await setup(),
      p = await x.ready(),
      other = await seedTenant(db);
    const viewer = await addMember(db, x.a.tenantId, 'viewer', [x.a.client.id]);
    const analyst = await addMember(db, x.a.tenantId, 'analyst');
    for (const path of [
      `/v1/actions/${p.id}`,
      `/v1/actions/${p.id}/events`,
      `/v1/action-policies/${x.a.account.id}`,
    ])
      expect((await x.t.as(other.owner, other.tenantId).get(path)).statusCode).toBe(404);
    expect((await x.t.as(analyst, x.a.tenantId).get(`/v1/actions/${p.id}`)).statusCode).toBe(404);
    expect((await x.approve(p, viewer)).statusCode).toBe(403);
    expect((await x.t.as(viewer, x.a.tenantId).get(`/v1/actions/${p.id}`)).statusCode).toBe(200);
    expect(
      await pgError(
        withContext(db, { tenantId: other.tenantId }, (tx) =>
          tx.insert(s.actionApprovals).values({
            tenantId: other.tenantId,
            actionId: p.id,
            userId: other.owner.id,
            previewHash: 'x',
            reason,
          }),
        ),
      ),
    ).toMatchObject({ code: '23503' });
    expect(
      (
        await x.t
          .as(x.a.owner, x.a.tenantId)
          .post(`/v1/actions/${p.id}/close`, { revision: p.revision, reason })
      ).statusCode,
    ).toBe(200);
  });
});

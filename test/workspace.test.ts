import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { createMonitoringService } from '../src/modules/monitoring/service.ts';
import { defaultMonitorPolicy } from '../src/monitoring-contracts.ts';
import type { WorkspaceAccount, WorkspaceSearchResult } from '../src/workspace-contracts.ts';
import { testApp } from './app.ts';
import { addMember, seedTenant, testDb } from './seed.ts';

const db = testDb();
describe('espacio por cuenta y búsqueda con alcance', () => {
  it('agrega prioridades sin filtrar cuentas ni secretos de otros clientes o tenants', async () => {
    const a = await seedTenant(db),
      b = await seedTenant(db),
      t = await testApp();
    const viewer = await addMember(db, a.tenantId, 'viewer', [a.client.id]);
    const outsider = await addMember(db, a.tenantId, 'analyst', []);
    await withContext(db, { tenantId: a.tenantId }, async (tx) => {
      const [hidden] = await tx
        .insert(s.clients)
        .values({ tenantId: a.tenantId, name: 'Cliente sin asignación' })
        .returning();
      await tx.insert(s.adAccounts).values({
        tenantId: a.tenantId,
        clientId: hidden!.id,
        connectionId: a.connection.id,
        metaAccountId: `act_${Date.now()}`,
        name: 'Cuenta oculta',
        currency: 'USD',
        timezoneName: 'UTC',
        accountStatus: 1,
      });
      await tx.insert(s.monitoringIncidents).values({
        tenantId: a.tenantId,
        adAccountId: a.account.id,
        fingerprint: randomUUID(),
        entityLevel: 'campaign',
        entityMetaId: a.campaign.metaId,
        category: 'performance',
        severity: 'high',
        status: 'open',
        policyRevision: 1,
        lastObservation: '2026-10-20',
        evidence: [],
      });
      await tx.insert(s.monitoringPolicies).values({
        tenantId: a.tenantId,
        adAccountId: a.account.id,
        authorizedBy: a.owner.id,
        config: defaultMonitorPolicy(),
      });
      await tx.insert(s.clientConsents).values({
        tenantId: a.tenantId,
        clientId: a.client.id,
        scope: ['read_insights'],
        grantedByName: 'Sintético',
        grantedByEmail: 'synthetic@agencia.test',
        grantedAt: new Date('2026-01-01'),
        recordedBy: a.owner.id,
      });
    });
    const response = await t.as(viewer, a.tenantId).get('/v1/account-workspace');
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json<WorkspaceAccount[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: a.account.id,
      clientName: a.client.name,
      incidents: 1,
      criticalIncidents: 1,
      findings: 1,
      criticalFindings: 1,
      pendingActions: 0,
      failedActions: 0,
      health: null,
      readConsentActive: true,
      monitoringEnabled: false,
    });
    expect(response.body).not.toMatch(/tokenCiphertext|tokenFingerprint|tokenNonce|Cuenta oculta/);
    expect((await t.as(outsider, a.tenantId).get('/v1/account-workspace')).json()).toEqual([]);
    expect((await t.as(viewer, b.tenantId).get('/v1/account-workspace')).statusCode).toBe(403);
    expect((await t.as(null).get('/v1/account-workspace')).statusCode).toBe(401);
    await t.app.close();
  });

  it('busca clientes, cuentas y campañas, respeta asignaciones y escapa comodines', async () => {
    const a = await seedTenant(db),
      b = await seedTenant(db),
      t = await testApp();
    const viewer = await addMember(db, a.tenantId, 'viewer', [a.client.id]);
    const outsider = await addMember(db, a.tenantId, 'viewer', []);
    const marker = randomUUID().slice(0, 8);
    await withContext(db, { tenantId: a.tenantId }, async (tx) => {
      await tx
        .update(s.clients)
        .set({ name: `${marker} cliente` })
        .where(eq(s.clients.id, a.client.id));
      await tx
        .update(s.adAccounts)
        .set({ name: `${marker} cuenta %_` })
        .where(eq(s.adAccounts.id, a.account.id));
      await tx
        .update(s.campaigns)
        .set({ name: `${marker} campaña` })
        .where(eq(s.campaigns.metaId, a.campaign.metaId));
    });
    const api = t.as(viewer, a.tenantId);
    const response = await api.get(`/v1/workspace-search?q=${marker}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json<WorkspaceSearchResult[]>()
        .map((x) => x.kind)
        .sort(),
    ).toEqual(['account', 'campaign', 'client']);
    expect(response.body).not.toContain(b.account.name);
    expect(
      (await api.get('/v1/workspace-search?q=%25_')).json<WorkspaceSearchResult[]>(),
    ).toMatchObject([{ kind: 'account', id: a.account.id }]);
    expect(
      (await t.as(outsider, a.tenantId).get(`/v1/workspace-search?q=${marker}`)).json(),
    ).toEqual([]);
    expect((await api.get('/v1/workspace-search?q=x')).statusCode).toBe(400);
    expect((await api.get(`/v1/workspace-search?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
    await t.app.close();
  });

  it('muestra quién tomó una decisión y su motivo sin convertirla en recuperación', async () => {
    const a = await seedTenant(db),
      service = createMonitoringService(db);
    const ctx = { tenantId: a.tenantId, userId: a.owner.id, role: 'owner' as const };
    const [incident] = await withContext(db, ctx, (tx) =>
      tx
        .insert(s.monitoringIncidents)
        .values({
          tenantId: a.tenantId,
          adAccountId: a.account.id,
          fingerprint: randomUUID(),
          entityLevel: 'account',
          entityMetaId: a.account.metaAccountId,
          category: 'connection',
          severity: 'critical',
          status: 'open',
          policyRevision: 1,
          lastObservation: '2026-10-20',
          evidence: [],
        })
        .returning(),
    );
    await service.decide(ctx, incident!.id, {
      revision: 1,
      status: 'acknowledged',
      reason: 'Estoy revisando la conexión autorizada',
    });
    const result = await service.overview(ctx, a.account.id);
    expect(result.incidents[0]?.status).toBe('acknowledged');
    expect(result.decisions[0]).toMatchObject({
      incidentId: incident!.id,
      actorName: a.owner.name,
      data: { to: 'acknowledged', reason: 'Estoy revisando la conexión autorizada' },
    });
    expect((await service.events(ctx, a.account.id))[0]?.actorName).toBe(a.owner.name);
  });
});

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db, withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import type { EntityInput } from '../src/modules/audit/model.ts';
import { sumDays } from './audit-fixtures.ts';

// Datos de prueba. Todo se crea con el rol de la aplicación (app_rw) y el contexto de tenant
// correspondiente: si una política RLS fuera incorrecta, los propios seeds lo destaparían.

let shared: Db | undefined;
export function testDb(): Db {
  shared ??= createDb(process.env.DATABASE_URL as string).db;
  return shared;
}

const uniq = () => randomUUID().slice(0, 8);

/** Espera un rechazo y devuelve el error de Postgres (Drizzle lo envuelve en `cause`). */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const err = (e as { cause?: unknown }).cause ?? e;
    return {
      code: String((err as { code?: string }).code),
      message: String((err as Error).message),
    };
  }
  throw new Error('se esperaba un error de base de datos y la operación se completó');
}

export async function seedUser(db: Db, name = `user-${uniq()}`) {
  const [user] = await db
    .insert(s.authUsers)
    .values({ name, email: `${name}@agencia.test`, emailVerified: true })
    .returning();
  if (!user) throw new Error('seedUser');
  return user;
}

/** Tenant con un cliente, una conexión, una cuenta, una campaña, un hallazgo y una recomendación. */
export async function seedTenant(db: Db, label = `org-${uniq()}`) {
  const tenantId = randomUUID();
  const owner = await seedUser(db, `${label}-owner`);
  return withContext(db, { tenantId }, async (tx) => {
    await tx.insert(s.tenants).values({ id: tenantId, slug: label, name: `Org ${label}` });
    await tx.insert(s.memberships).values({ tenantId, userId: owner.id, role: 'owner' });
    const [client] = await tx
      .insert(s.clients)
      .values({ tenantId, name: `Cliente ${label}` })
      .returning();
    const [connection] = await tx
      .insert(s.metaConnections)
      .values({
        tenantId,
        kind: 'system_user',
        label: 'Conexión de prueba',
        metaAppId: '123',
        tokenCiphertext: Buffer.from('cifrado-de-prueba'),
        tokenNonce: Buffer.alloc(12),
        tokenKeyVersion: 1,
        tokenFingerprint: 'deadbeef',
        createdBy: owner.id,
      })
      .returning();
    const [account] = await tx
      .insert(s.adAccounts)
      .values({
        tenantId,
        connectionId: connection!.id,
        clientId: client!.id,
        metaAccountId: `act_${Math.floor(Math.random() * 1e9)}`,
        name: `Cuenta ${label}`,
        currency: 'EUR',
        timezoneName: 'Europe/Madrid',
        accountStatus: 1,
      })
      .returning();
    const [campaign] = await tx
      .insert(s.campaigns)
      .values({
        tenantId,
        metaId: `${Math.floor(Math.random() * 1e12)}`,
        adAccountId: account!.id,
        name: `Campaña ${label}`,
        objective: 'OUTCOME_LEADS',
        raw: {},
        lastSyncedAt: new Date(),
      })
      .returning();
    const [run] = await tx
      .insert(s.auditRuns)
      .values({
        tenantId,
        adAccountId: account!.id,
        trigger: 'manual',
        dataAsOf: new Date(),
        engineVersion: 'test',
        status: 'succeeded',
      })
      .returning();
    const [finding] = await tx
      .insert(s.findings)
      .values({
        tenantId,
        adAccountId: account!.id,
        auditRunId: run!.id,
        kind: 'audit',
        ruleId: 'R-EFF-002',
        ruleVersion: 1,
        entityLevel: 'campaign',
        entityMetaId: campaign!.metaId,
        fingerprint: `R-EFF-002:${campaign!.metaId}`,
        severity: 'high',
        confidence: '0.950',
        priority: '0.7',
        impact: { metric: 'excess_spend', value: 120, currency: 'EUR' },
        evidence: { spend: 120, results: 0 },
        recommendationKey: 'check_tracking',
      })
      .returning();
    const [recommendation] = await tx
      .insert(s.recommendations)
      .values({
        tenantId,
        adAccountId: account!.id,
        findingId: finding!.id,
        entityLevel: 'campaign',
        entityMetaId: campaign!.metaId,
        actionType: 'pause',
        rationale: 'Gasto sin resultados',
        source: 'rule',
      })
      .returning();
    await tx.insert(s.auditLog).values({ tenantId, actorType: 'system', action: 'test.seeded' });
    await tx.insert(s.findingEvents).values({
      tenantId,
      findingId: finding!.id,
      auditRunId: run!.id,
      event: 'opened',
      actorType: 'system',
    });
    await tx.insert(s.healthScores).values({
      tenantId,
      adAccountId: account!.id,
      entityLevel: 'campaign',
      entityMetaId: campaign!.metaId,
      date: '2026-10-01',
      formulaVersion: 'health-v1',
      profile: 'leads',
      windowDays: 7,
      score: '72.50',
      grade: 'good',
      confidence: '0.600',
      coverage: '0.850',
      components: [],
      auditRunId: run!.id,
    });
    await tx
      .insert(s.auditConfigs)
      .values({ tenantId, clientId: client!.id, config: { fdrQ: 0.1 }, updatedBy: owner.id });
    const adsetId = `${Math.floor(Math.random() * 1e12)}`;
    await tx.insert(s.adsets).values({
      tenantId,
      metaId: adsetId,
      adAccountId: account!.id,
      campaignMetaId: campaign!.metaId,
      name: `Conjunto ${label}`,
      raw: {},
      lastSyncedAt: new Date(),
    });
    await tx.insert(s.ads).values({
      tenantId,
      metaId: `${Math.floor(Math.random() * 1e12)}`,
      adAccountId: account!.id,
      adsetMetaId: adsetId,
      campaignMetaId: campaign!.metaId,
      name: `Anuncio ${label}`,
      raw: {},
      lastSyncedAt: new Date(),
    });
    const [syncRun] = await tx
      .insert(s.syncRuns)
      .values({
        tenantId,
        adAccountId: account!.id,
        kind: 'insights_incremental',
        apiVersion: 'v26.0',
      })
      .returning();
    await tx.insert(s.insightsDaily).values({
      tenantId,
      adAccountId: account!.id,
      level: 'account',
      entityMetaId: account!.metaAccountId,
      date: '2026-10-01',
      currency: 'EUR',
      spend: '10.0000',
      impressions: 1000,
      extractionVersion: 1,
      syncRunId: syncRun!.id,
      fetchedAt: new Date(),
    });
    // Asistente de IA: la conversación es del owner (su RLS exige app_user_id()).
    await tx.execute(sql`select set_config('app.user_id', ${owner.id}, true)`);
    const [conversation] = await tx
      .insert(s.aiConversations)
      .values({
        tenantId,
        userId: owner.id,
        title: 'Conversación de prueba',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      })
      .returning();
    await tx.insert(s.aiMessages).values({
      tenantId,
      conversationId: conversation!.id,
      role: 'user',
      content: '¿Qué tal va la cuenta?',
    });
    await tx.insert(s.llmUsage).values({
      tenantId,
      userId: owner.id,
      conversationId: conversation!.id,
      purpose: 'assistant',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: 'test',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: '0.000140',
      latencyMs: 1,
      status: 'ok',
    });
    return {
      tenantId,
      owner,
      client: client!,
      connection: connection!,
      account: account!,
      campaign: campaign!,
      run: run!,
      finding: finding!,
      recommendation: recommendation!,
    };
  });
}

export type SeededTenant = Awaited<ReturnType<typeof seedTenant>>;

export async function addMember(db: Db, tenantId: string, role: s.Role, clientIds: string[] = []) {
  const user = await seedUser(db, `${role}-${uniq()}`);
  await withContext(db, { tenantId }, async (tx) => {
    await tx.insert(s.memberships).values({ tenantId, userId: user.id, role });
    for (const clientId of clientIds)
      await tx.insert(s.clientAssignments).values({ tenantId, clientId, userId: user.id });
  });
  return user;
}

/** Segundo cliente del tenant, con su cuenta, para probar el alcance por cliente. */
export async function addClientWithAccount(db: Db, t: SeededTenant) {
  return withContext(db, { tenantId: t.tenantId }, async (tx) => {
    const [client] = await tx
      .insert(s.clients)
      .values({ tenantId: t.tenantId, name: `Otro ${uniq()}` })
      .returning();
    const [account] = await tx
      .insert(s.adAccounts)
      .values({
        tenantId: t.tenantId,
        connectionId: t.connection.id,
        clientId: client!.id,
        metaAccountId: `act_${Math.floor(Math.random() * 1e9)}`,
        name: 'Cuenta de otro cliente',
        currency: 'EUR',
        timezoneName: 'Europe/Madrid',
        accountStatus: 1,
      })
      .returning();
    return { client: client!, account: account! };
  });
}

/** Inserta entidades y sus días como si los hubiera traído la sincronización. */
export async function loadEntities(
  db: Db,
  tenantId: string,
  adAccountId: string,
  metaAccountId: string,
  entities: EntityInput[],
  replace = false,
) {
  await withContext(db, { tenantId }, async (tx) => {
    if (replace)
      await tx.delete(s.insightsDaily).where(eq(s.insightsDaily.adAccountId, adAccountId));
    const [run] = await tx
      .insert(s.syncRuns)
      .values({ tenantId, adAccountId, kind: 'insights_backfill', apiVersion: 'v26.0' })
      .returning();
    const now = new Date();
    if (!replace) {
      for (const e of entities) {
        const common = {
          tenantId,
          metaId: e.id,
          adAccountId,
          name: e.name,
          effectiveStatus: e.status,
          raw: {},
          lastSyncedAt: now,
        };
        if (e.level === 'campaign')
          await tx.insert(s.campaigns).values({ ...common, objective: e.objective });
        if (e.level === 'adset')
          await tx.insert(s.adsets).values({
            ...common,
            campaignMetaId: e.campaignId ?? '',
            optimizationGoal: e.optimizationGoal,
          });
        if (e.level === 'ad')
          await tx.insert(s.ads).values({
            ...common,
            adsetMetaId: e.parentId ?? '',
            campaignMetaId: e.campaignId ?? '',
          });
      }
    }
    const rows = [
      ...entities.map((e) => ({ e, level: e.level, id: e.id, days: e.days })),
      {
        e: null,
        level: 'account' as const,
        id: metaAccountId,
        days: sumDays(entities.filter((x) => x.level === 'campaign').flatMap((x) => x.days)),
      },
    ].flatMap(({ e, level, id, days }) =>
      days.map((d) => ({
        tenantId,
        adAccountId,
        level,
        entityMetaId: id,
        campaignMetaId: e?.campaignId ?? null,
        adsetMetaId: e?.level === 'ad' ? e.parentId : e?.level === 'adset' ? e.id : null,
        date: d.date,
        currency: 'USD',
        attributionSetting: d.attribution,
        spend: String(d.spend),
        impressions: d.impressions,
        reach: d.reach,
        clicks: d.clicks,
        inlineLinkClicks: d.inlineLinkClicks,
        results: level === 'account' ? null : String(d.results),
        resultIndicator: level === 'account' ? null : d.resultIndicator,
        leads: String(d.leads),
        extractionVersion: 1,
        syncRunId: run!.id,
        fetchedAt: now,
      })),
    );
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(s.insightsDaily).values(rows.slice(i, i + 500));
  });
}

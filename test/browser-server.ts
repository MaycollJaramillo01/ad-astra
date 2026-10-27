import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { testEnv } from './env.ts';

Object.assign(process.env, testEnv, {
  META_APP_ID: '',
  META_APP_SECRET: '',
  ANTHROPIC_API_KEY: '',
  META_WRITES_ENABLED: 'false',
  NOTIFICATIONS_EMAIL_ENABLED: 'false',
});
const { default: setup } = await import('./global-setup.ts');
await setup();
const { testDb, seedTenant, addMember } = await import('./seed.ts'),
  { withContext } = await import('../src/db/client.ts'),
  s = await import('../src/db/schema.ts');
const { testApp, config } = await import('./app.ts'),
  { createMonitoringService } = await import('../src/modules/monitoring/service.ts'),
  { defaultMonitorPolicy } = await import('../src/monitoring-contracts.ts');
const db = testDb(),
  a = await seedTenant(db, 'browser-a'),
  b = await seedTenant(db, 'browser-b'),
  viewer = await addMember(db, a.tenantId, 'viewer', [a.client.id]);
const count = Number(process.env.E2E_ACCOUNT_COUNT ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 50)
  throw new Error('Dataset de prueba fuera de límite');
await withContext(db, { tenantId: a.tenantId }, async (tx) => {
  await tx.insert(s.clientConsents).values({
    tenantId: a.tenantId,
    clientId: a.client.id,
    scope: ['read_insights'],
    grantedByName: 'SINTÉTICO',
    grantedByEmail: 'synthetic@agencia.test',
    grantedAt: new Date('2026-01-01'),
    recordedBy: a.owner.id,
  });
  for (let i = 1; i < count; i++) {
    const [acc] = await tx
      .insert(s.adAccounts)
      .values({
        tenantId: a.tenantId,
        clientId: a.client.id,
        connectionId: a.connection.id,
        metaAccountId: `act_${90000000 + i}`,
        name: `Cuenta sintética ${i}`,
        currency: 'EUR',
        timezoneName: 'Europe/Madrid',
        accountStatus: 1,
      })
      .returning();
    if (!acc) throw new Error('Cuenta no creada');
    const campaign = `${91000000 + i}`,
      adset = `${92000000 + i}`;
    await tx.insert(s.campaigns).values({
      tenantId: a.tenantId,
      adAccountId: acc.id,
      metaId: campaign,
      name: `Campaña ${i}`,
      objective: 'OUTCOME_LEADS',
      raw: {},
      lastSyncedAt: new Date(),
    });
    await tx.insert(s.adsets).values({
      tenantId: a.tenantId,
      adAccountId: acc.id,
      metaId: adset,
      campaignMetaId: campaign,
      name: `Conjunto ${i}`,
      optimizationGoal: 'LEAD_GENERATION',
      raw: {},
      lastSyncedAt: new Date(),
    });
    await tx.insert(s.ads).values({
      tenantId: a.tenantId,
      adAccountId: acc.id,
      metaId: `${93000000 + i}`,
      adsetMetaId: adset,
      campaignMetaId: campaign,
      name: `Anuncio ${i}`,
      raw: {},
      lastSyncedAt: new Date(),
    });
  }
  await tx.delete(s.insightsDaily);
  const [run] = await tx
    .insert(s.syncRuns)
    .values({
      tenantId: a.tenantId,
      adAccountId: a.account.id,
      kind: 'insights_incremental',
      apiVersion: 'v26.0',
      status: 'succeeded',
    })
    .returning();
  if (!run) throw new Error('Sin run');
  await tx.execute(sql`insert into insights_daily(tenant_id,ad_account_id,level,entity_meta_id,campaign_meta_id,adset_meta_id,date,currency,attribution_setting,spend,impressions,clicks,results,result_indicator,leads,purchases,extraction_version,sync_run_id,fetched_at)
 with entities as (
 select tenant_id,id as ad_account_id,'account' as level,meta_account_id as entity_meta_id,null::text as campaign_meta_id,null::text as adset_meta_id from ad_accounts
 union all select tenant_id,ad_account_id,'campaign',meta_id,meta_id,null::text from campaigns
 union all select tenant_id,ad_account_id,'adset',meta_id,campaign_meta_id,meta_id from adsets
 union all select tenant_id,ad_account_id,'ad',meta_id,campaign_meta_id,adset_meta_id from ads)
 select e.tenant_id,e.ad_account_id,e.level,e.entity_meta_id,e.campaign_meta_id,e.adset_meta_id,d::date,'EUR','7d_click',100,10000,100,0,'lead',0,0,1,${run.id},now() from entities e cross join generate_series(current_date-395,current_date-1,interval '1 day') d`);
  await tx.update(s.adAccounts).set({ lastInsightsSyncAt: new Date() });
});
const policy = defaultMonitorPolicy();
policy.enabled = true;
policy.openAfter = 1;
policy.notifications.quietStart = 0;
policy.notifications.quietEnd = 0;
await createMonitoringService(db).setPolicy(
  { tenantId: a.tenantId, userId: a.owner.id, role: 'owner' },
  a.account.id,
  { revision: 0, reason: 'Configuración exclusivamente sintética para e2e/carga', policy },
);
const cookies: Record<string, string> = {};
for (const user of [a.owner, viewer]) {
  const token = randomBytes(24).toString('hex');
  await db
    .insert(s.authSessions)
    .values({ token, userId: user.id, expiresAt: new Date(Date.now() + 3600000) });
  cookies[user.id] = encodeURIComponent(
    `${token}.${createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64')}`,
  );
}
await mkdir('spike-output/readiness', { recursive: true });
await writeFile(
  'spike-output/readiness/browser.json',
  JSON.stringify({
    tenantId: a.tenantId,
    otherTenantId: b.tenantId,
    accountId: a.account.id,
    campaignId: a.campaign.metaId,
    ownerId: a.owner.id,
    viewerId: viewer.id,
    cookies,
    accounts: count,
    days: 395,
  }),
  { mode: 0o600 },
);
const t = await testApp({ realAuth: true, config: { ANALYTICS_CACHE_MS: 15000 } });
await t.app.listen({ host: '127.0.0.1', port: Number(process.env.TEST_SERVER_PORT ?? 3000) });
process.once('SIGTERM', () => {
  void t.app.close().then(() => process.exit(0));
});
console.log(
  'Servidor de pruebas con sesiones Better Auth reales listo; sin integraciones externas.',
);

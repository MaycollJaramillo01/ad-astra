import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import {
  actionFollowups,
  actions,
  type adAccounts,
  ads,
  adsets,
  auditRuns,
  campaigns,
  findings,
  insightsDaily,
  metaConnections,
  recommendations,
} from '../../db/schema.ts';
import { addDays } from '../insights/catalog.ts';
import type { Day, Entity, FollowupPlan } from './model.ts';

const num = (v: string | number | null) =>
  v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
/** Solo hechos persistidos; los días ausentes y campos null nunca se imputan como cero. */
export async function loadMonitorData(
  tx: Tx,
  account: typeof adAccounts.$inferSelect,
  asOf: string,
) {
  const since = addDays(asOf, -200);
  const c = await tx.select().from(campaigns).where(eq(campaigns.adAccountId, account.id));
  const sets = await tx.select().from(adsets).where(eq(adsets.adAccountId, account.id));
  const advertisements = await tx.select().from(ads).where(eq(ads.adAccountId, account.id));
  const rows = await tx
    .select({
      level: insightsDaily.level,
      id: insightsDaily.entityMetaId,
      date: insightsDaily.date,
      spend: insightsDaily.spend,
      results: insightsDaily.results,
      leads: insightsDaily.leads,
      purchases: insightsDaily.purchases,
      attribution: insightsDaily.attributionSetting,
      indicator: insightsDaily.resultIndicator,
      flags: insightsDaily.dataFlags,
    })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.adAccountId, account.id),
        gte(insightsDaily.date, since),
        lte(insightsDaily.date, asOf),
      ),
    )
    .orderBy(insightsDaily.date);
  const groups = new Map<string, Day[]>();
  for (const r of rows) {
    const key = `${r.level}:${r.id}`,
      days = groups.get(key) ?? [];
    days.push({
      date: r.date,
      spend: num(r.spend),
      results: num(r.results),
      leads: num(r.leads),
      purchases: num(r.purchases),
      attribution: r.attribution,
      indicator: r.indicator,
      flags: r.flags,
    });
    groups.set(key, days);
  }
  const entities: Entity[] = c.map((e) => ({
    level: 'campaign',
    id: e.metaId,
    name: e.name,
    family: e.objective,
    parent: null,
    campaignId: e.metaId,
    days: groups.get(`campaign:${e.metaId}`) ?? [],
  }));
  for (const e of sets)
    entities.push({
      level: 'adset',
      id: e.metaId,
      name: e.name,
      family:
        c.find((x) => x.metaId === e.campaignMetaId)?.objective && e.optimizationGoal
          ? `${c.find((x) => x.metaId === e.campaignMetaId)?.objective}:${e.optimizationGoal}`
          : null,
      parent: e.campaignMetaId,
      campaignId: e.campaignMetaId,
      days: groups.get(`adset:${e.metaId}`) ?? [],
    });
  for (const e of advertisements) {
    const parent = sets.find((x) => x.metaId === e.adsetMetaId);
    entities.push({
      level: 'ad',
      id: e.metaId,
      name: e.name,
      family:
        parent?.optimizationGoal && c.find((x) => x.metaId === parent.campaignMetaId)?.objective
          ? `${c.find((x) => x.metaId === parent.campaignMetaId)?.objective}:${parent.optimizationGoal}`
          : null,
      parent: e.adsetMetaId,
      campaignId: parent?.campaignMetaId ?? null,
      days: groups.get(`ad:${e.metaId}`) ?? [],
    });
  }
  const [connection] = await tx
    .select({ status: metaConnections.status, expiresAt: metaConnections.expiresAt })
    .from(metaConnections)
    .where(eq(metaConnections.id, account.connectionId));
  const [audit] = await tx
    .select({
      id: auditRuns.id,
      asOf: auditRuns.asOf,
      status: auditRuns.status,
      stats: auditRuns.stats,
      finishedAt: auditRuns.finishedAt,
    })
    .from(auditRuns)
    .where(eq(auditRuns.adAccountId, account.id))
    .orderBy(desc(auditRuns.startedAt))
    .limit(1);
  const f = await tx
    .select({
      id: findings.id,
      status: findings.status,
      rule: findings.ruleId,
      level: findings.entityLevel,
      entityId: findings.entityMetaId,
      severity: findings.severity,
      category: findings.category,
      firstSeenAt: findings.firstSeenAt,
      lastSeenAt: findings.lastSeenAt,
    })
    .from(findings)
    .where(eq(findings.adAccountId, account.id));
  const recs = await tx
    .select({
      id: recommendations.id,
      status: recommendations.status,
      level: recommendations.entityLevel,
      entityId: recommendations.entityMetaId,
      createdAt: recommendations.createdAt,
      decidedAt: recommendations.decidedAt,
      actionType: recommendations.actionType,
    })
    .from(recommendations)
    .where(eq(recommendations.adAccountId, account.id));
  const operations = await tx
    .select({
      id: actions.id,
      entityLevel: actions.entityLevel,
      entityMetaId: actions.entityMetaId,
      state: actions.state,
      result: actions.result,
      operation: actions.operation,
      desired: actions.desired,
      dispatchAt: actions.dispatchAt,
      confirmedWrite: actions.confirmedWrite,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .where(eq(actions.adAccountId, account.id));
  return {
    entities,
    series: groups.get(`account:${account.metaAccountId}`) ?? [],
    connection,
    audit: audit ?? null,
    findings: f,
    recommendations: recs,
    actions: operations,
  };
}
export type MonitorData = Awaited<ReturnType<typeof loadMonitorData>>;

export async function freezeActionFollowup(
  tx: Tx,
  action: typeof actions.$inferSelect,
  plan: FollowupPlan,
) {
  await tx
    .insert(actionFollowups)
    .values({
      tenantId: action.tenantId,
      adAccountId: action.adAccountId,
      actionId: action.id,
      plan,
    })
    .onConflictDoNothing();
}

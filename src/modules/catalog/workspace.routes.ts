import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Db, withContext } from '../../db/client.ts';
import {
  actions,
  adAccounts,
  campaigns,
  clientConsents,
  clients,
  findings,
  healthScores,
  metaConnections,
  monitoringIncidents,
  monitoringPolicies,
  monitoringRuns,
} from '../../db/schema.ts';
import type { MonitoringPolicy } from '../../monitoring-contracts.ts';
import { tenantOf } from '../../platform/http.ts';
import {
  WorkspaceAccountDto,
  WorkspaceSearchQuery,
  WorkspaceSearchResultDto,
} from '../../workspace-contracts.ts';
import { clientScope } from '../tenancy/clients.routes.ts';

export async function workspaceRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/v1/account-workspace',
    {
      config: { access: { permission: 'accounts:read' } },
      schema: { response: { 200: z.array(WorkspaceAccountDto) } },
    },
    (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({
            account: adAccounts,
            clientName: clients.name,
            connectionStatus: metaConnections.status,
            connectionExpired: sql<boolean>`coalesce(${metaConnections.expiresAt} <= now(), false)`,
            policy: monitoringPolicies.config,
            readConsentActive: sql<boolean>`coalesce(${clients.status} = 'active' and exists (
          select 1 from ${clientConsents} where ${clientConsents.clientId} = ${adAccounts.clientId}
          and ${clientConsents.revokedAt} is null and ${clientConsents.grantedAt} <= now()
          and ${clientConsents.scope} @> array['read_insights']::text[]), false)`,
          })
          .from(adAccounts)
          .leftJoin(clients, eq(clients.id, adAccounts.clientId))
          .innerJoin(metaConnections, eq(metaConnections.id, adAccounts.connectionId))
          .leftJoin(monitoringPolicies, eq(monitoringPolicies.adAccountId, adAccounts.id))
          .where(clientScope(tx, ctx, adAccounts.clientId))
          .orderBy(adAccounts.name);
        if (!rows.length) return [];
        const ids = rows.map((r) => r.account.id);
        const incidentCounts = await tx
          .select({
            id: monitoringIncidents.adAccountId,
            count: sql<number>`count(*)`.mapWith(Number),
            critical:
              sql<number>`count(*) filter (where ${monitoringIncidents.severity} in ('critical','high'))`.mapWith(
                Number,
              ),
          })
          .from(monitoringIncidents)
          .where(
            and(
              inArray(monitoringIncidents.adAccountId, ids),
              inArray(monitoringIncidents.status, ['open', 'acknowledged', 'snoozed']),
            ),
          )
          .groupBy(monitoringIncidents.adAccountId);
        const findingCounts = await tx
          .select({
            id: findings.adAccountId,
            count: sql<number>`count(*)`.mapWith(Number),
            critical:
              sql<number>`count(*) filter (where ${findings.severity} in ('critical','high'))`.mapWith(
                Number,
              ),
          })
          .from(findings)
          .where(
            and(
              inArray(findings.adAccountId, ids),
              inArray(findings.status, ['open', 'acknowledged']),
            ),
          )
          .groupBy(findings.adAccountId);
        const actionCounts = await tx
          .select({
            id: actions.adAccountId,
            pending:
              sql<number>`count(*) filter (where ${actions.state} in ('proposed','review','approved','executing','verifying'))`.mapWith(
                Number,
              ),
            failed: sql<number>`count(*) filter (where ${actions.state} = 'failed')`.mapWith(
              Number,
            ),
          })
          .from(actions)
          .where(inArray(actions.adAccountId, ids))
          .groupBy(actions.adAccountId);
        const health = await tx
          .selectDistinctOn([healthScores.adAccountId], {
            id: healthScores.adAccountId,
            score: healthScores.score,
            grade: healthScores.grade,
            date: healthScores.date,
          })
          .from(healthScores)
          .where(
            and(inArray(healthScores.adAccountId, ids), eq(healthScores.entityLevel, 'account')),
          )
          .orderBy(
            healthScores.adAccountId,
            desc(healthScores.date),
            desc(healthScores.computedAt),
          );
        const runs = await tx
          .select({
            id: monitoringRuns.adAccountId,
            at: sql<string | null>`max(${monitoringRuns.at})`,
          })
          .from(monitoringRuns)
          .where(inArray(monitoringRuns.adAccountId, ids))
          .groupBy(monitoringRuns.adAccountId);
        const incidentMap = new Map(incidentCounts.map((x) => [x.id, x]));
        const findingMap = new Map(findingCounts.map((x) => [x.id, x]));
        const actionMap = new Map(actionCounts.map((x) => [x.id, x]));
        const healthMap = new Map(health.map((x) => [x.id, x]));
        const runMap = new Map(runs.map((x) => [x.id, x.at]));
        return rows.map(({ account: a, policy, ...rest }) => {
          const p = policy as MonitoringPolicy | null,
            h = healthMap.get(a.id);
          return {
            ...a,
            ...rest,
            lastDiscoveredAt: a.lastDiscoveredAt?.toISOString() ?? null,
            lastEntitiesSyncAt: a.lastEntitiesSyncAt?.toISOString() ?? null,
            lastInsightsSyncAt: a.lastInsightsSyncAt?.toISOString() ?? null,
            monitoringEnabled: p?.enabled ?? false,
            staleHours: p?.rules.find((r) => r.kind === 'sync_stale' && r.enabled)?.threshold ?? 24,
            lastEvaluationAt: runMap.get(a.id)
              ? new Date(runMap.get(a.id) as string).toISOString()
              : null,
            health: h
              ? { score: h.score === null ? null : Number(h.score), grade: h.grade, date: h.date }
              : null,
            incidents: incidentMap.get(a.id)?.count ?? 0,
            criticalIncidents: incidentMap.get(a.id)?.critical ?? 0,
            findings: findingMap.get(a.id)?.count ?? 0,
            criticalFindings: findingMap.get(a.id)?.critical ?? 0,
            pendingActions: actionMap.get(a.id)?.pending ?? 0,
            failedActions: actionMap.get(a.id)?.failed ?? 0,
          };
        });
      });
    },
  );
  app.get(
    '/v1/workspace-search',
    {
      config: { access: { permission: 'accounts:read' } },
      schema: {
        querystring: WorkspaceSearchQuery,
        response: { 200: z.array(WorkspaceSearchResultDto) },
      },
    },
    (request) => {
      const ctx = tenantOf(request);
      const pattern = `%${request.query.q.replace(/[\\%_]/g, '\\$&')}%`;
      return withContext(db, ctx, async (tx) => {
        const clientRows = await tx
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(and(clientScope(tx, ctx, clients.id), ilike(clients.name, pattern)))
          .orderBy(clients.name)
          .limit(8);
        const accounts = await tx
          .select({ id: adAccounts.id, name: adAccounts.name, client: clients.name })
          .from(adAccounts)
          .leftJoin(clients, eq(clients.id, adAccounts.clientId))
          .where(
            and(
              clientScope(tx, ctx, adAccounts.clientId),
              or(ilike(adAccounts.name, pattern), ilike(adAccounts.metaAccountId, pattern)),
            ),
          )
          .orderBy(adAccounts.name)
          .limit(8);
        const campaignRows = await tx
          .select({
            id: campaigns.metaId,
            name: campaigns.name,
            accountId: adAccounts.id,
            accountName: adAccounts.name,
          })
          .from(campaigns)
          .innerJoin(adAccounts, eq(adAccounts.id, campaigns.adAccountId))
          .where(
            and(
              clientScope(tx, ctx, adAccounts.clientId),
              isNull(campaigns.deletedAt),
              or(ilike(campaigns.name, pattern), ilike(campaigns.metaId, pattern)),
            ),
          )
          .orderBy(campaigns.name)
          .limit(8);
        return [
          ...clientRows.map((c) => ({
            kind: 'client' as const,
            ...c,
            accountId: null,
            context: 'Cliente',
          })),
          ...accounts.map(({ client, ...a }) => ({
            kind: 'account' as const,
            ...a,
            accountId: a.id,
            context: client ?? 'Sin cliente asignado',
          })),
          ...campaignRows.map(({ accountName, ...c }) => ({
            kind: 'campaign' as const,
            ...c,
            context: accountName,
          })),
        ];
      });
    },
  );
}

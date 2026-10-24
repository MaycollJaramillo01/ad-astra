import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AdAccountDto,
  CampaignDto,
  IdParams,
  SyncRunDto,
  UpdateAdAccountBody,
} from '../../contracts.ts';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import { adAccounts, campaigns, clients, syncRuns } from '../../db/schema.ts';
import { badRequest, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { type TenantContext, tenantOf } from '../../platform/http.ts';
import { cancelAccountJobs, ensureAccountJobs, hasReadConsent } from '../meta/sync.ts';
import { clientScope } from '../tenancy/clients.routes.ts';

// Cuentas publicitarias y campañas. Las crea el descubrimiento de Meta; aquí se consultan, se
// asignan a clientes y se activa su sincronización. Las cuentas sin cliente solo las ven owner y admin.

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const accountDto = (a: typeof adAccounts.$inferSelect) => ({
  id: a.id,
  metaAccountId: a.metaAccountId,
  name: a.name,
  currency: a.currency,
  timezoneName: a.timezoneName,
  accountStatus: a.accountStatus,
  clientId: a.clientId,
  syncEnabled: a.syncEnabled,
  userTasks: a.userTasks,
  lastDiscoveredAt: iso(a.lastDiscoveredAt),
  lastEntitiesSyncAt: iso(a.lastEntitiesSyncAt),
  lastInsightsSyncAt: iso(a.lastInsightsSyncAt),
});

export async function findAccount(tx: Tx, ctx: TenantContext, id: string) {
  const [row] = await tx
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.id, id), clientScope(tx, ctx, adAccounts.clientId)));
  if (!row) throw notFound('Cuenta publicitaria');
  return row;
}

export async function catalogRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/ad-accounts',
    {
      config: { access: { permission: 'accounts:read' } },
      schema: { response: { 200: z.array(AdAccountDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const rows = await withContext(db, ctx, (tx) =>
        tx
          .select()
          .from(adAccounts)
          .where(clientScope(tx, ctx, adAccounts.clientId))
          .orderBy(adAccounts.name),
      );
      return rows.map(accountDto);
    },
  );

  app.patch(
    '/v1/ad-accounts/:id',
    {
      config: { access: { permission: 'accounts:manage' } },
      schema: { params: IdParams, body: UpdateAdAccountBody, response: { 200: AdAccountDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const before = await findAccount(tx, ctx, request.params.id);
        const { clientId, syncEnabled } = request.body;
        if (clientId) {
          // RLS + FK compuesta ya lo impiden; se comprueba antes para dar un error claro.
          const [client] = await tx
            .select({ id: clients.id })
            .from(clients)
            .where(eq(clients.id, clientId));
          if (!client) throw badRequest('El cliente no existe en esta organización');
        }
        if (syncEnabled && !before.syncEnabled) {
          const target = clientId !== undefined ? clientId : before.clientId;
          if (!(await hasReadConsent(tx, target))) {
            throw badRequest(
              'Para sincronizar, la cuenta necesita un cliente con consentimiento read_insights activo',
            );
          }
        }
        const after = first(
          await tx
            .update(adAccounts)
            .set({
              ...(clientId !== undefined && { clientId }),
              ...(syncEnabled !== undefined && { syncEnabled }),
            })
            .where(eq(adAccounts.id, before.id))
            .returning(),
        );
        // Activar encola la sincronización (con backfill); desactivar saca de la cola lo pendiente.
        if (after.syncEnabled && !before.syncEnabled) {
          await ensureAccountJobs(tx, ctx.tenantId, after.id, { backfill: true });
        } else if (!after.syncEnabled && before.syncEnabled) {
          await cancelAccountJobs(tx, after.id);
        }
        await userEvent(tx, request, {
          action: 'ad_account.updated',
          targetType: 'ad_account',
          targetId: before.id,
          before: { clientId: before.clientId, syncEnabled: before.syncEnabled },
          after: { clientId: after.clientId, syncEnabled: after.syncEnabled },
        });
        return accountDto(after);
      });
    },
  );

  app.get(
    '/v1/ad-accounts/:id/campaigns',
    {
      config: { access: { permission: 'accounts:read' } },
      schema: { params: IdParams, response: { 200: z.array(CampaignDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const account = await findAccount(tx, ctx, request.params.id);
        const rows = await tx
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.adAccountId, account.id), isNull(campaigns.deletedAt)))
          .orderBy(campaigns.name);
        return rows.map((c) => ({
          metaId: c.metaId,
          name: c.name,
          objective: c.objective,
          status: c.status,
          effectiveStatus: c.effectiveStatus,
          dailyBudgetMinor: c.dailyBudgetMinor,
          lifetimeBudgetMinor: c.lifetimeBudgetMinor,
        }));
      });
    },
  );

  app.get(
    '/v1/ad-accounts/:id/sync-runs',
    {
      config: { access: { permission: 'accounts:read' } },
      schema: { params: IdParams, response: { 200: z.array(SyncRunDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const account = await findAccount(tx, ctx, request.params.id);
        const rows = await tx
          .select()
          .from(syncRuns)
          .where(eq(syncRuns.adAccountId, account.id))
          .orderBy(desc(syncRuns.id))
          .limit(50);
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          apiVersion: r.apiVersion,
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
          startedAt: r.startedAt.toISOString(),
          finishedAt: iso(r.finishedAt),
          apiCalls: r.apiCalls,
          rowsUpserted: r.rowsUpserted,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
        }));
      });
    },
  );
}

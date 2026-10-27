import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import {
  adAccounts,
  aiConversations,
  clientConsents,
  clients,
  memberships,
  tenants,
} from '../../db/schema.ts';
import { notFound } from '../../platform/errors.ts';
import type { TenantContext } from '../../platform/http.ts';
import { clientScope } from '../tenancy/clients.routes.ts';

/** Una conversación nunca reenvía evidencia de un alcance/consentimiento anterior. */
export async function accessHash(tx: Tx, ctx: TenantContext) {
  const [member] = await tx.select().from(memberships).where(eq(memberships.userId, ctx.userId));
  const [tenant] = await tx.select({ status: tenants.status }).from(tenants);
  if (!member || member.role !== ctx.role || tenant?.status !== 'active') return 'revoked';
  const visible = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.status, 'active'), clientScope(tx, ctx, clients.id)))
    .orderBy(clients.id);
  const grants = visible.length
    ? await tx
        .select({ id: clientConsents.id, client: clientConsents.clientId })
        .from(clientConsents)
        .where(
          and(
            inArray(
              clientConsents.clientId,
              visible.map((c) => c.id),
            ),
            isNull(clientConsents.revokedAt),
            sql`${clientConsents.grantedAt}<=now() and 'ai_processing'=any(${clientConsents.scope})`,
          ),
        )
        .orderBy(clientConsents.id)
    : [];
  const accounts = grants.length
    ? await tx
        .select({ id: adAccounts.id, client: adAccounts.clientId })
        .from(adAccounts)
        .where(
          inArray(
            adAccounts.clientId,
            grants.map((g) => g.client),
          ),
        )
        .orderBy(adAccounts.id)
    : [];
  return createHash('sha256')
    .update(JSON.stringify({ role: member.role, visible, grants, accounts }))
    .digest('hex');
}
export async function assertConversationAccess(tx: Tx, ctx: TenantContext, id: string) {
  const [c] = await tx.select().from(aiConversations).where(eq(aiConversations.id, id));
  if (!c?.accessHash || c.accessHash !== (await accessHash(tx, ctx)))
    throw notFound('Conversación vigente');
  return c;
}

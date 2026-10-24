import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ClientDto,
  ConsentDto,
  CreateClientBody,
  CreateConsentBody,
  IdParams,
  PutAssignmentsBody,
  UpdateClientBody,
} from '../../contracts.ts';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import { clientAssignments, clientConsents, clients, memberships } from '../../db/schema.ts';
import { badRequest, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { type TenantContext, tenantOf } from '../../platform/http.ts';
import { seesAllClients } from '../../platform/rbac.ts';

const iso = (d: Date) => d.toISOString();

/**
 * Alcance por cliente (docs/SECURITY.md §4.2): owner y admin ven todos; el resto, solo los
 * asignados. Devuelve una condición sobre la columna de cliente, o undefined si no hay filtro.
 * Lo usan también cuentas, hallazgos y recomendaciones.
 */
export function clientScope(tx: Tx, ctx: TenantContext, column: AnyPgColumn): SQL | undefined {
  if (seesAllClients(ctx.role)) return undefined;
  return inArray(
    column,
    tx
      .select({ id: clientAssignments.clientId })
      .from(clientAssignments)
      .where(eq(clientAssignments.userId, ctx.userId)),
  );
}

async function findClient(tx: Tx, ctx: TenantContext, id: string) {
  const [row] = await tx
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), clientScope(tx, ctx, clients.id)));
  if (!row) throw notFound('Cliente');
  return row;
}

const clientDto = (c: typeof clients.$inferSelect) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  createdAt: iso(c.createdAt),
});

const consentDto = (c: typeof clientConsents.$inferSelect) => ({
  id: c.id,
  scope: c.scope as z.infer<typeof ConsentDto>['scope'],
  grantedByName: c.grantedByName,
  grantedByEmail: c.grantedByEmail,
  evidenceRef: c.evidenceRef,
  grantedAt: iso(c.grantedAt),
  revokedAt: c.revokedAt ? iso(c.revokedAt) : null,
});

export async function clientRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/clients',
    {
      config: { access: { permission: 'clients:read' } },
      schema: { response: { 200: z.array(ClientDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const rows = await withContext(db, ctx, (tx) =>
        tx
          .select()
          .from(clients)
          .where(clientScope(tx, ctx, clients.id))
          .orderBy(clients.name),
      );
      return rows.map(clientDto);
    },
  );

  app.get(
    '/v1/clients/:id',
    {
      config: { access: { permission: 'clients:read' } },
      schema: { params: IdParams, response: { 200: ClientDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return clientDto(await withContext(db, ctx, (tx) => findClient(tx, ctx, request.params.id)));
    },
  );

  app.post(
    '/v1/clients',
    {
      config: { access: { permission: 'clients:manage' } },
      schema: { body: CreateClientBody, response: { 201: ClientDto } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const row = await withContext(db, ctx, async (tx) => {
        const created = first(
          await tx
            .insert(clients)
            .values({ tenantId: ctx.tenantId, name: request.body.name })
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'client.created',
          targetType: 'client',
          targetId: created.id,
          after: { name: created.name },
        });
        return created;
      });
      return reply.status(201).send(clientDto(row));
    },
  );

  app.patch(
    '/v1/clients/:id',
    {
      config: { access: { permission: 'clients:manage' } },
      schema: { params: IdParams, body: UpdateClientBody, response: { 200: ClientDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const before = await findClient(tx, ctx, request.params.id);
        const { name, status } = request.body;
        const after = first(
          await tx
            .update(clients)
            .set({
              ...(name !== undefined && { name }),
              ...(status !== undefined && {
                status,
                offboardedAt: status === 'offboarded' ? new Date() : null,
              }),
            })
            .where(eq(clients.id, before.id))
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'client.updated',
          targetType: 'client',
          targetId: before.id,
          before: { name: before.name, status: before.status },
          after: { name: after.name, status: after.status },
        });
        return clientDto(after);
      });
    },
  );

  app.put(
    '/v1/clients/:id/assignments',
    {
      config: { access: { permission: 'clients:manage' } },
      schema: {
        params: IdParams,
        body: PutAssignmentsBody,
        response: { 200: z.object({ userIds: z.array(z.uuid()) }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const userIds = [...new Set(request.body.userIds)];
      return withContext(db, ctx, async (tx) => {
        const client = await findClient(tx, ctx, request.params.id);
        if (userIds.length) {
          const members = await tx
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(inArray(memberships.userId, userIds));
          if (members.length !== userIds.length)
            throw badRequest('Algún usuario no es miembro de la organización');
        }
        await tx.delete(clientAssignments).where(eq(clientAssignments.clientId, client.id));
        if (userIds.length) {
          await tx
            .insert(clientAssignments)
            .values(
              userIds.map((userId) => ({ tenantId: ctx.tenantId, clientId: client.id, userId })),
            );
        }
        await userEvent(tx, request, {
          action: 'client.assignments_set',
          targetType: 'client',
          targetId: client.id,
          after: { userIds },
        });
        return { userIds };
      });
    },
  );

  app.get(
    '/v1/clients/:id/consents',
    {
      config: { access: { permission: 'clients:read' } },
      schema: { params: IdParams, response: { 200: z.array(ConsentDto) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const client = await findClient(tx, ctx, request.params.id);
        const rows = await tx
          .select()
          .from(clientConsents)
          .where(eq(clientConsents.clientId, client.id))
          .orderBy(clientConsents.grantedAt);
        return rows.map(consentDto);
      });
    },
  );

  app.post(
    '/v1/clients/:id/consents',
    {
      config: { access: { permission: 'consents:manage' } },
      schema: { params: IdParams, body: CreateConsentBody, response: { 201: ConsentDto } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const row = await withContext(db, ctx, async (tx) => {
        const client = await findClient(tx, ctx, request.params.id);
        const created = first(
          await tx
            .insert(clientConsents)
            .values({
              tenantId: ctx.tenantId,
              clientId: client.id,
              scope: [...new Set(request.body.scope)],
              grantedByName: request.body.grantedByName,
              grantedByEmail: request.body.grantedByEmail.toLowerCase(),
              evidenceRef: request.body.evidenceRef ?? null,
              grantedAt: new Date(request.body.grantedAt),
              recordedBy: ctx.userId,
            })
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'consent.recorded',
          targetType: 'client',
          targetId: client.id,
          after: { consentId: created.id, scope: created.scope },
        });
        return created;
      });
      return reply.status(201).send(consentDto(row));
    },
  );

  app.post(
    '/v1/clients/:id/consents/:consentId/revoke',
    {
      config: { access: { permission: 'consents:manage' } },
      schema: { params: IdParams.extend({ consentId: z.uuid() }), response: { 200: ConsentDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, async (tx) => {
        const client = await findClient(tx, ctx, request.params.id);
        const [row] = await tx
          .update(clientConsents)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(clientConsents.id, request.params.consentId),
              eq(clientConsents.clientId, client.id),
              isNull(clientConsents.revokedAt),
            ),
          )
          .returning();
        if (!row) throw notFound('Consentimiento vigente');
        await userEvent(tx, request, {
          action: 'consent.revoked',
          targetType: 'client',
          targetId: client.id,
          after: { consentId: row.id },
        });
        return consentDto(row);
      });
    },
  );
}

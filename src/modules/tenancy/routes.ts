import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateInvitationBody,
  IdParams,
  InvitationDto,
  MeDto,
  MemberDto,
  UpdateMemberBody,
} from '../../contracts.ts';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import { authUsers, invitations, memberships } from '../../db/schema.ts';
import { listMemberships } from '../../platform/access.ts';
import { conflict, forbidden, notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { identityOf, tenantOf } from '../../platform/http.ts';
import { canGrantRole } from '../../platform/rbac.ts';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
const UserParams = z.object({ userId: z.uuid() });

export async function tenancyRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/me',
    { config: { access: { authenticated: true } }, schema: { response: { 200: MeDto } } },
    async (request) => {
      const { userId } = identityOf(request);
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
      if (!user) throw notFound('Usuario');
      const ms = await listMemberships(db, userId);
      return {
        user: { id: user.id, email: user.email, name: user.name },
        memberships: ms.map(({ tenantId, tenantName, role }) => ({ tenantId, tenantName, role })),
      };
    },
  );

  app.get(
    '/v1/members',
    {
      config: { access: { permission: 'members:read' } },
      schema: { response: { 200: z.array(MemberDto) } },
    },
    async (request) => {
      const rows = await withContext(db, tenantOf(request), (tx) =>
        tx
          .select({
            userId: memberships.userId,
            role: memberships.role,
            createdAt: memberships.createdAt,
            email: authUsers.email,
            name: authUsers.name,
          })
          .from(memberships)
          .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
          .orderBy(authUsers.email),
      );
      return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
    },
  );

  app.patch(
    '/v1/members/:userId',
    {
      config: { access: { permission: 'members:manage' } },
      schema: { params: UserParams, body: UpdateMemberBody, response: { 200: MemberDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const { userId } = request.params;
      if (userId === ctx.userId) throw forbidden('No puedes cambiar tu propio rol');
      return withContext(db, ctx, async (tx) => {
        const [current] = await tx.select().from(memberships).where(eq(memberships.userId, userId));
        if (!current) throw notFound('Miembro');
        if (!canGrantRole(ctx.role, current.role) || !canGrantRole(ctx.role, request.body.role)) {
          throw forbidden('Solo un owner puede conceder o retirar los roles owner y admin');
        }
        await tx
          .update(memberships)
          .set({ role: request.body.role })
          .where(eq(memberships.userId, userId));
        await assertOwnerRemains(tx);
        await userEvent(tx, request, {
          action: 'member.role_changed',
          targetType: 'user',
          targetId: userId,
          before: { role: current.role },
          after: { role: request.body.role },
        });
        const row = first(
          await tx
            .select({
              userId: memberships.userId,
              role: memberships.role,
              createdAt: memberships.createdAt,
              email: authUsers.email,
              name: authUsers.name,
            })
            .from(memberships)
            .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
            .where(eq(memberships.userId, userId)),
        );
        return { ...row, createdAt: iso(row.createdAt) };
      });
    },
  );

  app.delete(
    '/v1/members/:userId',
    { config: { access: { permission: 'members:manage' } }, schema: { params: UserParams } },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const { userId } = request.params;
      if (userId === ctx.userId) throw forbidden('No puedes retirarte a ti mismo');
      await withContext(db, ctx, async (tx) => {
        const [current] = await tx.select().from(memberships).where(eq(memberships.userId, userId));
        if (!current) throw notFound('Miembro');
        if (!canGrantRole(ctx.role, current.role))
          throw forbidden('Solo un owner puede retirar a un owner o admin');
        await tx.delete(memberships).where(eq(memberships.userId, userId));
        await assertOwnerRemains(tx);
        await userEvent(tx, request, {
          action: 'member.removed',
          targetType: 'user',
          targetId: userId,
          before: { role: current.role },
        });
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/invitations',
    {
      config: { access: { permission: 'members:read' } },
      schema: { response: { 200: z.array(InvitationDto) } },
    },
    async (request) => {
      const rows = await withContext(db, tenantOf(request), (tx) =>
        tx.select().from(invitations).orderBy(invitations.createdAt),
      );
      return rows.map(invitationDto);
    },
  );

  app.post(
    '/v1/invitations',
    {
      config: { access: { permission: 'members:manage' } },
      schema: { body: CreateInvitationBody, response: { 201: InvitationDto } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      if (!canGrantRole(ctx.role, request.body.role)) {
        throw forbidden('Solo un owner puede invitar con rol owner o admin');
      }
      const created = await withContext(db, ctx, async (tx) => {
        const [already] = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
          .where(eq(authUsers.email, request.body.email));
        if (already) throw conflict('Esa persona ya es miembro');
        const row = first(
          await tx
            .insert(invitations)
            .values({
              tenantId: ctx.tenantId,
              email: request.body.email,
              role: request.body.role,
              invitedBy: ctx.userId,
            })
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'invitation.created',
          targetType: 'invitation',
          targetId: row.id,
          after: { email: row.email, role: row.role },
        });
        return row;
      });
      return reply.status(201).send(invitationDto(created));
    },
  );

  app.post(
    '/v1/invitations/:id/revoke',
    {
      config: { access: { permission: 'members:manage' } },
      schema: { params: IdParams, response: { 200: InvitationDto } },
    },
    async (request) =>
      withContext(db, tenantOf(request), async (tx) => {
        const [row] = await tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(invitations.id, request.params.id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning();
        if (!row) throw notFound('Invitación pendiente');
        await userEvent(tx, request, {
          action: 'invitation.revoked',
          targetType: 'invitation',
          targetId: row.id,
        });
        return invitationDto(row);
      }),
  );
}

function invitationDto(row: typeof invitations.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: iso(row.createdAt),
    acceptedAt: isoOrNull(row.acceptedAt),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

/** Una organización nunca se queda sin owner (se comprueba dentro de la transacción). */
async function assertOwnerRemains(tx: Tx) {
  const [{ owners } = { owners: 0 }] = await tx
    .select({ owners: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.role, 'owner'));
  if (owners < 1) throw conflict('La organización debe conservar al menos un owner');
}

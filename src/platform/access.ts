import { eq } from 'drizzle-orm';
import { type Db, withContext } from '../db/client.ts';
import { authUsers, invitations, memberships, tenants } from '../db/schema.ts';
import type { Role } from '../domain.ts';
import { recordEvent } from './events.ts';

// Acceso por invitación (ADR-019): tener cuenta en el Workspace no basta. Lo llaman los hooks
// de Better Auth al crear un usuario y al crear cada sesión.

export const emailInDomain = (email: string, domain: string) =>
  email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);

/** Alta de usuario: solo con el dominio de la agencia y una invitación pendiente. */
export async function canSignUp(db: Db, domain: string, email: string): Promise<boolean> {
  if (!emailInDomain(email, domain)) return false;
  const pending = await withContext(db, { userEmail: email }, (tx) =>
    tx.select({ id: invitations.id }).from(invitations).limit(1),
  );
  return pending.length > 0;
}

/**
 * Nueva sesión: convierte las invitaciones pendientes del usuario en membresías y permite la
 * sesión solo si tiene al menos una. Un usuario retirado de todas sus organizaciones no entra.
 */
export async function activateMemberships(db: Db, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId));
  if (!user) return false;
  const pending = await withContext(db, { userEmail: user.email }, (tx) =>
    tx.select().from(invitations),
  );
  for (const invitation of pending) {
    await withContext(db, { tenantId: invitation.tenantId }, async (tx) => {
      await tx
        .insert(memberships)
        .values({ tenantId: invitation.tenantId, userId, role: invitation.role })
        .onConflictDoNothing();
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, invitation.id));
      await recordEvent(
        tx,
        { tenantId: invitation.tenantId, actorType: 'user', actorId: userId },
        {
          action: 'invitation.accepted',
          targetType: 'invitation',
          targetId: invitation.id,
          after: { role: invitation.role },
        },
      );
    });
  }
  const mine = await withContext(db, { userId }, (tx) =>
    tx.select({ tenantId: memberships.tenantId }).from(memberships).limit(1),
  );
  return mine.length > 0;
}

export interface MembershipView {
  tenantId: string;
  tenantName: string;
  role: Role;
  tenantStatus: 'active' | 'suspended';
}

export function listMemberships(db: Db, userId: string): Promise<MembershipView[]> {
  return withContext(db, { userId }, (tx) =>
    tx
      .select({
        tenantId: memberships.tenantId,
        tenantName: tenants.name,
        role: memberships.role,
        tenantStatus: tenants.status,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, userId)),
  );
}

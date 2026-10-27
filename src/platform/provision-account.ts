import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { type Db, withContext } from '../db/client.ts';
import { authAccounts, authUsers, invitations } from '../db/schema.ts';
import { recordEvent } from './events.ts';

/** Solo CLI de operador: requiere invitación vigente. No existe endpoint público de alta. */
export async function provisionInvitedAccount(
  db: Db,
  input: {
    tenantId: string;
    email: string;
    password: string;
    name: string;
    reason: string;
  },
) {
  const email = input.email.trim().toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    input.password.length < 14 ||
    input.password.length > 128 ||
    input.reason.trim().length < 10
  )
    throw new Error('Correo, contraseña o motivo de provisión inválidos');
  const password = await hashPassword(input.password);
  return withContext(db, { tenantId: input.tenantId }, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, input.tenantId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .limit(1);
    if (!invitation) throw new Error('Se requiere invitación vigente en la organización');
    const id = randomUUID();
    await tx.insert(authUsers).values({ id, name: input.name, email, emailVerified: false });
    await tx
      .insert(authAccounts)
      .values({ providerId: 'credential', accountId: id, userId: id, password });
    await recordEvent(
      tx,
      { tenantId: input.tenantId, actorType: 'system', actorId: 'operator' },
      {
        action: 'auth.account_provisioned',
        targetType: 'user',
        targetId: id,
        after: { method: 'password', reason: input.reason, emailVerified: false },
      },
    );
    return id;
  });
}

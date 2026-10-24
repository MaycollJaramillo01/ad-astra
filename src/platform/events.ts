import type { FastifyRequest } from 'fastify';
import type { Tx } from '../db/client.ts';
import { auditLog } from '../db/schema.ts';

// Registro de eventos de solo inserción (docs/SECURITY.md §4.6). Se escribe en la misma
// transacción que el cambio: si el cambio se revierte, el evento también. Nunca secretos.

export interface EventInput {
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

export async function recordEvent(
  tx: Tx,
  actor: {
    tenantId: string | null;
    actorType: 'user' | 'system' | 'ai';
    actorId?: string;
    request?: FastifyRequest;
  },
  event: EventInput,
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    before: event.before ?? null,
    after: event.after ?? null,
    requestId: actor.request?.id ?? null,
    ip: actor.request?.ip ?? null,
    userAgent: actor.request?.headers['user-agent']?.slice(0, 300) ?? null,
  });
}

/** Evento hecho por el usuario de la petición en su tenant activo. */
export const userEvent = (tx: Tx, request: FastifyRequest, event: EventInput) =>
  recordEvent(
    tx,
    {
      tenantId: request.tenant?.tenantId ?? null,
      actorType: 'user',
      actorId: request.identity?.userId,
      request,
    },
    event,
  );

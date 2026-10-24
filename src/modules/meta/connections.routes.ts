import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ConnectionDto, CreateConnectionBody, IdParams } from '../../contracts.ts';
import { type Db, first, withContext } from '../../db/client.ts';
import { metaConnections } from '../../db/schema.ts';
import { fingerprint, type TokenCipher } from '../../platform/crypto.ts';
import { notFound } from '../../platform/errors.ts';
import { userEvent } from '../../platform/events.ts';
import { tenantOf } from '../../platform/http.ts';

// Conexiones de Meta (docs/API_INTEGRATIONS.md §1.4). El token es de solo escritura: se cifra
// al recibirlo y nunca sale en una respuesta, un log ni un evento (solo su huella).
// Aún no se valida contra Meta: queda en estado `pending` hasta que llegue la ingesta.

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const aadFor = (tenantId: string, connectionId: string) =>
  `meta_connections:${tenantId}:${connectionId}`;

const connectionDto = (c: typeof metaConnections.$inferSelect) => ({
  id: c.id,
  kind: c.kind,
  label: c.label,
  metaAppId: c.metaAppId,
  metaBusinessId: c.metaBusinessId,
  tokenFingerprint: c.tokenFingerprint,
  scopes: c.scopes,
  status: c.status,
  expiresAt: iso(c.expiresAt),
  lastValidatedAt: iso(c.lastValidatedAt),
  createdAt: c.createdAt.toISOString(),
});

export async function connectionRoutes(
  fastify: FastifyInstance,
  { db, cipher }: { db: Db; cipher: TokenCipher },
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/meta/connections',
    {
      config: { access: { permission: 'connections:read' } },
      schema: { response: { 200: z.array(ConnectionDto) } },
    },
    async (request) => {
      const rows = await withContext(db, tenantOf(request), (tx) =>
        tx.select().from(metaConnections).orderBy(metaConnections.createdAt),
      );
      return rows.map(connectionDto);
    },
  );

  app.post(
    '/v1/meta/connections',
    {
      config: { access: { permission: 'connections:manage' } },
      schema: { body: CreateConnectionBody, response: { 201: ConnectionDto } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const { accessToken, ...rest } = request.body;
      const id = randomUUID();
      const sealed = cipher.seal(accessToken, aadFor(ctx.tenantId, id));
      const row = await withContext(db, ctx, async (tx) => {
        const created = first(
          await tx
            .insert(metaConnections)
            .values({
              id,
              tenantId: ctx.tenantId,
              kind: rest.kind,
              label: rest.label,
              metaAppId: rest.metaAppId,
              metaBusinessId: rest.metaBusinessId ?? null,
              tokenCiphertext: sealed.ciphertext,
              tokenNonce: sealed.nonce,
              tokenKeyVersion: sealed.keyVersion,
              tokenFingerprint: fingerprint(accessToken),
              createdBy: ctx.userId,
            })
            .returning(),
        );
        await userEvent(tx, request, {
          action: 'meta_connection.created',
          targetType: 'meta_connection',
          targetId: id,
          after: {
            label: rest.label,
            kind: rest.kind,
            tokenFingerprint: created.tokenFingerprint,
          },
        });
        return created;
      });
      return reply.status(201).send(connectionDto(row));
    },
  );

  app.post(
    '/v1/meta/connections/:id/revoke',
    {
      config: { access: { permission: 'connections:manage' } },
      schema: { params: IdParams, response: { 200: ConnectionDto } },
    },
    async (request) =>
      withContext(db, tenantOf(request), async (tx) => {
        // Al revocar se borra el cifrado: el token deja de existir también en Ad Astra.
        const [row] = await tx
          .update(metaConnections)
          .set({
            status: 'revoked',
            tokenCiphertext: Buffer.alloc(0),
            tokenNonce: Buffer.alloc(0),
          })
          .where(
            and(eq(metaConnections.id, request.params.id), ne(metaConnections.status, 'revoked')),
          )
          .returning();
        if (!row) throw notFound('Conexión activa');
        await userEvent(tx, request, {
          action: 'meta_connection.revoked',
          targetType: 'meta_connection',
          targetId: row.id,
          after: { tokenFingerprint: row.tokenFingerprint },
        });
        return connectionDto(row);
      }),
  );
}

/** Descifra el token de una conexión (lo usará la ingesta; nunca una ruta HTTP). */
export function openConnectionToken(
  cipher: TokenCipher,
  row: typeof metaConnections.$inferSelect,
): string {
  return cipher.open(
    { ciphertext: row.tokenCiphertext, nonce: row.tokenNonce, keyVersion: row.tokenKeyVersion },
    aadFor(row.tenantId, row.id),
  );
}

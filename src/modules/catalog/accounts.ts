import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import { adAccounts } from '../../db/schema.ts';
import { notFound } from '../../platform/errors.ts';
import type { TenantContext } from '../../platform/http.ts';
import { clientScope } from '../tenancy/clients.routes.ts';

// Lectura de una cuenta con el alcance por cliente. Aparte de las rutas para que los módulos de
// solo lectura (analítica, auditoría, IA) no arrastren la sincronización ni el cliente de Meta.

export async function findAccount(tx: Tx, ctx: TenantContext, id: string) {
  const [row] = await tx
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.id, id), clientScope(tx, ctx, adAccounts.clientId)));
  if (!row) throw notFound('Cuenta publicitaria');
  return row;
}

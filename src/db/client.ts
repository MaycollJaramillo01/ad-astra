import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

/** La fila de un `insert/update ... returning()` o de una búsqueda que debe existir. */
export function first<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('La operación no devolvió ninguna fila');
  return row;
}

export interface DbContext {
  tenantId?: string;
  userId?: string;
  userEmail?: string;
}

/**
 * Ejecuta `fn` en una transacción con el contexto que leen las políticas RLS
 * (app_tenant_id(), app_user_id(), app_user_email()). `set_config(..., true)` es local a la
 * transacción: el contexto no sobrevive a ella ni se filtra a otra petición del pool.
 * Sin contexto, las políticas no dejan ver ni escribir nada (fallo cerrado).
 */
export function withContext<T>(db: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true),
      set_config('app.user_id', ${ctx.userId ?? ''}, true),
      set_config('app.user_email', ${ctx.userEmail?.toLowerCase() ?? ''}, true)`);
    return fn(tx);
  });
}

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { pgError, type SeededTenant, seedTenant, seedUser, testDb } from './seed.ts';

// Pruebas de aislamiento entre tenants en la propia base de datos (ADR-007, CA-F1-02).
// Se ejecutan con app_rw, el mismo rol que la aplicación.

const db = testDb();
let a: SeededTenant;
let b: SeededTenant;

// Tablas globales a propósito (Better Auth): un usuario puede pertenecer a varios tenants.
const GLOBAL_TABLES = ['auth_accounts', 'auth_sessions', 'auth_users', 'auth_verifications'];
// Tablas de sistema del tick (ADR-022): sin RLS, solo identificadores (test aparte).
const SYSTEM_TABLES = ['jobs', 'meta_rate_state', 'deployment_state'];

/** Tablas con tenant_id, sin las de sistema ni las particiones (se accede por la tabla madre). */
async function tenantTables(): Promise<string[]> {
  const { rows } = await db.execute<{ table_name: string }>(sql`
    select c.table_name from information_schema.columns c
    join pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and not k.relispartition
    order by c.table_name`);
  return rows.map((r) => r.table_name).filter((t) => !SYSTEM_TABLES.includes(t));
}

beforeAll(async () => {
  a = await seedTenant(db);
  b = await seedTenant(db);
});

/** Tablas de historial: se insertan y se leen, nunca se cambian ni se borran. */
const APPEND_ONLY = [
  'audit_log',
  'finding_events',
  'llm_usage',
  'action_events',
  'action_approvals',
  'monitoring_events',
  'monitoring_runs',
  'monitoring_reports',
];

describe('cobertura de RLS', () => {
  it('toda tabla con tenant_id tiene RLS activado y forzado, con al menos una política', async () => {
    const { rows } = await db.execute<{
      relname: string;
      on: boolean;
      forced: boolean;
      policies: number;
    }>(sql`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`);
    const byName = new Map(rows.map((r) => [r.relname, r]));
    const tables = [...(await tenantTables()), 'tenants'];
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) {
      expect(byName.get(t), t).toMatchObject({ on: true, forced: true });
      expect(byName.get(t)?.policies, t).toBeGreaterThan(0);
    }
  });

  it('las únicas tablas sin RLS son las globales de autenticación y las de sistema', async () => {
    const { rows } = await db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
        and not c.relrowsecurity order by 1`);
    expect(rows.map((r) => r.relname)).toEqual([...GLOBAL_TABLES, ...SYSTEM_TABLES].sort());
  });

  it('las particiones no son accesibles directamente: solo por la tabla madre, que tiene RLS', async () => {
    const { rows } = await db.execute<{ part: string; readable: boolean }>(sql`
      select c.relname as part, has_table_privilege(current_user, c.oid, 'SELECT') as readable
      from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'insights_daily'::regclass`);
    expect(rows.length).toBeGreaterThan(70);
    expect(rows.filter((r) => r.readable).map((r) => r.part)).toEqual([]);
    expect(await pgError(db.execute(sql`select * from insights_daily_2026_10`))).toMatchObject({
      code: '42501',
    });
  });

  it('la tabla de trabajos solo guarda identificadores en su payload', async () => {
    const { rows } = await db.execute<{ key: string }>(
      sql`select distinct jsonb_object_keys(payload) as key from jobs`,
    );
    for (const { key } of rows)
      expect(key, key).toMatch(/^(adAccountId|connectionId|monthsDone|actionId|deliveryId)$/);
  });

  it('el rol de la aplicación no puede saltarse RLS ni crear tablas', async () => {
    const { rows } = await db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    expect(await pgError(db.execute(sql`create table rls_probe (x int)`))).toMatchObject({
      code: '42501',
      message: expect.stringMatching(/permission denied/),
    });
  });
});

describe('aislamiento entre tenants', () => {
  it('sin contexto no se ve ninguna fila de ninguna tabla de tenant', async () => {
    for (const t of await tenantTables()) {
      const { rows } = await withContext(db, {}, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)}`),
      );
      expect(rows[0]?.n, t).toBe(0);
    }
  });

  it('el tenant B no ve, actualiza ni borra filas del tenant A en ninguna tabla', async () => {
    for (const t of await tenantTables()) {
      const table = sql.identifier(t);
      await withContext(db, { tenantId: b.tenantId }, async (tx) => {
        const seen = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from ${table} where tenant_id = ${a.tenantId}`,
        );
        expect(seen.rows[0]?.n, `${t}: select`).toBe(0);
        if (APPEND_ONLY.includes(t)) return; // sin UPDATE ni DELETE: se prueba aparte
        const updated = await tx.execute(
          sql`update ${table} set tenant_id = tenant_id where tenant_id = ${a.tenantId}`,
        );
        expect(updated.rowCount, `${t}: update`).toBe(0);
        if (t !== 'action_followups') {
          const deleted = await tx.execute(
            sql`delete from ${table} where tenant_id = ${a.tenantId}`,
          );
          expect(deleted.rowCount, `${t}: delete`).toBe(0);
        }
      });
    }
    // Las filas de A siguen intactas.
    const still = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(s.clients),
    );
    expect(still.map((c) => c.id)).toContain(a.client.id);
  });

  it('no se puede insertar una fila para otro tenant (WITH CHECK)', async () => {
    expect(
      await pgError(
        withContext(db, { tenantId: b.tenantId }, (tx) =>
          tx.insert(s.clients).values({ tenantId: a.tenantId, name: 'intrusa' }),
        ),
      ),
    ).toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
  });

  it('no se puede mover una fila propia a otro tenant', async () => {
    expect(
      await pgError(
        withContext(db, { tenantId: b.tenantId }, (tx) =>
          tx.execute(sql`update clients set tenant_id = ${a.tenantId} where id = ${b.client.id}`),
        ),
      ),
    ).toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
  });

  it('las FK compuestas impiden enlazar una fila propia con un id de otro tenant', async () => {
    expect(
      await pgError(
        withContext(db, { tenantId: b.tenantId }, (tx) =>
          tx.execute(
            sql`update ad_accounts set client_id = ${a.client.id} where id = ${b.account.id}`,
          ),
        ),
      ),
    ).toMatchObject({ code: '23503', message: expect.stringMatching(/foreign key/) });
  });

  it('el contexto no sobrevive a la transacción', async () => {
    await withContext(db, { tenantId: a.tenantId }, async () => undefined);
    const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from clients`);
    expect(rows[0]?.n).toBe(0);
  });
});

describe('políticas especiales', () => {
  it('un usuario solo ve los tenants de los que es miembro', async () => {
    const visible = await withContext(db, { userId: a.owner.id }, (tx) =>
      tx.select().from(s.tenants),
    );
    expect(visible.map((t) => t.id)).toEqual([a.tenantId]);
  });

  it('un usuario ve sus membresías en todos sus tenants, pero no las ajenas', async () => {
    await withContext(db, { tenantId: b.tenantId }, (tx) =>
      tx.insert(s.memberships).values({ tenantId: b.tenantId, userId: a.owner.id, role: 'viewer' }),
    );
    const mine = await withContext(db, { userId: a.owner.id }, (tx) =>
      tx.select().from(s.memberships),
    );
    expect(mine.map((m) => m.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
    expect(mine.every((m) => m.userId === a.owner.id)).toBe(true);
  });

  it('una conversación con la IA solo la ve su usuario, aunque otro sea del mismo tenant', async () => {
    const colleague = await seedUser(db);
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx
        .insert(s.memberships)
        .values({ tenantId: a.tenantId, userId: colleague.id, role: 'admin' }),
    );
    const as = (userId: string) =>
      withContext(db, { tenantId: a.tenantId, userId }, async (tx) => ({
        conversations: await tx.select().from(s.aiConversations),
        messages: await tx.select().from(s.aiMessages),
      }));
    const mine = await as(a.owner.id);
    expect(mine.conversations.length).toBe(1);
    expect(mine.messages.length).toBe(1);
    expect(await as(colleague.id)).toEqual({ conversations: [], messages: [] });
    // Tampoco puede escribir en ella ni crear una a nombre de otro.
    expect(
      await pgError(
        withContext(db, { tenantId: a.tenantId, userId: colleague.id }, (tx) =>
          tx.insert(s.aiMessages).values({
            tenantId: a.tenantId,
            conversationId: mine.conversations[0]!.id,
            role: 'user',
            content: 'intrusa',
          }),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await pgError(
        withContext(db, { tenantId: a.tenantId, userId: colleague.id }, (tx) =>
          tx.insert(s.aiConversations).values({
            tenantId: a.tenantId,
            userId: a.owner.id,
            title: 'suplantada',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
          }),
        ),
      ),
    ).toMatchObject({ code: '42501' });
  });

  it('un invitado ve sus invitaciones pendientes y no las de otros', async () => {
    const outsider = await seedUser(db);
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.insert(s.invitations).values([
        { tenantId: a.tenantId, email: outsider.email, role: 'analyst' },
        { tenantId: a.tenantId, email: 'otra@agencia.test', role: 'viewer' },
      ]),
    );
    const seen = await withContext(db, { userEmail: outsider.email }, (tx) =>
      tx.select().from(s.invitations),
    );
    expect(seen.map((i) => i.email)).toEqual([outsider.email]);
  });

  it('audit_log, finding_events y llm_usage son de solo inserción y no admiten filas de otro tenant', async () => {
    for (const t of APPEND_ONLY) {
      for (const statement of [
        sql`update ${sql.identifier(t)} set tenant_id = tenant_id`,
        sql`delete from ${sql.identifier(t)}`,
      ]) {
        await withContext(db, { tenantId: a.tenantId }, async (tx) => {
          expect(await pgError(tx.execute(statement)), t).toMatchObject({
            code: '42501',
            message: expect.stringMatching(/permission denied/),
          });
        });
      }
    }
    expect(
      await pgError(
        withContext(db, { tenantId: b.tenantId }, (tx) =>
          tx.insert(s.findingEvents).values({
            tenantId: a.tenantId,
            findingId: a.finding.id,
            event: 'opened',
            actorType: 'system',
          }),
        ),
      ),
    ).toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
    expect(
      await pgError(
        withContext(db, { tenantId: b.tenantId }, (tx) =>
          tx
            .insert(s.auditLog)
            .values({ tenantId: a.tenantId, actorType: 'user', action: 'falso' }),
        ),
      ),
    ).toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
  });
});

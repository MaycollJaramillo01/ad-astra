import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Integración con Postgres real (docker compose o servicio de la CI). Sin BD, el test falla:
// no se salta en silencio.
const url = process.env.DATABASE_URL ?? 'postgres://app_rw:app_rw_local@localhost:55432/ad_astra';
const client = new pg.Client({ connectionString: url });

beforeAll(() => client.connect());
afterAll(() => client.end());

it('el rol de la aplicación no es superusuario ni puede saltarse RLS', async () => {
  const { rows } = await client.query(
    'select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user',
  );
  expect(rows[0]).toEqual({
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
  });
});

it('el rol de la aplicación no puede crear tablas (sin DDL)', async () => {
  await expect(client.query('create table rls_probe (x int)')).rejects.toThrow(/permission denied/);
});

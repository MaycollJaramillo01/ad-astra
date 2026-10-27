import pg from 'pg';
import { runMigrations } from '../scripts/migrate.ts';
import { testEnv } from './env.ts';

// Una vez por ejecución: migra la BD de tests y la vacía (con el rol propietario).
export default async function setup() {
  await runMigrations(testEnv.DATABASE_URL_OWNER);
  const client = new pg.Client({ connectionString: testEnv.DATABASE_URL_OWNER });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      `select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
    );
    await client.query(
      `truncate table ${rows.map((r) => r.name).join(', ')} restart identity cascade`,
    );
    await client.query(
      "insert into deployment_state(id,environment,schema_version,recovery_mode) values(1,'test',16,false)",
    );
  } finally {
    await client.end();
  }
}

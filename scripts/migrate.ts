// Aplica las migraciones con el rol propietario (app_owner): la aplicación usa app_rw, sin DDL.
//   pnpm db:migrate     (lee DATABASE_URL_OWNER de .env.local o del entorno)
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export async function assertProductionMigration(
  ownerUrl: string,
  reason: string,
  drained: boolean,
) {
  if (!drained || reason.trim().length < 10)
    throw new Error('Producción exige LEGACY_WORKERS_STOPPED=true y OPS_CHANGE_REASON revisado');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const exists = await client.query("select to_regclass('public.deployment_state') as name");
    if (exists.rows[0]?.name) {
      const state = await client.query(
        'select environment,recovery_mode from deployment_state where id=1',
      );
      if (state.rows[0]?.environment !== 'production' || state.rows[0]?.recovery_mode !== true)
        throw new Error('La migración de producción exige vinculación y cuarentena previas');
    }
  } finally {
    await client.end();
  }
}

export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('Falta DATABASE_URL_OWNER (conexión con el rol app_owner)');
  if (
    process.env.NODE_ENV === 'production' &&
    !['staging', 'production'].includes(process.env.APP_ENV ?? '')
  )
    throw new Error('APP_ENV explícito obligatorio en despliegues');
  if (process.env.APP_ENV === 'production')
    await assertProductionMigration(
      url,
      process.env.OPS_CHANGE_REASON ?? '',
      process.env.LEGACY_WORKERS_STOPPED === 'true',
    );
  await runMigrations(url);
  console.log('Migraciones aplicadas');
}

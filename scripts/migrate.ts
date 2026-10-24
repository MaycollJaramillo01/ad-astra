// Aplica las migraciones con el rol propietario (app_owner): la aplicación usa app_rw, sin DDL.
//   pnpm db:migrate     (lee DATABASE_URL_OWNER de .env.local o del entorno)
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

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
  await runMigrations(url);
  console.log('Migraciones aplicadas');
}

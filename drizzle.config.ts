import { defineConfig } from 'drizzle-kit';

// Solo para generar migraciones (pnpm db:generate). Aplicarlas: pnpm db:migrate.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
});

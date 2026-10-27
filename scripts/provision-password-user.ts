import { readFile } from 'node:fs/promises';
import { createDb } from '../src/db/client.ts';
import { loadConfig } from '../src/platform/config.ts';
import { redact } from '../src/platform/logging.ts';
import { provisionInvitedAccount } from '../src/platform/provision-account.ts';

const config = loadConfig();
if (config.AUTH_MODE !== 'password') throw new Error('Se requiere AUTH_MODE=password');
const { db, pool } = createDb(config.DATABASE_URL);
try {
  const id = await provisionInvitedAccount(db, {
    tenantId: process.env.ACCOUNT_TENANT_ID ?? '',
    email: process.env.ACCOUNT_EMAIL ?? '',
    name: process.env.ACCOUNT_NAME ?? '',
    password: (await readFile(process.env.ACCOUNT_PASSWORD_FILE ?? '', 'utf8')).trimEnd(),
    reason: process.env.OPS_CHANGE_REASON ?? '',
  });
  console.log(`Cuenta invitada provisionada: ${id}. Entregar la contraseña por un canal privado.`);
} catch (e) {
  console.error(redact(e instanceof Error ? e.message : 'No se pudo provisionar la cuenta'));
  process.exitCode = 1;
} finally {
  await pool.end();
}

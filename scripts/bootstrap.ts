// Alta inicial: crea una organización y la invitación de su primer owner (acceso solo por
// invitación, ADR-019). El owner entra después con Google y la invitación se activa sola.
//   pnpm admin:bootstrap --name "Mi Agencia" --slug mi-agencia --owner persona@agencia.com
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createDb, withContext } from '../src/db/client.ts';
import { invitations, tenants } from '../src/db/schema.ts';
import { recordEvent } from '../src/platform/events.ts';

const { values } = parseArgs({
  options: { name: { type: 'string' }, slug: { type: 'string' }, owner: { type: 'string' } },
});
const { name, slug, owner } = values;
if (!name || !slug || !owner || !/^[a-z0-9-]+$/.test(slug) || !owner.includes('@')) {
  console.error(
    'Uso: pnpm admin:bootstrap --name "Mi Agencia" --slug mi-agencia --owner persona@agencia.com',
  );
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL');

const { db, pool } = createDb(url);
const tenantId = randomUUID();
try {
  await withContext(db, { tenantId }, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name, slug });
    await tx.insert(invitations).values({ tenantId, email: owner.toLowerCase(), role: 'owner' });
    await recordEvent(
      tx,
      { tenantId, actorType: 'system', actorId: 'bootstrap' },
      {
        action: 'tenant.bootstrapped',
        targetType: 'tenant',
        targetId: tenantId,
        after: { name, slug, owner },
      },
    );
  });
  console.log(`Organización "${name}" creada (${tenantId}). ${owner} ya puede entrar con Google.`);
} finally {
  await pool.end();
}

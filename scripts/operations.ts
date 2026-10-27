import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createDb, withContext } from '../src/db/client.ts';
import { deploymentState } from '../src/db/schema.ts';
import { recordEvent } from '../src/platform/events.ts';
import { redact } from '../src/platform/logging.ts';
import { validateProductionDrill } from './backup.ts';

const mode = process.argv[2],
  environment = process.env.APP_ENV,
  reason = process.env.OPS_CHANGE_REASON ?? '';
if (!['development', 'test', 'staging', 'production'].includes(environment ?? ''))
  throw new Error('APP_ENV explícito obligatorio');
const { db, pool } = createDb(process.env.DATABASE_URL_OWNER ?? '');
try {
  const [state] = await db.select().from(deploymentState);
  if (!state) throw new Error('Migraciones pendientes');
  if (mode === 'bind') {
    if (state.environment !== 'unbound' && state.environment !== environment)
      throw new Error('No se puede reutilizar una base vinculada a otro entorno');
    await db
      .update(deploymentState)
      .set({ environment, updatedAt: new Date() })
      .where(eq(deploymentState.id, 1));
  } else {
    const tenantId = process.env.OPS_AUDIT_TENANT_ID ?? '';
    if (!/^[a-f0-9-]{36}$/i.test(tenantId) || reason.trim().length < 10)
      throw new Error('OPS_AUDIT_TENANT_ID y OPS_CHANGE_REASON son obligatorios');
    if (state.environment !== environment) throw new Error('Entorno de destino incompatible');
    if (mode === 'release' && environment === 'production') {
      const evidence = JSON.parse(await readFile(process.env.RELEASE_EVIDENCE_FILE ?? '', 'utf8'));
      for (const name of [
        'accessReviewed',
        'metaPermissionsReviewed',
        'tenantAllowlistReviewed',
        'statisticalLimitationsAccepted',
        'pitrVerified',
      ])
        if (evidence[name] !== true) throw new Error(`Falta evidencia: ${name}`);
      if (!/^[a-f0-9]{40}$/.test(evidence.sha ?? '') || !evidence.changeTicket)
        throw new Error('Falta revisión y ticket del cambio');
      if (
        !state.backupAt ||
        Date.now() - state.backupAt.getTime() > 86400000 ||
        !state.restoreDrillAt ||
        Date.now() - state.restoreDrillAt.getTime() > 30 * 86400000
      )
        throw new Error('Backup o simulacro sin evidencia vigente');
    }
    let drillAt: Date | undefined;
    if (mode === 'attest-drill') {
      if (environment !== 'production')
        throw new Error('La atestación exige el entorno production');
      drillAt = validateProductionDrill(
        JSON.parse(await readFile(process.env.DRILL_EVIDENCE_FILE ?? '', 'utf8')),
      );
    }
    if (!['release', 'kill', 'attest-drill'].includes(mode ?? ''))
      throw new Error('Uso: operations.ts bind|release|kill|attest-drill');
    await withContext(db, { tenantId }, async (tx) => {
      await tx
        .update(deploymentState)
        .set(
          drillAt
            ? { restoreDrillAt: drillAt, updatedAt: new Date() }
            : { recoveryMode: mode !== 'release', updatedAt: new Date() },
        )
        .where(eq(deploymentState.id, 1));
      await recordEvent(
        tx,
        { tenantId, actorType: 'system' },
        {
          action: `operations.${mode}`,
          targetType: 'deployment',
          targetId: environment,
          after: { reason, environment },
        },
      );
    });
  }
  console.log(`Operación ${mode} aplicada al entorno ${environment}.`);
} catch (e) {
  console.error(redact(e instanceof Error ? e.message : 'Operación técnica fallida'));
  process.exitCode = 1;
} finally {
  await pool.end();
}

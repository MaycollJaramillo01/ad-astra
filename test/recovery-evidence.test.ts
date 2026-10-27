import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { attestBackup, validateProductionDrill } from '../scripts/backup.ts';
import { assertProductionMigration } from '../scripts/migrate.ts';
import { testEnv } from './env.ts';

it('el despliegue no migra producción sin detener los workers ni sobre una base de test', async () => {
  await expect(assertProductionMigration('', 'Cambio revisado CHG-42', false)).rejects.toThrow(
    'LEGACY_WORKERS_STOPPED',
  );
  await expect(
    assertProductionMigration(testEnv.DATABASE_URL_OWNER, 'Cambio revisado CHG-42', true),
  ).rejects.toThrow('cuarentena');
});
it('un backup local, sin retención o con fecha inválida no acredita una copia externa', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ad-astra-evidence-'));
  // El directorio procede de mkdtemp, no de entradas del usuario; se borran solo estos dos archivos.
  const evidence = join(folder, 'evidence.json'),
    receipt = join(folder, 'receipt.json');
  try {
    await writeFile(
      evidence,
      JSON.stringify({ sha256: 'a'.repeat(64), bytes: 100, createdAt: new Date().toISOString() }),
    );
    for (const lock of [
      {},
      { ObjectLockMode: 'GOVERNANCE', ObjectLockRetainUntilDate: 'invalid' },
      { ObjectLockMode: 'GOVERNANCE', ObjectLockRetainUntilDate: new Date().toISOString() },
    ]) {
      await writeFile(
        receipt,
        JSON.stringify({
          Metadata: { sha256: 'a'.repeat(64) },
          ContentLength: 100,
          VersionId: 'version',
          ...lock,
        }),
      );
      await expect(attestBackup('', evidence, receipt)).rejects.toThrow('retención');
    }
  } finally {
    await rm(evidence, { force: true });
    await rm(receipt, { force: true });
    await rmdir(folder);
  }
});
it('una restauración iniciada o un simulacro sintético no acredita RPO/RTO de producción', () => {
  expect(() => validateProductionDrill({ at: new Date().toISOString(), synthetic: true })).toThrow(
    'real',
  );
  expect(() => validateProductionDrill({ at: new Date().toISOString(), synthetic: false })).toThrow(
    'incompleto',
  );
  const evidence = {
    at: new Date().toISOString(),
    synthetic: false,
    runtimeRlsVerified: true,
    encryptedCredentialRoundtrip: true,
    tamperRejectedBeforeSql: true,
    quarantineVerified: true,
    workerFencingVerified: true,
    recoveryClaimBlocked: true,
    productionRpoVerified: true,
    productionRtoVerified: true,
    recovery: { sourceEnvironment: 'production', archiveSha256: 'b'.repeat(64) },
  };
  expect(validateProductionDrill(evidence)).toBeInstanceOf(Date);
  expect(() => validateProductionDrill({ ...evidence, productionRpoVerified: false })).toThrow(
    'productionRpoVerified',
  );
});

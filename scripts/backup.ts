import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const MAGIC = Buffer.from('AA01');
/** Atestación operativa revisada; el simulacro sintético de CI no acredita recuperación cloud. */
export function validateProductionDrill(evidence: Record<string, unknown>) {
  const at = Date.parse(String(evidence.at ?? ''));
  if (
    !Number.isFinite(at) ||
    at > Date.now() + 60000 ||
    Date.now() - at > 30 * 86400000 ||
    evidence.synthetic !== false
  )
    throw new Error('El simulacro debe ser real, reciente y revisado');
  for (const field of [
    'runtimeRlsVerified',
    'encryptedCredentialRoundtrip',
    'tamperRejectedBeforeSql',
    'quarantineVerified',
    'workerFencingVerified',
    'recoveryClaimBlocked',
    'productionRpoVerified',
    'productionRtoVerified',
  ])
    if (evidence[field] !== true) throw new Error(`Simulacro incompleto: ${field}`);
  const recovery = evidence.recovery as Record<string, unknown> | undefined;
  if (
    recovery?.sourceEnvironment !== 'production' ||
    !/^[a-f0-9]{64}$/.test(String(recovery.archiveSha256 ?? ''))
  )
    throw new Error('Falta evidencia del archivo de producción restaurado');
  return new Date(at);
}
function keyOf(key: string) {
  const b = Buffer.from(key, 'base64');
  if (b.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY debe tener 32 bytes base64');
  return b;
}
export function pgEnvironment(url: string) {
  const u = new URL(url);
  if (!/^postgres(?:ql)?:$/.test(u.protocol) || !/^\/[\w-]+$/.test(u.pathname))
    throw new Error('Conexión Postgres inválida');
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGDATABASE: u.pathname.slice(1),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGSSLMODE:
      u.searchParams.get('sslmode') ??
      (['localhost', '127.0.0.1'].includes(u.hostname) ? 'disable' : 'verify-full'),
  };
}
function pgTool(tool: 'pg_dump' | 'pg_restore', args: string[], url: string) {
  const p = spawn(tool, args, {
    env: pgEnvironment(url),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  p.stderr.resume(); // No registrar SQL, datos, argumentos ni mensajes del proveedor.
  const done = new Promise<void>((ok, fail) => {
    p.once('error', () => fail(new Error(`${tool} no disponible`)));
    p.once('close', (code) =>
      code === 0 ? ok() : fail(new Error(`${tool} falló (código ${code})`)),
    );
  });
  return { p, done };
}
async function privileged(client: pg.Client) {
  const { rows } = await client.query(
    'select rolsuper or rolbypassrls as allowed from pg_roles where rolname=current_user',
  );
  if (!rows[0]?.allowed)
    throw new Error(
      'El backup/restaurador necesita un rol operativo con BYPASSRLS, separado del runtime.',
    );
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const b of createReadStream(path)) hash.update(b);
  return hash.digest('hex');
}
export async function backupDatabase(input: {
  url: string;
  environment: string;
  directory: string;
  key: string;
}) {
  const client = new pg.Client({ connectionString: input.url });
  await client.connect();
  const createdAt = new Date().toISOString();
  let path: string | undefined;
  try {
    await privileged(client);
    const { rows } = await client.query('select environment from deployment_state where id=1');
    if (rows[0]?.environment !== input.environment)
      throw new Error('Entorno de origen distinto al solicitado');
    await mkdir(input.directory, { recursive: true });
    path = resolve(
      input.directory,
      `ad-astra-${createdAt.replaceAll(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.aab`,
    );
    const iv = randomBytes(12),
      header = Buffer.from(
        JSON.stringify({
          version: 1,
          algorithm: 'aes-256-gcm',
          environment: input.environment,
          createdAt,
          iv: iv.toString('base64'),
        }),
      ),
      size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    const cipher = createCipheriv('aes-256-gcm', keyOf(input.key), iv);
    cipher.setAAD(header);
    await writeFile(path, Buffer.concat([MAGIC, size, header]), { flag: 'wx', mode: 0o600 });
    const dump = pgTool('pg_dump', ['--format=custom', '--compress=6', '--no-owner'], input.url);
    // Adjuntar el rechazo desde el principio evita promesas huérfanas si falla el proceso.
    const result = await Promise.allSettled([
      pipeline(dump.p.stdout, cipher, createWriteStream(path, { flags: 'a' })),
      dump.done,
    ]);
    const failure = result.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    await appendFile(path, cipher.getAuthTag());
    const evidence = {
      version: 1,
      createdAt,
      environment: input.environment,
      file: basename(path),
      bytes: (await stat(path)).size,
      sha256: await digest(path),
    };
    await writeFile(`${path}.json`, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
    return { path, ...evidence };
  } catch (error) {
    if (path) await rm(path, { force: true });
    throw error;
  } finally {
    await client.end();
  }
}
/** La exportación local no acredita una copia externa. Solo se marca tras verificar el recibo S3. */
export async function attestBackup(url: string, evidencePath: string, receiptPath: string) {
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')),
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const retention = Date.parse(receipt.ObjectLockRetainUntilDate ?? '');
  if (
    !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') ||
    receipt.Metadata?.sha256 !== evidence.sha256 ||
    receipt.ContentLength !== evidence.bytes ||
    !receipt.VersionId ||
    receipt.VersionId === 'null' ||
    !['GOVERNANCE', 'COMPLIANCE'].includes(receipt.ObjectLockMode) ||
    !Number.isFinite(retention) ||
    retention < Date.now() + 7 * 86400000
  )
    throw new Error(
      'La copia externa no demuestra integridad, versión y retención mínima de 7 días',
    );
  const created = Date.parse(evidence.createdAt ?? '');
  if (!Number.isFinite(created) || created > Date.now() + 60000 || Date.now() - created > 86400000)
    throw new Error('Evidencia de backup inválida o antigua');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await privileged(client);
    const { rows } = await client.query('select environment from deployment_state where id=1');
    if (rows[0]?.environment !== evidence.environment)
      throw new Error('Entorno de evidencia incompatible');
    await client.query('update deployment_state set backup_at=$1,updated_at=now() where id=1', [
      evidence.createdAt,
    ]);
    return { verified: true, createdAt: evidence.createdAt, sha256: evidence.sha256 };
  } finally {
    await client.end();
  }
}
async function decryptArchive(path: string, key: string, out: string) {
  const file = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(8);
    await file.read(prefix, 0, 8, 0);
    if (!prefix.subarray(0, 4).equals(MAGIC)) throw new Error('Formato de backup inválido');
    const n = prefix.readUInt32BE(4),
      total = (await file.stat()).size;
    if (n < 20 || n > 4096 || total < 8 + n + 16) throw new Error('Cabecera inválida');
    const header = Buffer.alloc(n);
    await file.read(header, 0, n, 8);
    const metadata = JSON.parse(header.toString());
    if (metadata.version !== 1 || metadata.algorithm !== 'aes-256-gcm')
      throw new Error('Versión de backup no soportada');
    const tag = Buffer.alloc(16);
    await file.read(tag, 0, 16, total - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyOf(key),
      Buffer.from(metadata.iv, 'base64'),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(path, { start: 8 + n, end: total - 17 }),
      decipher,
      createWriteStream(out, { flags: 'wx', mode: 0o600 }),
    );
    return metadata as { createdAt: string; environment: string };
  } finally {
    await file.close();
  }
}
/** Después de PITR también debe ejecutarse esta cuarentena antes de reabrir tráfico. */
export async function quarantineRestore(client: pg.Client, environment: string) {
  await client.query('begin');
  try {
    await client.query(
      'update deployment_state set environment=$1,recovery_mode=true,worker_started_at=null,worker_finished_at=null,restore_drill_at=null,updated_at=now() where id=1',
      [environment],
    );
    await client.query(
      "update jobs set status='failed',lease_id=null,locked_until=null,recurring_every_seconds=null,last_error='Restauración: trabajo en cuarentena',updated_at=now() where status in ('queued','running')",
    );
    const { rows } = await client.query(
      "update actions set state='failed',result='unknown',dispatch_at=coalesce(dispatch_at,now()),error='Restauración: conciliar Meta antes de cualquier envío',revision=revision+1,updated_at=now() where state in ('approved','executing','verifying') returning tenant_id,id",
    );
    for (const a of rows)
      await client.query(
        "insert into action_events(tenant_id,action_id,event,data) values($1,$2,'restore_quarantined','{\"noResend\":true}')",
        [a.tenant_id, a.id],
      );
    await client.query(
      "update monitoring_deliveries set status=case when status='sending' then 'unknown' else 'cancelled' end,error='Restauración: no reenviar sin conciliación',updated_at=now() where status in ('queued','sending')",
    );
    await client.query(
      "update llm_budget_holds set status='unknown',updated_at=now() where status='reserved'",
    );
    await client.query('delete from auth_sessions');
    await client.query(
      'update invitations set revoked_at=now() where accepted_at is null and revoked_at is null',
    );
    await client.query(
      "insert into audit_log(tenant_id,actor_type,action,after) select id,'system','operations.restore_quarantined','{\"accessReviewRequired\":true,\"noAutomaticReplay\":true}'::jsonb from tenants",
    );
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}
export async function restoreDatabase(input: {
  url: string;
  archive: string;
  key: string;
  environment: string;
  ownerRole?: string;
}) {
  if (!['development', 'test', 'staging', 'production'].includes(input.environment))
    throw new Error('Entorno de destino obligatorio');
  const client = new pg.Client({ connectionString: input.url });
  await client.connect();
  const folder = await mkdtemp(join(tmpdir(), 'ad-astra-restore-'));
  if (
    dirname(resolve(folder)) !== resolve(tmpdir()) ||
    !basename(folder).startsWith('ad-astra-restore-')
  )
    throw new Error('Directorio temporal fuera del alcance');
  await chmod(folder, 0o700);
  const plaintext = join(folder, 'verified.dump');
  const started = performance.now();
  try {
    await privileged(client);
    const { rows } = await client.query(
      "select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p')",
    );
    if (rows[0]?.n !== 0)
      throw new Error(
        'La restauración solo acepta una base vacía nueva. No sobrescribe bases existentes.',
      );
    const metadata = await decryptArchive(input.archive, input.key, plaintext); // Autenticación completa ANTES de ejecutar SQL.
    const owner = input.ownerRole ?? 'app_owner';
    if (!/^[a-z_][a-z0-9_]*$/.test(owner)) throw new Error('Rol propietario inválido');
    const restore = pgTool(
      'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        `--role=${owner}`,
        '--dbname',
        new URL(input.url).pathname.slice(1),
        plaintext,
      ],
      input.url,
    );
    restore.p.stdout.resume();
    await restore.done;
    await quarantineRestore(client, input.environment);
    return {
      sourceCreatedAt: metadata.createdAt,
      sourceEnvironment: metadata.environment,
      environment: input.environment,
      quarantined: true,
      durationMs: Math.round(performance.now() - started),
      archiveSha256: await digest(input.archive),
    };
  } finally {
    await client.end();
    await rm(folder, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const mode = process.argv[2],
    key = process.env.BACKUP_ENCRYPTION_KEY ?? '';
  try {
    if (mode === 'attest')
      console.log(
        JSON.stringify(
          await attestBackup(
            process.env.BACKUP_DATABASE_URL ?? '',
            process.env.BACKUP_EVIDENCE_FILE ?? '',
            process.env.BACKUP_RECEIPT_FILE ?? '',
          ),
        ),
      );
    else if (mode === 'create')
      console.log(
        JSON.stringify(
          await backupDatabase({
            url: process.env.BACKUP_DATABASE_URL ?? '',
            environment: process.env.APP_ENV ?? '',
            directory: process.env.BACKUP_DIRECTORY ?? 'spike-output/backups',
            key,
          }),
        ),
      );
    else if (mode === 'restore')
      console.log(
        JSON.stringify(
          await restoreDatabase({
            url: process.env.RESTORE_DATABASE_URL ?? '',
            archive: process.env.BACKUP_ARCHIVE ?? '',
            environment: process.env.APP_ENV ?? '',
            key,
            ownerRole: process.env.RESTORE_OWNER_ROLE,
          }),
        ),
      );
    else throw new Error('Uso: backup.ts create|restore|attest');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Operación de backup fallida');
    process.exitCode = 1;
  }
}

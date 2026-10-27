import { and, eq, getTableColumns, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import {
  adAccounts,
  ads,
  adsets,
  campaigns,
  clientConsents,
  insightsDaily,
  LEVELS,
  type Level,
  metaConnections,
  type SyncKind,
  syncRuns,
} from '../../db/schema.ts';
import type { TokenCipher } from '../../platform/crypto.ts';
import { recordEvent } from '../../platform/events.ts';
import {
  cancelQueued,
  enqueue,
  type Job,
  type JobHandler,
  type JobOutcome,
} from '../../platform/jobs.ts';
import { redact } from '../../platform/logging.ts';
import {
  createMetaClient,
  META_API_VERSION,
  MetaApiError,
  MetaNetworkError,
  requestsLessData,
} from './client.ts';
import { AD_LEVEL_INSIGHTS_FIELDS, FIELDS } from './fields.ts';
import { createGovernor, createMetaSession, type MetaSession, ThrottledError } from './governor.ts';
import { addDays, decimal, localDate, monthRange, splitRange, toInsightRow } from './insights.ts';

// Sincronización con Meta (docs/API_INTEGRATIONS.md §1.15): un handler por tipo de trabajo.
//   - Cada ejecución deja un sync_run con versión de API, ventana, llamadas, filas y error
//     redactado (CA-F1-08).
//   - Se escribe por bloques atómicos (un nivel de Insights, un tipo de entidad) y siempre con
//     upsert por clave natural: repetir un sync no cambia nada (CA-F1-01).
//   - Cuota agotada → se reprograma sin gastar intento (CA-F1-05). Token inválido → conexión
//     `invalid` y sus trabajos se detienen (CA-F1-04).
// ponytail: todo en síncrono, partiendo el rango si Meta dice "demasiados datos". Los informes
// asíncronos para la reexpresión de cuentas grandes y el backfill llegan si el spike lo pide (TD-16).

export interface SyncDeps {
  db: Db;
  cipher: TokenCipher;
  meta: { appId: string; appSecret: string };
  log: Logger;
  /** Inyectable para tests: sin red real ni credenciales en la CI. */
  fetch?: typeof fetch;
  /** Pausa ante uso alto de cuota (false en tests). */
  pace?: boolean;
}

const EVERY: Partial<Record<SyncKind, number>> = {
  token_validation: 86_400,
  discovery: 86_400,
  entities: 7_200,
  insights_incremental: 3_600,
  insights_restatement: 86_400,
};
const ACCOUNT_KINDS = ['entities', 'insights_incremental', 'insights_restatement'] as const;
const PAGE = 500;

const jobKey = (owner: 'connection' | 'account', id: string, kind: SyncKind) =>
  `${owner}:${id}:${kind}`;

/** AAD del cifrado del token: liga el texto cifrado a su tenant y su conexión. */
export const tokenAad = (tenantId: string, connectionId: string) =>
  `meta_connections:${tenantId}:${connectionId}`;

/** Descifra el token de una conexión. Solo lo usa la sincronización, nunca una ruta HTTP. */
export function openConnectionToken(
  cipher: TokenCipher,
  row: typeof metaConnections.$inferSelect,
): string {
  return cipher.open(
    { ciphertext: row.tokenCiphertext, nonce: row.tokenNonce, keyVersion: row.tokenKeyVersion },
    tokenAad(row.tenantId, row.id),
  );
}

/** Validación del token (al dar de alta la conexión y luego a diario). Tras validar, descubre cuentas. */
export const enqueueTokenValidation = (tx: Db | Tx, tenantId: string, connectionId: string) =>
  enqueue(tx, {
    tenantId,
    kind: 'token_validation',
    payload: { connectionId },
    dedupeKey: jobKey('connection', connectionId, 'token_validation'),
    recurringEverySeconds: EVERY.token_validation,
  });

/** Trabajos recurrentes de una cuenta con la sincronización activa (idempotente). */
export async function ensureAccountJobs(
  tx: Db | Tx,
  tenantId: string,
  adAccountId: string,
  opts: { backfill?: boolean } = {},
): Promise<void> {
  for (const kind of ACCOUNT_KINDS) {
    await enqueue(tx, {
      tenantId,
      kind,
      payload: { adAccountId },
      dedupeKey: jobKey('account', adAccountId, kind),
      recurringEverySeconds: EVERY[kind],
    });
  }
  if (opts.backfill) {
    await enqueue(tx, {
      tenantId,
      kind: 'insights_backfill',
      payload: { adAccountId, monthsDone: 0 },
      dedupeKey: jobKey('account', adAccountId, 'insights_backfill'),
    });
  }
}

/**
 * Consentimiento contractual para leer los datos (docs/SECURITY.md §4.7): sin un `read_insights`
 * activo del cliente de la cuenta no se sincroniza. Una cuenta sin cliente no tiene consentimiento.
 */
export async function hasReadConsent(tx: Tx, clientId: string | null): Promise<boolean> {
  if (!clientId) return false;
  const [row] = await tx
    .select({ id: clientConsents.id })
    .from(clientConsents)
    .where(
      and(
        eq(clientConsents.clientId, clientId),
        isNull(clientConsents.revokedAt),
        sql`'read_insights' = any(${clientConsents.scope})`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export const cancelAccountJobs = (tx: Db | Tx, adAccountId: string) =>
  cancelQueued(tx, `account:${adAccountId}:`);
export const cancelConnectionJobs = (tx: Db | Tx, connectionId: string) =>
  cancelQueued(tx, `connection:${connectionId}:`);

/** SET de un upsert: todas las columnas salvo la clave, con el valor nuevo (`excluded`). */
function excludedSet(table: PgTable, keep: string[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([key]) => !keep.includes(key))
      .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );
}

function chunks<T>(rows: T[], size = PAGE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const minor = (v: unknown): number | null => {
  const d = decimal(v);
  return d === null ? null : Number(d);
};
const json = (v: unknown) => (v === undefined ? null : v);

// Campos de Insights por nivel: solo los identificadores hasta ese nivel.
const ID_FIELDS: Record<Level, string[]> = {
  account: ['account_id'],
  campaign: ['account_id', 'campaign_id'],
  adset: ['account_id', 'campaign_id', 'adset_id'],
  ad: ['account_id', 'campaign_id', 'adset_id', 'ad_id'],
};
const ALL_IDS = new Set(ID_FIELDS.ad);
const insightFields = (level: Level) =>
  [
    ...ID_FIELDS[level],
    ...FIELDS.AdsInsights.filter((f) => !ALL_IDS.has(f)),
    ...(level === 'ad' ? AD_LEVEL_INSIGHTS_FIELDS : []),
  ].join(',');

interface Run {
  id: number;
  rows: number;
  session?: MetaSession;
}

type Connection = typeof metaConnections.$inferSelect;
type Account = typeof adAccounts.$inferSelect;

export function createSyncHandlers(deps: SyncDeps): Record<SyncKind, JobHandler> {
  const { db } = deps;
  const inTenant = <T>(job: Job, fn: (tx: Tx) => Promise<T>) =>
    withContext(db, { tenantId: job.tenantId }, fn);
  const payload = (job: Job) =>
    (job.payload ?? {}) as { connectionId?: string; adAccountId?: string; monthsDone?: number };

  function sessionFor(
    connection: Connection,
    metaAccountId?: string,
    accessToken?: string,
  ): MetaSession {
    const client = createMetaClient({
      accessToken: accessToken ?? openConnectionToken(deps.cipher, connection),
      appSecret: deps.meta.appSecret,
      fetch: deps.fetch,
    });
    return createMetaSession({
      client,
      governor: createGovernor(db, connection.metaAppId),
      metaAccountId,
      pace: deps.pace,
    });
  }

  /** La conexión deja de usarse: estado `invalid`, evento y fuera sus trabajos en cola. */
  async function invalidate(job: Job, connectionId: string, reason: string, errorCode?: number) {
    await inTenant(job, async (tx) => {
      const [row] = await tx
        .update(metaConnections)
        .set({ status: 'invalid', lastErrorCode: errorCode ?? null, lastValidatedAt: new Date() })
        .where(
          and(
            eq(metaConnections.id, connectionId),
            inArray(metaConnections.status, ['pending', 'active']),
          ),
        )
        .returning({ id: metaConnections.id });
      if (row) {
        // ponytail: la alerta crítica de CA-F1-04 la abre el módulo de alertas (F4) a partir de este evento.
        await recordEvent(
          tx,
          { tenantId: job.tenantId, actorType: 'system', actorId: 'sync' },
          {
            action: 'meta_connection.invalidated',
            targetType: 'meta_connection',
            targetId: connectionId,
            after: { reason, errorCode },
          },
        );
      }
      await cancelConnectionJobs(tx, connectionId);
    });
  }

  /** Error → resultado del trabajo y estado del sync_run. */
  async function failure(
    job: Job,
    err: unknown,
    connectionId: string,
    authInvalidates: boolean,
  ): Promise<{ outcome: JobOutcome; status: 'failed' | 'throttled' }> {
    const message = redact(err instanceof Error ? err.message : String(err));
    const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
    if (err instanceof ThrottledError) {
      return {
        status: 'throttled',
        outcome: { type: 'reschedule', runAfter: err.until, reason: message },
      };
    }
    if (!(err instanceof MetaApiError)) {
      // Red, base de datos o un fallo nuestro: reintento con backoff.
      return { status: 'failed', outcome: { type: 'retry', error: message } };
    }
    const action = err.action;
    switch (action.kind) {
      case 'retry':
        return { status: 'failed', outcome: { type: 'retry', error: message } };
      case 'reschedule':
        return {
          status: 'throttled',
          outcome: { type: 'reschedule', runAfter: later(action.minSeconds), reason: message },
        };
      case 'throttle': // la sesión ya lo convierte en ThrottledError; por si acaso
        return {
          status: 'throttled',
          outcome: { type: 'reschedule', runAfter: later(300), reason: message },
        };
      case 'auth':
        if (authInvalidates) await invalidate(job, connectionId, 'auth_error', err.code);
        return { status: 'failed', outcome: { type: 'stop', error: message } };
      default:
        return { status: 'failed', outcome: { type: 'stop', error: message } };
    }
  }

  /** Ejecuta `work` registrando un sync_run con su resultado. */
  async function tracked(
    job: Job,
    base: {
      kind: SyncKind;
      connectionId: string;
      adAccountId?: string;
      windowStart?: string;
      windowEnd?: string;
    },
    work: (run: Run) => Promise<JobOutcome>,
    authInvalidates = true,
  ): Promise<JobOutcome> {
    const { id } = first(
      await inTenant(job, (tx) =>
        tx
          .insert(syncRuns)
          .values({ ...base, tenantId: job.tenantId, apiVersion: META_API_VERSION, jobId: job.id })
          .returning({ id: syncRuns.id }),
      ),
    );
    const run: Run = { id, rows: 0 };
    let outcome: JobOutcome;
    let status: 'succeeded' | 'partial' | 'failed' | 'throttled' = 'succeeded';
    let error: { errorCode?: number; errorSubcode?: number; errorMessage?: string } = {};
    try {
      outcome = await work(run);
    } catch (err) {
      const f = await failure(job, err, base.connectionId, authInvalidates);
      outcome = f.outcome;
      status = f.status === 'failed' && run.rows > 0 ? 'partial' : f.status;
      error = {
        errorCode: err instanceof MetaApiError ? err.code : undefined,
        errorSubcode: err instanceof MetaApiError ? err.subcode : undefined,
        errorMessage: redact(err instanceof Error ? err.message : String(err)).slice(0, 1000),
      };
      deps.log.warn(
        { kind: base.kind, run: id, status, code: error.errorCode, subcode: error.errorSubcode },
        'sincronización sin completar',
      );
    }
    await inTenant(job, (tx) =>
      tx
        .update(syncRuns)
        .set({
          status,
          finishedAt: new Date(),
          apiCalls: run.session?.calls ?? 0,
          rowsUpserted: run.rows,
          ...error,
        })
        .where(eq(syncRuns.id, id)),
    );
    return outcome;
  }

  // --- Trabajos de una conexión

  const connectionJob =
    (
      kind: 'token_validation' | 'discovery',
      work: (job: Job, c: Connection, run: Run) => Promise<JobOutcome>,
      authInvalidates = true,
    ): JobHandler =>
    async (job) => {
      const connectionId = payload(job).connectionId ?? '';
      const [connection] = await inTenant(job, (tx) =>
        tx.select().from(metaConnections).where(eq(metaConnections.id, connectionId)),
      );
      if (!connection || connection.status === 'revoked')
        return { type: 'end', reason: 'conexión revocada o inexistente' };
      if (kind === 'discovery' && connection.status !== 'active') {
        return { type: 'end', reason: `conexión ${connection.status}` };
      }
      return tracked(
        job,
        { kind, connectionId },
        (run) => work(job, connection, run),
        authInvalidates,
      );
    };

  const tokenValidation = connectionJob(
    'token_validation',
    async (job, connection, run) => {
      if (connection.metaAppId !== deps.meta.appId) {
        await invalidate(job, connection.id, 'app_mismatch');
        return { type: 'stop', error: 'La conexión es de otra app de Meta' };
      }
      // debug_token se consulta con el token de la app; el de la conexión va como input_token.
      run.session = sessionFor(connection, undefined, `${deps.meta.appId}|${deps.meta.appSecret}`);
      const { body } = await run.session.get<{ data?: Raw }>('/debug_token', {
        input_token: openConnectionToken(deps.cipher, connection),
      });
      const d = body.data ?? {};
      const scopes = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
      const problem =
        d.is_valid !== true
          ? 'token_invalid'
          : String(d.app_id) !== connection.metaAppId
            ? 'app_mismatch'
            : !scopes.includes('ads_read')
              ? 'missing_ads_read'
              : null;
      if (problem) {
        await invalidate(job, connection.id, problem);
        return { type: 'stop', error: `Token rechazado: ${problem}` };
      }
      const expiresAt =
        typeof d.expires_at === 'number' && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null;
      await inTenant(job, async (tx) => {
        await tx
          .update(metaConnections)
          .set({
            status: 'active',
            scopes,
            expiresAt,
            lastValidatedAt: new Date(),
            lastErrorCode: null,
          })
          .where(eq(metaConnections.id, connection.id));
        if (connection.status !== 'active') {
          await recordEvent(
            tx,
            { tenantId: job.tenantId, actorType: 'system', actorId: 'sync' },
            {
              action: 'meta_connection.validated',
              targetType: 'meta_connection',
              targetId: connection.id,
              after: { scopes },
            },
          );
        }
        await enqueue(tx, {
          tenantId: job.tenantId,
          kind: 'discovery',
          payload: { connectionId: connection.id },
          dedupeKey: jobKey('connection', connection.id, 'discovery'),
          recurringEverySeconds: EVERY.discovery,
        });
      });
      return { type: 'done' };
    },
    // Un 190 aquí es del token de la APP (secreto mal configurado), no de la conexión.
    false,
  );

  const discovery = connectionJob('discovery', async (job, connection, run) => {
    run.session = sessionFor(connection);
    const found = (
      await run.session.getAll<Raw>('/me/adaccounts', {
        fields: FIELDS.AdAccount.join(','),
        limit: PAGE,
      })
    ).filter((a) => typeof a.id === 'string' && /^act_\d+$/.test(a.id));
    const now = new Date();
    await inTenant(job, async (tx) => {
      for (const batch of chunks(found)) {
        const rows = await tx
          .insert(adAccounts)
          .values(
            batch.map((a) => ({
              tenantId: job.tenantId,
              connectionId: connection.id,
              metaAccountId: String(a.id),
              name: str(a.name) ?? String(a.id),
              currency: str(a.currency) ?? 'XXX',
              timezoneName: str(a.timezone_name) ?? 'UTC',
              accountStatus: Number(a.account_status ?? 0),
              userTasks: Array.isArray(a.user_tasks) ? a.user_tasks.map(String) : [],
              lastDiscoveredAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [adAccounts.tenantId, adAccounts.metaAccountId],
            set: excludedSet(adAccounts, [
              'id',
              'tenantId',
              'metaAccountId',
              'clientId',
              'syncEnabled',
              'backfillMonths',
              'lastEntitiesSyncAt',
              'lastInsightsSyncAt',
              'createdAt',
            ]),
          })
          .returning({ id: adAccounts.id, syncEnabled: adAccounts.syncEnabled });
        for (const r of rows) if (r.syncEnabled) await ensureAccountJobs(tx, job.tenantId, r.id);
      }
    });
    run.rows = found.length;
    return { type: 'done' };
  });

  // --- Trabajos de una cuenta

  const accountJob =
    (
      kind: Exclude<SyncKind, 'token_validation' | 'discovery'>,
      work: (
        job: Job,
        ctx: { account: Account; connection: Connection; today: string },
        run: Run,
      ) => Promise<JobOutcome>,
      window?: (
        today: string,
        account: Account,
        job: Job,
      ) => { since: string; until: string } | null,
    ): JobHandler =>
    async (job) => {
      const adAccountId = payload(job).adAccountId ?? '';
      const { row, consent } = await inTenant(job, async (tx) => {
        const [row] = await tx
          .select({ account: adAccounts, connection: metaConnections })
          .from(adAccounts)
          .innerJoin(metaConnections, eq(metaConnections.id, adAccounts.connectionId))
          .where(eq(adAccounts.id, adAccountId));
        return { row, consent: row ? await hasReadConsent(tx, row.account.clientId) : false };
      });
      if (!row) return { type: 'end', reason: 'la cuenta no existe' };
      if (!row.account.syncEnabled) return { type: 'end', reason: 'sincronización desactivada' };
      // Revocado el consentimiento, lo pendiente termina sin llamar a Meta.
      if (!consent) return { type: 'end', reason: 'sin consentimiento read_insights' };
      if (row.connection.status !== 'active')
        return { type: 'end', reason: `conexión ${row.connection.status}` };
      const today = localDate(row.account.timezoneName);
      const w = window?.(today, row.account, job);
      return tracked(
        job,
        {
          kind,
          connectionId: row.connection.id,
          adAccountId,
          windowStart: w?.since,
          windowEnd: w?.until,
        },
        (run) => work(job, { ...row, today }, run),
      );
    };

  const entities = accountJob('entities', async (job, { account, connection }, run) => {
    const session = sessionFor(connection, account.metaAccountId);
    run.session = session;
    const startedAt = new Date();
    const list = (edge: string, fields: readonly string[]) =>
      session.getAll<Raw>(`/${account.metaAccountId}/${edge}`, {
        fields: fields.join(','),
        limit: PAGE,
      });
    const common = (r: Raw) => ({
      tenantId: job.tenantId,
      metaId: String(r.id),
      adAccountId: account.id,
      name: str(r.name) ?? String(r.id),
      status: str(r.status),
      effectiveStatus: str(r.effective_status),
      raw: r,
      lastSyncedAt: new Date(),
      deletedAt: null,
    });
    const KEEP = ['tenantId', 'metaId', 'firstSeenAt'];

    // Cada tipo en su transacción, después de leer TODAS sus páginas: un listado a medias nunca
    // se escribe ni marca como borrado lo que no llegó.
    async function save(
      table: typeof campaigns | typeof adsets | typeof ads,
      rows: Array<Record<string, unknown>>,
    ) {
      await inTenant(job, async (tx) => {
        for (const batch of chunks(rows)) {
          await tx
            .insert(table)
            .values(batch as never)
            .onConflictDoUpdate({
              target: [table.tenantId, table.metaId],
              set: excludedSet(table, KEEP),
            });
        }
        // Lo que Meta ya no lista (borrado o archivado) se marca, no se borra.
        await tx
          .update(table)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(table.adAccountId, account.id),
              isNull(table.deletedAt),
              lt(table.lastSyncedAt, startedAt),
            ),
          );
      });
      run.rows += rows.length;
    }

    await save(
      campaigns,
      (await list('campaigns', FIELDS.Campaign)).map((r) => ({
        ...common(r),
        objective: str(r.objective),
        dailyBudgetMinor: minor(r.daily_budget),
        lifetimeBudgetMinor: minor(r.lifetime_budget),
        advantageState: str((r.advantage_state_info as Raw | undefined)?.advantage_state),
      })),
    );
    await save(
      adsets,
      (await list('adsets', FIELDS.AdSet)).map((r) => ({
        ...common(r),
        campaignMetaId: String(r.campaign_id),
        optimizationGoal: str(r.optimization_goal),
        billingEvent: str(r.billing_event),
        bidStrategy: str(r.bid_strategy),
        bidAmountMinor: minor(r.bid_amount),
        dailyBudgetMinor: minor(r.daily_budget),
        lifetimeBudgetMinor: minor(r.lifetime_budget),
        destinationType: str(r.destination_type),
        promotedObject: json(r.promoted_object),
        attributionSpec: json(r.attribution_spec),
        learningStageInfo: json(r.learning_stage_info),
      })),
    );
    await save(
      ads,
      (await list('ads', FIELDS.Ad)).map((r) => ({
        ...common(r),
        adsetMetaId: String(r.adset_id),
        campaignMetaId: String(r.campaign_id),
        creativeMetaId: str((r.creative as Raw | undefined)?.id),
        issuesInfo: json(r.issues_info),
      })),
    );
    await inTenant(job, (tx) =>
      tx
        .update(adAccounts)
        .set({ lastEntitiesSyncAt: new Date() })
        .where(eq(adAccounts.id, account.id)),
    );
    return { type: 'done' };
  });

  /** Todas las filas de un nivel y rango. Si Meta pide menos datos (100/1487534), parte el rango. */
  async function fetchInsights(
    session: MetaSession,
    metaAccountId: string,
    level: Level,
    since: string,
    until: string,
  ): Promise<Raw[]> {
    try {
      return await session.getAll<Raw>(
        `/${metaAccountId}/insights`,
        {
          level,
          time_increment: 1,
          time_range: JSON.stringify({ since, until }),
          fields: insightFields(level),
          limit: PAGE,
        },
        true,
      );
    } catch (err) {
      const halves =
        requestsLessData(err) || (err instanceof MetaNetworkError && err.timedOut)
          ? splitRange(since, until)
          : null;
      if (!halves) throw err;
      return [
        ...(await fetchInsights(session, metaAccountId, level, ...halves[0])),
        ...(await fetchInsights(session, metaAccountId, level, ...halves[1])),
      ];
    }
  }

  async function syncInsights(
    job: Job,
    account: Account,
    connection: Connection,
    today: string,
    since: string,
    until: string,
    run: Run,
  ) {
    const session = sessionFor(connection, account.metaAccountId);
    run.session = session;
    for (const level of LEVELS) {
      const fetchedAt = new Date();
      const rows = (await fetchInsights(session, account.metaAccountId, level, since, until)).map(
        (r) =>
          toInsightRow(r, {
            tenantId: job.tenantId,
            adAccountId: account.id,
            metaAccountId: account.metaAccountId,
            currency: account.currency,
            level,
            today,
            syncRunId: run.id,
            fetchedAt,
          }),
      );
      // Un nivel completo por transacción: o se actualiza entero o no se toca.
      await inTenant(job, async (tx) => {
        for (const batch of chunks(rows)) {
          await tx
            .insert(insightsDaily)
            .values(batch)
            .onConflictDoUpdate({
              target: [
                insightsDaily.tenantId,
                insightsDaily.level,
                insightsDaily.entityMetaId,
                insightsDaily.date,
              ],
              set: excludedSet(insightsDaily, ['tenantId', 'level', 'entityMetaId', 'date']),
            });
        }
      });
      run.rows += rows.length;
    }
    // Datos nuevos: se reevalúa la cuenta (un solo trabajo de auditoría en cola por cuenta).
    await inTenant(job, async (tx) => {
      await tx
        .update(adAccounts)
        .set({ lastInsightsSyncAt: new Date() })
        .where(eq(adAccounts.id, account.id));
      await enqueue(tx, {
        tenantId: job.tenantId,
        kind: 'audit',
        payload: { adAccountId: account.id },
        dedupeKey: `account:${account.id}:audit`,
      });
    });
  }

  const incrementalWindow = (today: string) => ({ since: addDays(today, -1), until: today });
  const restatementWindow = (today: string) => ({
    since: addDays(today, -28),
    until: addDays(today, -1),
  });
  // Backfill de mes en mes hacia atrás (el mes 0 es el actual hasta ayer). El progreso va en el payload.
  const backfillWindow = (today: string, account: Account, job: Job) => {
    const k = payload(job).monthsDone ?? 0;
    if (k >= account.backfillMonths) return null;
    const { since, until } = monthRange(today, k);
    const yesterday = addDays(today, -1);
    // biome-ignore lint/complexity/useMathMinMax: son fechas 'YYYY-MM-DD' (strings), no números
    return { since, until: until < yesterday ? until : yesterday };
  };

  return {
    token_validation: tokenValidation,
    discovery,
    entities,
    insights_incremental: accountJob(
      'insights_incremental',
      async (job, { account, connection, today }, run) => {
        const w = incrementalWindow(today);
        await syncInsights(job, account, connection, today, w.since, w.until, run);
        return { type: 'done' };
      },
      incrementalWindow,
    ),
    insights_restatement: accountJob(
      'insights_restatement',
      async (job, { account, connection, today }, run) => {
        const w = restatementWindow(today);
        await syncInsights(job, account, connection, today, w.since, w.until, run);
        return { type: 'done' };
      },
      restatementWindow,
    ),
    insights_backfill: accountJob(
      'insights_backfill',
      async (job, { account, connection, today }, run) => {
        const w = backfillWindow(today, account, job);
        if (!w) return { type: 'end', reason: 'backfill completo' };
        if (w.since <= w.until)
          await syncInsights(job, account, connection, today, w.since, w.until, run);
        const monthsDone = (payload(job).monthsDone ?? 0) + 1;
        if (monthsDone >= account.backfillMonths) return { type: 'done' };
        return { type: 'continue', payload: { adAccountId: account.id, monthsDone } };
      },
      backfillWindow,
    ),
  };
}

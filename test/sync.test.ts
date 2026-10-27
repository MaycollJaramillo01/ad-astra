import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { and, eq, like, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Tx, withContext } from '../src/db/client.ts';
import {
  adAccounts,
  ads,
  auditLog,
  auditRuns,
  campaigns,
  clientConsents,
  healthScores,
  insightsDaily,
  jobs,
  metaConnections,
  metaRateState,
  syncRuns,
} from '../src/db/schema.ts';
import { createAuditHandler } from '../src/modules/audit/service.ts';
import { addDays, localDate, monthRange } from '../src/modules/meta/insights.ts';
import {
  createSyncHandlers,
  enqueueTokenValidation,
  ensureAccountJobs,
  tokenAad,
} from '../src/modules/meta/sync.ts';
import { createTokenCipher, fingerprint } from '../src/platform/crypto.ts';
import { runTick } from '../src/platform/jobs.ts';
import { createLogger } from '../src/platform/logging.ts';
import { config } from './app.ts';
import { createFakeMeta } from './fake-meta.ts';
import { seedTenant, testDb } from './seed.ts';

// Sincronización completa (cola → handlers → Meta simulado → Postgres con RLS) sin red ni
// credenciales reales. Cada test usa su tenant y su app de Meta: no comparten cuotas ni trabajos.
const db = testDb();
const cipher = createTokenCipher(config.TOKEN_ENCRYPTION_KEYS, config.TOKEN_ENCRYPTION_KEY_VERSION);
const id = () => String(Math.floor(Math.random() * 1e12));

// 1 cuenta + 2 campañas + 2 conjuntos + 3 anuncios = 8 entidades con Insights por día.
const ENTITIES_PER_DAY = 8;
const today = () => localDate('Europe/Madrid');
// Incremental (ayer y hoy) ∪ reexpresión (28 días hasta ayer) = 29 días.
const RECENT_DAYS = 29;

async function setup(opts: { token?: string; act?: string; scopes?: string[] } = {}) {
  const seeded = await seedTenant(db);
  const tenantId = seeded.tenantId;
  const appId = id();
  const appSecret = randomBytes(16).toString('hex');
  const token = opts.token ?? `EAATEST${randomBytes(16).toString('hex')}`;
  const act = opts.act ?? `act_${id()}`;

  const fake = createFakeMeta({ appId, appSecret });
  fake.state.tokens.set(token, {
    valid: true,
    scopes: opts.scopes ?? ['ads_read', 'business_management'],
  });
  fake.state.accounts = [
    {
      id: act,
      name: 'Cuenta Meta',
      currency: 'EUR',
      timezone_name: 'Europe/Madrid',
      account_status: 1,
      user_tasks: ['ANALYZE'],
    },
  ];
  fake.state.edges.set(`${act}/campaigns`, [
    {
      id: '1001',
      name: 'Leads',
      objective: 'OUTCOME_LEADS',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      daily_budget: '5000',
    },
    {
      id: '1002',
      name: 'Ventas',
      objective: 'OUTCOME_SALES',
      status: 'PAUSED',
      effective_status: 'PAUSED',
    },
  ]);
  fake.state.edges.set(`${act}/adsets`, [
    { id: '2001', campaign_id: '1001', name: 'Conjunto A', optimization_goal: 'LEAD_GENERATION' },
    { id: '2002', campaign_id: '1002', name: 'Conjunto B' },
  ]);
  fake.state.edges.set(`${act}/ads`, [
    {
      id: '3001',
      adset_id: '2001',
      campaign_id: '1001',
      name: 'Anuncio 1',
      creative: { id: '9001' },
    },
    { id: '3002', adset_id: '2001', campaign_id: '1001', name: 'Anuncio 2' },
    { id: '3003', adset_id: '2002', campaign_id: '1002', name: 'Anuncio 3' },
  ]);

  const connectionId = randomUUID();
  const sealed = cipher.seal(token, tokenAad(tenantId, connectionId));
  await withContext(db, { tenantId }, (tx) =>
    tx.insert(metaConnections).values({
      id: connectionId,
      tenantId,
      kind: 'system_user',
      label: 'Meta',
      metaAppId: appId,
      tokenCiphertext: sealed.ciphertext,
      tokenNonce: sealed.nonce,
      tokenKeyVersion: sealed.keyVersion,
      tokenFingerprint: fingerprint(token),
      createdBy: seeded.owner.id,
    }),
  );

  let logs = '';
  const log = createLogger(
    new Writable({
      write(chunk, _enc, done) {
        logs += chunk.toString();
        done();
      },
    }),
    'info',
  );
  // Como en el tick real: la sincronización y el motor de auditoría que se encola tras ella.
  const handlers = {
    ...createSyncHandlers({
      db,
      cipher,
      meta: { appId, appSecret },
      log,
      fetch: fake.fetch,
      pace: false,
    }),
    audit: createAuditHandler(db),
  };
  const q = <T>(fn: (tx: Tx) => Promise<T>) => withContext(db, { tenantId }, fn);

  const s = {
    tenantId,
    appId,
    connectionId,
    act,
    token,
    fake,
    q,
    logs: () => logs,
    tick: () => runTick({ db, handlers, budgetMs: 30_000, log, tenantId }),
    /** Vuelve a poner en hora todos los trabajos en cola (simula el paso del tiempo). */
    due: () =>
      db
        .update(jobs)
        .set({ runAfter: new Date() })
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, 'queued'))),
    jobs: () => db.select().from(jobs).where(eq(jobs.tenantId, tenantId)),
    runs: () =>
      q((tx) =>
        tx
          .select()
          .from(syncRuns)
          .where(eq(syncRuns.connectionId, connectionId))
          .orderBy(syncRuns.id),
      ),
    insights: () =>
      q((tx) => tx.select().from(insightsDaily).where(eq(insightsDaily.adAccountId, s.accountId))),
    accountId: '',
    /** Alta: valida el token y descubre la cuenta. */
    async connect() {
      await enqueueTokenValidation(db, tenantId, connectionId);
      await s.tick();
      const [account] = await q((tx) =>
        tx.select().from(adAccounts).where(eq(adAccounts.metaAccountId, act)),
      );
      if (!account && (opts.scopes ?? ['ads_read']).includes('ads_read'))
        throw new Error(
          `El tick no descubrió la cuenta sintética: ${JSON.stringify({ jobs: await s.jobs(), runs: await s.runs() })}`,
        );
      s.accountId = account?.id ?? '';
      return account;
    },
    /** Asigna la cuenta a un cliente con consentimiento y activa su sincronización (como el PATCH). */
    async enable(opts: { backfill?: boolean; backfillMonths?: number } = {}) {
      await q(async (tx) => {
        await tx.insert(clientConsents).values({
          tenantId,
          clientId: seeded.client.id,
          scope: ['read_insights'],
          grantedByName: 'Cliente',
          grantedByEmail: 'cliente@example.com',
          grantedAt: new Date(),
          recordedBy: seeded.owner.id,
        });
        await tx
          .update(adAccounts)
          .set({
            clientId: seeded.client.id,
            syncEnabled: true,
            ...(opts.backfillMonths !== undefined && { backfillMonths: opts.backfillMonths }),
          })
          .where(eq(adAccounts.id, s.accountId));
        await ensureAccountJobs(tx, tenantId, s.accountId, opts);
      });
    },
  };
  return s;
}

const count = (rows: Array<{ level: string }>, level: string) =>
  rows.filter((r) => r.level === level).length;
const comparable = (rows: Array<typeof insightsDaily.$inferSelect>) =>
  rows
    .map(({ syncRunId: _r, fetchedAt: _f, ...rest }) => rest)
    .sort((a, b) =>
      `${a.level}${a.entityMetaId}${a.date}`.localeCompare(`${b.level}${b.entityMetaId}${b.date}`),
    );

describe('alta de una conexión', () => {
  it('valida el token, descubre las cuentas y no sincroniza nada hasta activarlas', async () => {
    const s = await setup();
    const account = await s.connect();

    const [connection] = await s.q((tx) =>
      tx.select().from(metaConnections).where(eq(metaConnections.id, s.connectionId)),
    );
    expect(connection).toMatchObject({
      status: 'active',
      scopes: ['ads_read', 'business_management'],
      expiresAt: null,
    });
    expect(connection?.lastValidatedAt).toBeInstanceOf(Date);
    expect(account).toMatchObject({
      name: 'Cuenta Meta',
      currency: 'EUR',
      timezoneName: 'Europe/Madrid',
      syncEnabled: false,
    });

    const runs = await s.runs();
    expect(runs.map((r) => [r.kind, r.status, r.apiVersion])).toEqual([
      ['token_validation', 'succeeded', 'v26.0'],
      ['discovery', 'succeeded', 'v26.0'],
    ]);
    expect(runs.map((r) => r.apiCalls)).toEqual([1, 1]);
    expect(runs[1]?.rowsUpserted).toBe(1);

    // Ambos vuelven a la cola para dentro de un día; no hay trabajos de cuenta.
    const queued = await s.jobs();
    expect(queued.map((j) => j.kind).sort()).toEqual(['discovery', 'token_validation']);
    for (const j of queued) {
      expect(j.status).toBe('queued');
      expect(j.runAfter.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    }
  });

  it('un token sin ads_read deja la conexión inválida y no descubre nada', async () => {
    const s = await setup({ scopes: ['business_management'] });
    expect(await s.connect()).toBeUndefined();
    const [connection] = await s.q((tx) =>
      tx.select().from(metaConnections).where(eq(metaConnections.id, s.connectionId)),
    );
    expect(connection?.status).toBe('invalid');
    const events = await s.q((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.targetId, s.connectionId)),
    );
    expect(events.map((e) => [e.action, (e.after as { reason: string }).reason])).toEqual([
      ['meta_connection.invalidated', 'missing_ads_read'],
    ]);
    expect((await s.jobs()).map((j) => [j.kind, j.status])).toEqual([
      ['token_validation', 'failed'],
    ]);
  });
});

describe('sincronización de una cuenta', () => {
  it('trae entidades e Insights en los 4 niveles y repetirla no cambia nada (CA-F1-01)', async () => {
    const s = await setup();
    await s.connect();
    await s.enable();
    await s.tick();

    const rows = await s.insights();
    expect(rows).toHaveLength(RECENT_DAYS * ENTITIES_PER_DAY);
    expect([
      count(rows, 'account'),
      count(rows, 'campaign'),
      count(rows, 'adset'),
      count(rows, 'ad'),
    ]).toEqual([RECENT_DAYS, RECENT_DAYS * 2, RECENT_DAYS * 2, RECENT_DAYS * 3]);
    const yesterday = addDays(today(), -1);
    expect(
      rows.find((r) => r.level === 'ad' && r.entityMetaId === '3001' && r.date === yesterday),
    ).toMatchObject({
      currency: 'EUR',
      spend: '10.5000',
      impressions: 1000,
      leads: '2.0000',
      purchases: '0.0000',
      attributionSetting: '7d_click_1d_view',
      isFinal: false,
      dataFlags: ['immature'],
    });
    expect(rows.find((r) => r.level === 'account')).toMatchObject({
      entityMetaId: s.act,
      campaignMetaId: null,
    });
    // Cada fila guarda sus padres: así se desglosa campaña → conjuntos → anuncios.
    expect(rows.find((r) => r.level === 'ad' && r.entityMetaId === '3003')).toMatchObject({
      campaignMetaId: '1002',
      adsetMetaId: '2002',
    });
    expect(rows.find((r) => r.level === 'adset' && r.entityMetaId === '2001')).toMatchObject({
      campaignMetaId: '1001',
      adsetMetaId: '2001',
    });

    const entityRuns = await s.q((tx) =>
      tx.select().from(campaigns).where(eq(campaigns.adAccountId, s.accountId)),
    );
    expect(entityRuns.map((c) => [c.metaId, c.dailyBudgetMinor, c.deletedAt])).toEqual(
      expect.arrayContaining([
        ['1001', 5000, null],
        ['1002', null, null],
      ]),
    );

    const runs = await s.runs();
    const byKind = Object.fromEntries(runs.map((r) => [r.kind, r]));
    expect(byKind.entities).toMatchObject({ status: 'succeeded', rowsUpserted: 7 });
    expect(byKind.insights_incremental).toMatchObject({
      status: 'succeeded',
      rowsUpserted: 2 * ENTITIES_PER_DAY,
      windowStart: yesterday,
      windowEnd: today(),
    });
    expect(byKind.insights_restatement).toMatchObject({
      status: 'succeeded',
      rowsUpserted: 28 * ENTITIES_PER_DAY,
    });
    // Paginación por cursor (páginas de 2): muchas llamadas, ninguna a la URL `next` con el token.
    expect(byKind.insights_restatement?.apiCalls).toBeGreaterThan(4);
    expect(s.fake.calls.every((c) => c.path !== '/next')).toBe(true);

    // Tras los Insights, el motor de auditoría evaluó la cuenta y guardó su salud.
    const audits = await s.q((tx) =>
      tx.select().from(auditRuns).where(eq(auditRuns.adAccountId, s.accountId)),
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((r) => r.status === 'succeeded' && r.trigger === 'post_sync')).toBe(true);
    const scored = await s.q((tx) =>
      tx.select().from(healthScores).where(eq(healthScores.adAccountId, s.accountId)),
    );
    expect(scored.map((h) => h.entityLevel)).toContain('account');

    // Segunda vuelta con los mismos datos: mismas filas, mismos valores.
    const before = comparable(rows);
    await s.due();
    await s.tick();
    expect(comparable(await s.insights())).toEqual(before);
  });

  it('la reexpresión de Meta actualiza los valores sin duplicar filas y lo que desaparece se marca', async () => {
    const s = await setup();
    await s.connect();
    await s.enable();
    await s.tick();

    s.fake.state.spend = '11.25';
    s.fake.state.edges.set(
      `${s.act}/ads`,
      (s.fake.state.edges.get(`${s.act}/ads`) ?? []).filter((a) => a.id !== '3003'),
    );
    await s.due();
    await s.tick();

    const rows = await s.insights();
    expect(rows).toHaveLength(RECENT_DAYS * ENTITIES_PER_DAY); // las filas antiguas del anuncio siguen
    const fresh = rows.filter((r) => r.entityMetaId !== '3003');
    expect(new Set(fresh.map((r) => r.spend))).toEqual(new Set(['11.2500']));
    const adRows = await s.q((tx) => tx.select().from(ads).where(eq(ads.adAccountId, s.accountId)));
    expect(adRows.filter((a) => a.deletedAt).map((a) => a.metaId)).toEqual(['3003']);
  });

  it.each([100, 1])(
    'si Meta pide menos datos (código %i), el rango se parte y llegan todas las filas',
    async (code) => {
      const s = await setup();
      await s.connect();
      s.fake.state.maxDays = 7;
      s.fake.state.maxDaysCode = code;
      await s.enable();
      await s.tick();

      expect(await s.insights()).toHaveLength(RECENT_DAYS * ENTITIES_PER_DAY);
      const restatement = (await s.runs()).find((r) => r.kind === 'insights_restatement');
      expect(restatement).toMatchObject({
        status: 'succeeded',
        rowsUpserted: 28 * ENTITIES_PER_DAY,
      });
    },
  );

  it('el backfill avanza mes a mes hasta backfillMonths y termina', async () => {
    const s = await setup();
    await s.connect();
    await s.enable({ backfill: true, backfillMonths: 2 });
    await s.tick();

    const dates = new Set<string>();
    const add = (since: string, until: string) => {
      for (let d = since; d <= until; d = addDays(d, 1)) dates.add(d);
    };
    add(addDays(today(), -28), today());
    const m0 = monthRange(today(), 0);
    const m1 = monthRange(today(), 1);
    add(m0.since, addDays(today(), -1));
    add(m1.since, m1.until);
    expect(await s.insights()).toHaveLength(dates.size * ENTITIES_PER_DAY);

    const backfill = (await s.runs()).filter((r) => r.kind === 'insights_backfill');
    expect(backfill.map((r) => [r.windowStart, r.status])).toEqual([
      [m0.since, 'succeeded'],
      [m1.since, 'succeeded'],
    ]);
    const [job] = (await s.jobs()).filter((j) => j.kind === 'insights_backfill');
    expect(job).toMatchObject({
      status: 'succeeded',
      payload: { adAccountId: s.accountId, monthsDone: 1 },
    });
  });

  for (const [name, stop] of [
    [
      'desactivada la sincronización',
      (tx: Tx, accountId: string) =>
        tx.update(adAccounts).set({ syncEnabled: false }).where(eq(adAccounts.id, accountId)),
    ],
    [
      'revocado el consentimiento read_insights',
      (tx: Tx) => tx.update(clientConsents).set({ revokedAt: new Date() }),
    ],
  ] as const) {
    it(`${name}, sus trabajos terminan sin llamar a Meta`, async () => {
      const s = await setup();
      await s.connect();
      await s.enable();
      await s.q((tx) => stop(tx, s.accountId));
      const calls = s.fake.calls.length;
      await s.tick();
      expect(s.fake.calls.length).toBe(calls);
      const accountJobs = (await s.jobs()).filter(
        (j) => (j.payload as { adAccountId?: string }).adAccountId,
      );
      expect(accountJobs.map((j) => j.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    });
  }
});

describe('errores de Meta', () => {
  it('ante throttling se reprograma según las cabeceras, sin gastar intento ni duplicar datos (CA-F1-05)', async () => {
    const s = await setup();
    await s.connect();
    s.fake.fail(
      /insights$/,
      {
        status: 400,
        body: {
          error: {
            code: 80000,
            error_subcode: 2446079,
            message: 'There have been too many calls from this ad-account.',
          },
        },
        headers: {
          'x-business-use-case-usage': JSON.stringify({
            [s.act.slice(4)]: [
              {
                type: 'ads_insights',
                call_count: 100,
                total_cputime: 30,
                total_time: 30,
                estimated_time_to_regain_access: 7,
              },
            ],
          }),
        },
      },
      100,
    );
    await s.enable();
    await s.tick();

    const insightJobs = (await s.jobs()).filter((j) => j.kind.startsWith('insights_'));
    expect(insightJobs).toHaveLength(2);
    for (const j of insightJobs) {
      expect(j).toMatchObject({ status: 'queued', attempts: 0 });
      expect(j.runAfter.getTime()).toBeGreaterThan(Date.now() + 6 * 60_000);
    }
    const throttled = (await s.runs()).filter((r) => r.kind.startsWith('insights_'));
    expect(throttled.map((r) => r.status)).toEqual(['throttled', 'throttled']);
    expect(await s.insights()).toHaveLength(0);

    // Mientras dura el bloqueo de la cuenta no se le hace ninguna llamada, ni para las entidades
    // (la validación y el descubrimiento de la conexión son de otro ámbito y siguen).
    const accountCalls = () => s.fake.calls.filter((c) => c.path.startsWith(`/${s.act}/`)).length;
    const calls = accountCalls();
    await s.due();
    await s.tick();
    expect(accountCalls()).toBe(calls);
    expect((await s.jobs()).filter((j) => j.status === 'queued' && j.attempts > 0)).toHaveLength(0);

    // Pasado el bloqueo, se completa con las filas exactas.
    s.fake.clearFailures();
    await db.delete(metaRateState).where(like(metaRateState.scope, `${s.appId}|%`));
    await s.due();
    await s.tick();
    expect(await s.insights()).toHaveLength(RECENT_DAYS * ENTITIES_PER_DAY);
  });

  it('ante un 190 la conexión pasa a inválida y sus trabajos se detienen sin reintentos (CA-F1-04)', async () => {
    const s = await setup();
    await s.connect();
    await s.enable();
    s.fake.state.tokens.set(s.token, { valid: false, scopes: [] });
    await s.tick();

    const [connection] = await s.q((tx) =>
      tx.select().from(metaConnections).where(eq(metaConnections.id, s.connectionId)),
    );
    expect(connection).toMatchObject({ status: 'invalid', lastErrorCode: 190 });
    const events = await s.q((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.targetId, s.connectionId)),
    );
    // La consulta no solicita un orden: se comprueba la bitácora completa, no el orden físico de PostgreSQL.
    expect(events.map((e) => e.action).sort()).toEqual([
      'meta_connection.invalidated',
      'meta_connection.validated',
    ]);
    expect((await s.jobs()).filter((j) => j.status === 'queued')).toHaveLength(0);

    await s.due();
    expect((await s.tick()).processed).toBe(0);
  });

  it('el token no aparece en sync_runs, jobs, eventos ni logs, tampoco en errores (CA-F1-03)', async () => {
    const token = `EAACANARY${randomBytes(24).toString('hex')}`;
    const s = await setup({ token });
    await s.connect();
    s.fake.fail(/campaigns$/, 'network');
    s.fake.fail(
      /insights$/,
      { status: 500, body: { error: { code: 2, message: `Service unavailable for ${token}` } } },
      2,
    );
    await s.enable();
    await s.tick();

    const runs = await s.runs();
    expect(
      runs.filter((r) => r.errorMessage?.includes('[REDACTED]')).length,
    ).toBeGreaterThanOrEqual(2);
    const surfaces = [
      JSON.stringify(runs),
      JSON.stringify(await s.jobs()),
      JSON.stringify(await s.q((tx) => tx.select().from(auditLog))),
      s.logs(),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(token);
    // Los fallos transitorios se reintentan con backoff (gastan intento).
    expect(
      (await s.jobs()).filter((j) => j.attempts === 1 && j.status === 'queued').length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('aislamiento', () => {
  it('dos tenants con la misma cuenta de Meta sincronizan cada uno sus propias filas', async () => {
    const act = `act_${id()}`;
    const a = await setup({ act });
    const b = await setup({ act });
    for (const s of [a, b]) {
      await s.connect();
      await s.enable();
      await s.tick();
    }
    for (const s of [a, b]) {
      const rows = await s.q((tx) => tx.select().from(insightsDaily).where(sql`true`));
      expect(
        rows.filter((r) => r.entityMetaId === act || r.adAccountId === s.accountId),
      ).toHaveLength(RECENT_DAYS * ENTITIES_PER_DAY);
      expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([s.tenantId]));
    }
  });
});

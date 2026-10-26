import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import {
  adAccounts,
  ads,
  adsets,
  auditConfigs,
  auditRuns,
  campaigns,
  findingEvents,
  findings,
  healthScores,
  insightsDaily,
} from '../../db/schema.ts';
import type { Job, JobHandler } from '../../platform/jobs.ts';
import { addDays, localDate } from '../insights/catalog.ts';
import { ENGINE_VERSION, runAudit } from './engine.ts';
import {
  type AuditConfig,
  type AuditConfigPatch,
  type AuditInput,
  type Day,
  type EntityInput,
  mergeConfig,
} from './model.ts';
import { RULES_BY_ID, ruleParams } from './rules.ts';

// Ejecución del motor sobre una cuenta: carga los datos, llama a la función pura y guarda la
// ejecución, los hallazgos (con su ciclo de vida) y la salud diaria. Todo en una transacción con
// el contexto del tenant (RLS).

type Trigger = 'post_sync' | 'manual' | 'scheduled';
const OPEN_STATUSES = ['open', 'acknowledged', 'snoozed'] as const;

/** Configuración efectiva de una cuenta: por defecto ← organización ← cliente. */
export async function effectiveConfig(tx: Tx, clientId: string | null): Promise<AuditConfig> {
  const rows = await tx.select().from(auditConfigs);
  const tenantPatch = rows.find((r) => r.clientId === null)?.config as AuditConfigPatch | undefined;
  const clientPatch = clientId
    ? (rows.find((r) => r.clientId === clientId)?.config as AuditConfigPatch | undefined)
    : undefined;
  return mergeConfig(tenantPatch, clientPatch);
}

const minorDigits = (currency: string) => {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};

const n = (v: string | number | null | undefined) =>
  v === null || v === undefined ? 0 : Number(v);

function toDay(r: typeof insightsDaily.$inferSelect): Day {
  return {
    date: r.date,
    spend: n(r.spend),
    impressions: n(r.impressions),
    reach: n(r.reach),
    clicks: n(r.clicks),
    inlineLinkClicks: n(r.inlineLinkClicks),
    outboundClicks: n(r.outboundClicks),
    results: n(r.results),
    resultIndicator: r.resultIndicator,
    leads: n(r.leads),
    purchases: n(r.purchases),
    purchaseValue: n(r.purchaseValue),
    messagingConversations: n(r.messagingConversations),
    appInstalls: n(r.appInstalls),
    landingPageViews: n(r.landingPageViews),
    thruplays: n(r.thruplays),
    attribution: r.attributionSetting,
  };
}

/** Datos de entrada del motor para una cuenta y un día de corte. */
export async function loadAuditInput(
  tx: Tx,
  account: typeof adAccounts.$inferSelect,
  asOf: string,
  config: AuditConfig,
): Promise<AuditInput> {
  const chg = RULES_BY_ID.get('R-CHG-014');
  const historyDays = chg
    ? Number(ruleParams(chg, config.rules['R-CHG-014']?.params).historyDays)
    : 28;
  const span = Math.max(
    config.windows.evaluationDays + config.windows.baselineDays,
    historyDays + 1,
  );
  const since = addDays(asOf, -span);
  const rows = await tx
    .select()
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.adAccountId, account.id),
        gte(insightsDaily.date, since),
        lte(insightsDaily.date, asOf),
      ),
    )
    .orderBy(insightsDaily.date);
  const daysOf = new Map<string, Day[]>();
  for (const r of rows) {
    const key = `${r.level}:${r.entityMetaId}`;
    daysOf.set(key, [...(daysOf.get(key) ?? []), toDay(r)]);
  }

  const scale = 10 ** minorDigits(account.currency);
  const major = (v: number | null) => (v === null ? null : v / scale);
  const hasData = (key: string) => daysOf.has(key);
  const [cs, ss, as] = await Promise.all([
    tx.select().from(campaigns).where(eq(campaigns.adAccountId, account.id)),
    tx.select().from(adsets).where(eq(adsets.adAccountId, account.id)),
    tx.select().from(ads).where(eq(ads.adAccountId, account.id)),
  ]);
  const learning = (info: unknown) =>
    info && typeof info === 'object' && 'status' in info
      ? String((info as { status: unknown }).status)
      : null;
  const promoted = (o: unknown) =>
    o && typeof o === 'object' && 'custom_event_type' in o
      ? String((o as { custom_event_type: unknown }).custom_event_type)
      : null;
  const base = {
    lifetimeBudget: null,
    bidStrategy: null,
    bidAmount: null,
    learning: null,
    hasIssues: false,
    objective: null,
    optimizationGoal: null,
    promotedEvent: null,
    dailyBudget: null,
  };

  const entities: EntityInput[] = [
    ...cs
      .filter((c) => !c.deletedAt || hasData(`campaign:${c.metaId}`))
      .map((c) => ({
        ...base,
        level: 'campaign' as const,
        id: c.metaId,
        name: c.name,
        parentId: null,
        campaignId: c.metaId,
        status: c.effectiveStatus,
        deleted: c.deletedAt !== null,
        objective: c.objective,
        dailyBudget: major(c.dailyBudgetMinor),
        lifetimeBudget: major(c.lifetimeBudgetMinor),
        days: daysOf.get(`campaign:${c.metaId}`) ?? [],
      })),
    ...ss
      .filter((s) => !s.deletedAt || hasData(`adset:${s.metaId}`))
      .map((s) => ({
        ...base,
        level: 'adset' as const,
        id: s.metaId,
        name: s.name,
        parentId: s.campaignMetaId,
        campaignId: s.campaignMetaId,
        status: s.effectiveStatus,
        deleted: s.deletedAt !== null,
        optimizationGoal: s.optimizationGoal,
        promotedEvent: promoted(s.promotedObject),
        dailyBudget: major(s.dailyBudgetMinor),
        lifetimeBudget: major(s.lifetimeBudgetMinor),
        bidStrategy: s.bidStrategy,
        bidAmount: major(s.bidAmountMinor),
        learning: learning(s.learningStageInfo),
        days: daysOf.get(`adset:${s.metaId}`) ?? [],
      })),
    ...as
      .filter((a) => !a.deletedAt || hasData(`ad:${a.metaId}`))
      .map((a) => ({
        ...base,
        level: 'ad' as const,
        id: a.metaId,
        name: a.name,
        parentId: a.adsetMetaId,
        campaignId: a.campaignMetaId,
        status: a.effectiveStatus,
        deleted: a.deletedAt !== null,
        hasIssues: Array.isArray(a.issuesInfo) ? a.issuesInfo.length > 0 : !!a.issuesInfo,
        days: daysOf.get(`ad:${a.metaId}`) ?? [],
      })),
  ];
  return {
    account: {
      id: account.id,
      metaAccountId: account.metaAccountId,
      name: account.name,
      currency: account.currency,
      timezone: account.timezoneName,
      syncEnabled: account.syncEnabled,
    },
    asOf,
    accountDays: daysOf.get(`account:${account.metaAccountId}`) ?? [],
    entities,
  };
}

/** JSON con claves ordenadas: la huella no depende del orden de inserción. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export async function auditAccount(
  db: Db,
  tenantId: string,
  adAccountId: string,
  opts: { trigger: Trigger; asOf?: string },
) {
  return withContext(db, { tenantId }, async (tx) => {
    const [account] = await tx.select().from(adAccounts).where(eq(adAccounts.id, adAccountId));
    if (!account) return null;
    const config = await effectiveConfig(tx, account.clientId);
    const asOf = opts.asOf ?? addDays(localDate(account.timezoneName), -1);
    const input = await loadAuditInput(tx, account, asOf, config);
    const result = runAudit(input, config);
    const inputHash = createHash('sha256')
      .update(canonical({ engine: ENGINE_VERSION, config, input }))
      .digest('hex');
    const now = new Date();

    const run = first(
      await tx
        .insert(auditRuns)
        .values({
          tenantId,
          adAccountId,
          trigger: opts.trigger,
          dataAsOf: now,
          engineVersion: ENGINE_VERSION,
          status: 'running',
          asOf,
          inputHash,
        })
        .returning(),
    );

    // --- Hallazgos: abrir, actualizar, reabrir, respetar los descartados y resolver.
    const existing = await tx
      .select()
      .from(findings)
      .where(
        and(eq(findings.adAccountId, adAccountId), inArray(findings.status, [...OPEN_STATUSES])),
      );
    const byFingerprint = new Map(existing.map((f) => [f.fingerprint, f]));
    const closed = await tx
      .select({
        fingerprint: findings.fingerprint,
        status: findings.status,
        ruleVersion: findings.ruleVersion,
        id: findings.id,
      })
      .from(findings)
      .where(
        and(
          eq(findings.adAccountId, adAccountId),
          inArray(findings.status, ['dismissed', 'resolved']),
        ),
      )
      .orderBy(desc(findings.lastSeenAt));
    const events: Array<typeof findingEvents.$inferInsert> = [];
    const counts = { opened: 0, updated: 0, reopened: 0, resolved: 0, keptDismissed: 0 };

    for (const d of result.findings) {
      const values = {
        severity: d.severity,
        confidence: d.confidence.toFixed(3),
        priority: String(d.priority),
        impact: d.impact ?? {},
        evidence: d.evidence,
        explanation: d.explanation,
        recommendationKey: d.recommendationKey,
        recommendationText: d.recommendationText,
        ruleVersion: d.ruleVersion,
        category: d.category,
        profile: d.profile,
        engineVersion: ENGINE_VERSION,
        windowStart: d.evidence.window.since,
        windowEnd: d.evidence.window.until,
        lastAuditRunId: run.id,
        lastSeenAt: now,
        clearRuns: 0,
      };
      const open = byFingerprint.get(d.fingerprint);
      if (open) {
        await tx.update(findings).set(values).where(eq(findings.id, open.id));
        if (open.severity !== d.severity) {
          events.push({
            tenantId,
            findingId: open.id,
            auditRunId: run.id,
            event: 'updated',
            actorType: 'system',
            data: { severity: { from: open.severity, to: d.severity } },
          });
        }
        counts.updated++;
        continue;
      }
      const previous = closed.find((c) => c.fingerprint === d.fingerprint);
      // Lo descartado por una persona no vuelve a abrirse mientras la regla no cambie de versión.
      if (previous?.status === 'dismissed' && previous.ruleVersion === d.ruleVersion) {
        counts.keptDismissed++;
        continue;
      }
      const created = first(
        await tx
          .insert(findings)
          .values({
            ...values,
            tenantId,
            adAccountId,
            auditRunId: run.id,
            kind: 'audit',
            ruleId: d.ruleId,
            entityLevel: d.level,
            entityMetaId: d.entityId,
            fingerprint: d.fingerprint,
            firstSeenAt: now,
          })
          .returning({ id: findings.id }),
      );
      const reopened = previous?.status === 'resolved';
      events.push({
        tenantId,
        findingId: created.id,
        auditRunId: run.id,
        event: reopened ? 'reopened' : 'opened',
        actorType: 'system',
        data: reopened ? { previous: previous.id } : null,
      });
      counts[reopened ? 'reopened' : 'opened']++;
    }

    const triggered = new Set(result.findings.map((f) => f.fingerprint));
    const evaluated = new Map(
      result.evaluations.map((e) => [`${e.ruleId}:${e.level}:${e.entityId}`, e.status]),
    );
    for (const f of existing) {
      if (triggered.has(f.fingerprint)) continue;
      // Solo cuenta una evaluación limpia: sin datos suficientes, o si la regla no se evaluó, no se resuelve.
      if (evaluated.get(f.fingerprint) !== 'not_triggered') continue;
      const clearRuns = f.clearRuns + 1;
      const resolve = clearRuns >= config.resolveAfterRuns;
      await tx
        .update(findings)
        .set({
          clearRuns,
          lastAuditRunId: run.id,
          ...(resolve && { status: 'resolved' as const, resolvedAt: now }),
        })
        .where(eq(findings.id, f.id));
      if (resolve) {
        events.push({
          tenantId,
          findingId: f.id,
          auditRunId: run.id,
          event: 'resolved',
          actorType: 'system',
          data: { clearRuns },
        });
        counts.resolved++;
      }
    }
    if (events.length) await tx.insert(findingEvents).values(events);

    // --- Salud diaria (una fila por entidad, día y versión de la fórmula).
    const healthRows = result.health.map((h) => ({
      tenantId,
      adAccountId,
      entityLevel: h.level,
      entityMetaId: h.entityId,
      date: asOf,
      formulaVersion: h.formulaVersion,
      profile: h.profile,
      windowDays: h.windowDays,
      score: h.score === null ? null : h.score.toFixed(2),
      grade: h.grade,
      confidence: h.confidence === null ? null : h.confidence.toFixed(3),
      coverage: h.coverage.toFixed(3),
      components: h.components,
      auditRunId: run.id,
      computedAt: now,
    }));
    for (let i = 0; i < healthRows.length; i += 500) {
      await tx
        .insert(healthScores)
        .values(healthRows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [
            healthScores.tenantId,
            healthScores.entityLevel,
            healthScores.entityMetaId,
            healthScores.date,
            healthScores.formulaVersion,
          ],
          set: Object.fromEntries(
            [
              'profile',
              'window_days',
              'score',
              'grade',
              'confidence',
              'coverage',
              'components',
              'audit_run_id',
              'computed_at',
              'ad_account_id',
            ].map((c) => [
              c.replace(/_(\w)/g, (_, l: string) => l.toUpperCase()),
              sql.raw(`excluded."${c}"`),
            ]),
          ),
        });
    }

    const stats = { ...result.stats, ...counts, health: healthRows.length };
    await tx
      .update(auditRuns)
      .set({ status: 'succeeded', finishedAt: new Date(), stats })
      .where(eq(auditRuns.id, run.id));
    return { runId: run.id, asOf, inputHash, engineVersion: ENGINE_VERSION, stats };
  });
}

/** Trabajo "audit" de la cola: se encola tras cada sincronización de Insights. */
export const createAuditHandler =
  (db: Db): JobHandler =>
  async (job: Job) => {
    const adAccountId = (job.payload as { adAccountId?: string } | null)?.adAccountId;
    if (!adAccountId) return { type: 'stop', error: 'trabajo de auditoría sin cuenta' };
    const done = await auditAccount(db, job.tenantId, adAccountId, { trigger: 'post_sync' });
    return done ? { type: 'done' } : { type: 'end', reason: 'la cuenta no existe' };
  };

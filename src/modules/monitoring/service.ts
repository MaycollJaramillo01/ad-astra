import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type Db, first, type Tx, withContext } from '../../db/client.ts';
import {
  actionFollowups,
  actions,
  adAccounts,
  authUsers,
  clientConsents,
  clients,
  memberships,
  monitoringDeliveries,
  monitoringEvents,
  monitoringIncidents,
  monitoringPolicies,
  monitoringReports,
  monitoringRuns,
} from '../../db/schema.ts';
import {
  defaultMonitorPolicy,
  type IncidentDecision,
  type MonitoringPolicy,
  type PolicyBody,
} from '../../monitoring-contracts.ts';
import { badRequest, conflict, notFound } from '../../platform/errors.ts';
import { recordEvent } from '../../platform/events.ts';
import type { TenantContext } from '../../platform/http.ts';
import { cancelQueued, enqueue } from '../../platform/jobs.ts';
import { can } from '../../platform/rbac.ts';
import { findAccount } from '../catalog/accounts.ts';
import { addDays, localDate } from '../insights/catalog.ts';
import { freezeActionFollowup, loadMonitorData, type MonitorData } from './data.ts';
import {
  buildPlan,
  evaluatePlan,
  type FollowupPlan,
  hash,
  inQuietHours,
  metricSignals,
  type Signal,
  severityRank,
  summarize,
  VERSION,
} from './model.ts';

export const policyFor = async (tx: Tx, accountId: string) => {
  const [p] = await tx
    .select()
    .from(monitoringPolicies)
    .where(eq(monitoringPolicies.adAccountId, accountId));
  return p ?? { revision: 0, config: defaultMonitorPolicy(), authorizedBy: null };
};
export async function monitorEvent(
  tx: Tx,
  tenantId: string,
  accountId: string,
  event: string,
  data: unknown,
  actorId?: string,
  incidentId?: string,
) {
  await tx
    .insert(monitoringEvents)
    .values({ tenantId, adAccountId: accountId, event, data, actorId, incidentId });
  await recordEvent(
    tx,
    { tenantId, actorType: actorId ? 'user' : 'system', actorId },
    { action: `monitoring.${event}`, targetType: 'ad_account', targetId: accountId, after: data },
  );
}
export async function hasReadConsent(tx: Tx, account: typeof adAccounts.$inferSelect) {
  if (!account.clientId) return false;
  const [client] = await tx.select().from(clients).where(eq(clients.id, account.clientId));
  const grants = await tx
    .select()
    .from(clientConsents)
    .where(and(eq(clientConsents.clientId, account.clientId), isNull(clientConsents.revokedAt)));
  return (
    client?.status === 'active' &&
    grants.some((g) => g.grantedAt <= new Date() && g.scope.includes('read_insights'))
  );
}
export async function authorizedMember(
  tx: Tx,
  tenantId: string,
  accountId: string,
  userId: string,
  permission: 'monitoring:read' | 'monitoring:configure' = 'monitoring:read',
) {
  const [member] = await tx
    .select({
      role: memberships.role,
      email: authUsers.email,
      verified: authUsers.emailVerified,
      name: authUsers.name,
    })
    .from(memberships)
    .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
    .where(eq(memberships.userId, userId));
  if (!member || !can(member.role, permission)) return null;
  try {
    await findAccount(tx, { tenantId, userId, role: member.role }, accountId);
  } catch {
    return null;
  }
  return member;
}
export async function captureBeforeAction(
  tx: Tx,
  action: typeof actions.$inferSelect,
  account: typeof adAccounts.$inferSelect,
) {
  // Obligatorio aun con alertas deshabilitadas; el plan se confirma antes de cualquier POST.
  const p = await policyFor(tx, account.id),
    now = new Date(),
    date = localDate(account.timezoneName, now);
  const data = await loadMonitorData(tx, account, addDays(date, -1));
  await freezeActionFollowup(
    tx,
    action,
    buildPlan({ ...action, dispatchAt: null }, data.entities, p.config, now, date),
  );
  await enqueue(tx, {
    tenantId: action.tenantId,
    kind: 'monitor_followup',
    payload: { actionId: action.id, adAccountId: account.id },
    dedupeKey: `monitor_followup:${action.id}`,
    recurringEverySeconds: 3600,
    runAfter: new Date(now.getTime() + 3600000),
  });
}

function systemSignals(
  data: MonitorData,
  account: typeof adAccounts.$inferSelect,
  p: MonitoringPolicy,
  asOf: string,
  now: Date,
): Signal[] {
  const period = String(Math.floor(now.getTime() / 900000)),
    signals: Signal[] = [];
  for (const r of p.rules.filter((r) => r.enabled)) {
    const base = {
      ruleId: r.id,
      group: `${r.kind}:account:${account.metaAccountId}`,
      level: 'account',
      entityId: account.metaAccountId,
      category: r.kind,
      severity: r.severity,
      observation: period,
    };
    if (r.kind === 'connection')
      signals.push({
        ...base,
        hit:
          data.connection?.status !== 'active' ||
          !!(data.connection.expiresAt && data.connection.expiresAt <= now),
        detail: {
          status: data.connection?.status ?? 'missing',
          expired: !!(data.connection?.expiresAt && data.connection.expiresAt <= now),
        },
      });
    if (r.kind === 'sync_stale')
      signals.push({
        ...base,
        hit: account.syncEnabled
          ? !account.lastInsightsSyncAt ||
            now.getTime() - account.lastInsightsSyncAt.getTime() > r.threshold * 3600000
          : null,
        detail: {
          lastSyncAt: account.lastInsightsSyncAt,
          thresholdHours: r.threshold,
          syncEnabled: account.syncEnabled,
        },
      });
    if (r.kind === 'recommendation_stale') {
      const ids = data.recommendations
        .filter(
          (x) =>
            ['open', 'accepted'].includes(x.status) &&
            now.getTime() - (x.decidedAt ?? x.createdAt).getTime() > r.threshold * 86400000,
        )
        .map((x) => x.id);
      signals.push({
        ...base,
        hit: ids.length > 0,
        detail: { recommendationIds: ids, thresholdDays: r.threshold },
      });
    }
    if (r.kind === 'action_failed') {
      const ids = data.actions
        .filter(
          (x) =>
            (x.state === 'failed' || x.result === 'unknown') &&
            now.getTime() - x.createdAt.getTime() <= r.threshold * 86400000,
        )
        .map((x) => x.id);
      signals.push({
        ...base,
        hit: ids.length > 0,
        detail: { actionIds: ids, windowDays: r.threshold },
      });
    }
    if (r.kind === 'audit') {
      const known =
        data.audit?.status === 'succeeded' &&
        data.audit.asOf !== null &&
        data.audit.asOf >= asOf &&
        data.audit.finishedAt !== null &&
        now.getTime() - data.audit.finishedAt.getTime() < 48 * 3600000;
      const entities = new Map(
        data.entities.map((e) => [`${e.level}:${e.id}`, { level: e.level, id: e.id }]),
      );
      entities.set(`account:${account.metaAccountId}`, {
        level: 'account',
        id: account.metaAccountId,
      });
      for (const f of data.findings)
        entities.set(`${f.level}:${f.entityId}`, { level: f.level, id: f.entityId });
      for (const e of entities.values()) {
        const f = data.findings.filter(
          (f) =>
            f.level === e.level &&
            f.entityId === e.id &&
            ['open', 'acknowledged', 'snoozed'].includes(f.status),
        );
        const severity = f.reduce(
          (s, x) => (severityRank(x.severity) > severityRank(s) ? x.severity : s),
          r.severity,
        );
        signals.push({
          ...base,
          group: `audit:${e.level}:${e.id}`,
          category: 'audit',
          level: e.level,
          entityId: e.id,
          severity,
          observation: asOf,
          hit: known ? f.length >= Math.max(1, r.threshold) : null,
          detail: { findingIds: f.map((x) => x.id), auditRunId: data.audit?.id, known },
        });
      }
    }
  }
  return signals;
}

async function refreshFollowups(
  tx: Tx,
  tenantId: string,
  account: typeof adAccounts.$inferSelect,
  data: MonitorData,
  p: MonitoringPolicy,
  now: Date,
) {
  for (const a of data.actions.filter((x) => x.dispatchAt)) {
    const exists = await tx
      .select({ actionId: actionFollowups.actionId })
      .from(actionFollowups)
      .where(eq(actionFollowups.actionId, a.id));
    if (!exists.length) {
      const [full] = await tx.select().from(actions).where(eq(actions.id, a.id));
      if (full)
        await freezeActionFollowup(
          tx,
          full,
          buildPlan(
            full,
            data.entities,
            p,
            now,
            localDate(account.timezoneName, a.dispatchAt ?? now),
          ),
        );
    }
  }
  const plans = await tx
    .select()
    .from(actionFollowups)
    .where(eq(actionFollowups.adAccountId, account.id));
  for (const row of plans) {
    const plan = row.plan as FollowupPlan,
      concurrent = data.actions
        .filter(
          (a) =>
            a.id !== row.actionId &&
            a.dispatchAt &&
            localDate(account.timezoneName, a.dispatchAt) >= plan.beforeSince &&
            localDate(account.timezoneName, a.dispatchAt) <= plan.afterUntil,
        )
        .map((a) => a.id);
    const result = {
      ...evaluatePlan(
        plan,
        data.entities,
        addDays(localDate(account.timezoneName, now), -1 - plan.maturityDays),
        concurrent,
        p.externalEvents,
      ),
      action: data.actions.find((a) => a.id === row.actionId) ?? null,
    };
    if (!result.action?.confirmedWrite)
      result.flags.push(
        'No hay confirmación de escritura propia; la configuración pudo cambiar externamente o el envío fallar.',
      );
    if (
      result.action?.dispatchAt &&
      localDate(account.timezoneName, result.action.dispatchAt) !== plan.actionDate
    ) {
      result.status = 'insufficient';
      result.target.comparable = false;
      result.target.delta = null;
      result.flags.push(
        'El día de envío difiere del plan congelado, por reintento o demora; las ventanas no son admisibles para comparar.',
      );
    }
    if (hash(row.result) !== hash(result)) {
      await tx
        .update(actionFollowups)
        .set({ result, updatedAt: now })
        .where(eq(actionFollowups.actionId, row.actionId));
      await monitorEvent(tx, tenantId, account.id, 'followup_evaluated', {
        actionId: row.actionId,
        resultHash: hash(result),
        status: result.status,
        causal: false,
      });
    }
  }
}

async function queueDigests(
  tx: Tx,
  tenantId: string,
  account: typeof adAccounts.$inferSelect,
  p: Awaited<ReturnType<typeof policyFor>>,
  now: Date,
) {
  if (
    !p.config.enabled ||
    !p.authorizedBy ||
    !(await authorizedMember(tx, tenantId, account.id, p.authorizedBy, 'monitoring:configure')) ||
    !(await hasReadConsent(tx, account))
  )
    return;
  const n = p.config.notifications,
    date = localDate(account.timezoneName, now),
    hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: account.timezoneName,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now),
    );
  if (inQuietHours(hour, n.quietStart, n.quietEnd)) return;
  const incidents = (
    await tx
      .select()
      .from(monitoringIncidents)
      .where(eq(monitoringIncidents.adAccountId, account.id))
  ).filter(
    (i) =>
      ['open', 'acknowledged'].includes(i.status) &&
      severityRank(i.severity) >= severityRank(n.minSeverity) &&
      (!i.lastNotifiedAt ||
        now.getTime() - i.lastNotifiedAt.getTime() >= p.config.cooldownHours * 3600000),
  );
  if (!incidents.length) return;
  const channels = (['in_app', 'email'] as const).filter((c) =>
    c === 'in_app' ? n.inApp : n.email,
  );
  let queued = false;
  for (const userId of n.recipientIds) {
    const member = await authorizedMember(tx, tenantId, account.id, userId);
    if (!member) continue;
    for (const channel of channels) {
      if (channel === 'email' && !member.verified) continue;
      const deliveries = await tx
        .select()
        .from(monitoringDeliveries)
        .where(
          and(
            eq(monitoringDeliveries.adAccountId, account.id),
            eq(monitoringDeliveries.userId, userId),
            eq(monitoringDeliveries.channel, channel),
            gte(monitoringDeliveries.createdAt, new Date(now.getTime() - 48 * 3600000)),
          ),
        );
      const today = deliveries.filter(
        (d) => localDate(account.timezoneName, d.createdAt) === date && d.status !== 'cancelled',
      );
      if (today.length >= n.maxPerDay) continue;
      // Un resumen por cuenta, destinatario, canal y franja de 15 min; clave estable ante reinicios.
      const digestKey = `${p.revision}:${Math.floor(now.getTime() / 900000)}`;
      const inserted = await tx
        .insert(monitoringDeliveries)
        .values({
          tenantId,
          adAccountId: account.id,
          userId,
          channel,
          policyRevision: p.revision,
          digestKey,
          incidentIds: incidents.map((i) => i.id),
        })
        .onConflictDoNothing()
        .returning();
      for (const d of inserted) {
        queued = true;
        await enqueue(tx, {
          tenantId,
          kind: 'monitor_notify',
          payload: { deliveryId: d.id },
          dedupeKey: `monitor_notify:${d.id}`,
        });
        await monitorEvent(tx, tenantId, account.id, 'notification_queued', {
          deliveryId: d.id,
          channel,
          count: incidents.length,
        });
      }
    }
  }
  if (queued)
    await tx
      .update(monitoringIncidents)
      .set({ lastNotifiedAt: now })
      .where(
        inArray(
          monitoringIncidents.id,
          incidents.map((i) => i.id),
        ),
      );
}

/** Account lock + huella de entrada: concurrencia y ticks duplicados no cuentan dos veces. */
export async function evaluateAccount(
  db: Db,
  tenantId: string,
  accountId: string,
  now = new Date(),
) {
  return withContext(db, { tenantId }, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`monitor:${tenantId}:${accountId}`},0))`,
    );
    const [account] = await tx.select().from(adAccounts).where(eq(adAccounts.id, accountId));
    if (!account) return null;
    const p = await policyFor(tx, accountId),
      asOf = addDays(localDate(account.timezoneName, now), -1 - p.config.maturityDays);
    if (!(await hasReadConsent(tx, account)))
      return { enabled: false, asOf, reason: 'Sin cliente activo y consentimiento read_insights.' };
    const data = await loadMonitorData(
      tx,
      account,
      addDays(localDate(account.timezoneName, now), -1),
    );
    await refreshFollowups(tx, tenantId, account, data, p.config, now);
    if (!p.config.enabled) return { enabled: false, asOf };
    const signals = [
      ...metricSignals(data.entities, p.config, asOf),
      ...systemSignals(data, account, p.config, asOf, now),
    ];
    const groups = new Map<string, Signal[]>();
    for (const s of signals) {
      const list = groups.get(s.group) ?? [];
      list.push(s);
      groups.set(s.group, list);
    }
    const stats = { groups: groups.size, triggered: 0, insufficient: 0, opened: 0, resolved: 0 };
    for (const [fingerprint, list] of groups) {
      const sample = list[0];
      if (!sample) continue;
      const hit = list.some((s) => s.hit === true)
        ? true
        : list.every((s) => s.hit === false)
          ? false
          : null;
      const observation = list
        .map((s) => s.observation)
        .sort()
        .join('|');
      const severity = list
        .filter((s) => s.hit)
        .reduce<typeof sample.severity>(
          (v, s) => (severityRank(s.severity) > severityRank(v) ? s.severity : v),
          'info',
        );
      if (hit === true) stats.triggered++;
      if (hit === null) stats.insufficient++;
      let [old] = await tx
        .select()
        .from(monitoringIncidents)
        .where(
          and(
            eq(monitoringIncidents.adAccountId, accountId),
            eq(monitoringIncidents.fingerprint, fingerprint),
          ),
        );
      if (!old && hit !== true) continue;
      const changedPolicy = old?.policyRevision !== p.revision;
      const sameObservation = old?.lastObservation === observation && !changedPolicy;
      if (
        old &&
        sameObservation &&
        hash(old.evidence) === hash(list) &&
        !(old.status === 'snoozed' && old.snoozedUntil && old.snoozedUntil <= now)
      )
        continue;
      if (old?.status === 'dismissed' && !changedPolicy) continue;
      const previous = old?.evidence as Signal[] | undefined,
        previousHit = previous?.some((s) => s.hit === true)
          ? true
          : previous?.every((s) => s.hit === false)
            ? false
            : null;
      const hitCount =
          hit === true
            ? Math.max(
                0,
                (changedPolicy ? 0 : (old?.hitCount ?? 0)) -
                  (sameObservation && previousHit === true ? 1 : 0),
              ) + 1
            : 0,
        clearCount =
          hit === false
            ? Math.max(
                0,
                (changedPolicy ? 0 : (old?.clearCount ?? 0)) -
                  (sameObservation && previousHit === false ? 1 : 0),
              ) + 1
            : 0;
      let status = old?.status ?? 'pending',
        episode = old?.episode ?? 1;
      if (status === 'dismissed' && changedPolicy) {
        status = 'pending';
        episode++;
      }
      if (status === 'snoozed' && old?.snoozedUntil && old.snoozedUntil <= now) status = 'open';
      if (hit === true && ['resolved', 'dismissed'].includes(status)) {
        status = 'pending';
        episode++;
      }
      if (status === 'pending' && hitCount >= p.config.openAfter) {
        status = 'open';
        stats.opened++;
      }
      if (hit === false && clearCount >= p.config.resolveAfter && status !== 'dismissed') {
        status = 'resolved';
        stats.resolved++;
      }
      const values = {
        status,
        severity: hit === true ? severity : (old?.severity ?? severity),
        policyRevision: p.revision,
        hitCount,
        clearCount,
        lastObservation: observation,
        evidence: list,
        episode,
        updatedAt: now,
        ...(status === 'open' && old?.status !== 'open' && { lastNotifiedAt: null }),
      };
      if (old) {
        await tx
          .update(monitoringIncidents)
          .set({ ...values, revision: old.revision + 1 })
          .where(eq(monitoringIncidents.id, old.id));
      } else
        old = first(
          await tx
            .insert(monitoringIncidents)
            .values({
              ...values,
              tenantId,
              adAccountId: accountId,
              fingerprint,
              entityLevel: sample.level,
              entityMetaId: sample.entityId,
              category: sample.category,
              openedAt: now,
            })
            .returning(),
        );
      await monitorEvent(
        tx,
        tenantId,
        accountId,
        'incident_evaluated',
        {
          from: old.status,
          to: status,
          hit,
          hitCount,
          clearCount,
          observation,
          policyRevision: p.revision,
        },
        undefined,
        old.id,
      );
    }
    const inputHash = hash({ version: VERSION, revision: p.revision, signals });
    const [last] = await tx
      .select()
      .from(monitoringRuns)
      .where(eq(monitoringRuns.adAccountId, accountId))
      .orderBy(desc(monitoringRuns.at))
      .limit(1);
    if (last?.inputHash !== inputHash)
      await tx.insert(monitoringRuns).values({
        tenantId,
        adAccountId: accountId,
        asOf,
        policyRevision: p.revision,
        inputHash,
        stats,
        at: now,
      });
    await queueDigests(tx, tenantId, account, p, now);
    if (p.config.reportEveryDays) {
      const interval = p.config.reportEveryDays,
        periodKey = `scheduled:${Math.floor(Date.parse(localDate(account.timezoneName, now)) / 86400000 / interval)}`;
      await saveReport(tx, tenantId, account, data, p.config, 28, now, null, periodKey);
    }
    return { enabled: true, asOf, ...stats };
  });
}

async function saveReport(
  tx: Tx,
  tenantId: string,
  account: typeof adAccounts.$inferSelect,
  data: MonitorData,
  p: MonitoringPolicy,
  days: number,
  now: Date,
  createdBy: string | null,
  periodKey?: string,
) {
  if (periodKey) {
    const [exists] = await tx
      .select({ id: monitoringReports.id })
      .from(monitoringReports)
      .where(
        and(
          eq(monitoringReports.adAccountId, account.id),
          eq(monitoringReports.periodKey, periodKey),
        ),
      );
    if (exists) return exists;
  }
  const until = addDays(localDate(account.timezoneName, now), -1 - p.maturityDays),
    since = addDays(until, 1 - days);
  const summary = summarize(data.series, since, until),
    previous = summarize(data.series, addDays(since, -days), addDays(since, -1));
  const actionsInWindow = data.actions.filter((a) => {
    const day = localDate(account.timezoneName, a.dispatchAt ?? a.createdAt);
    return day >= since && day <= until;
  });
  const incidents = await tx
    .select()
    .from(monitoringIncidents)
    .where(eq(monitoringIncidents.adAccountId, account.id));
  const followups = await tx
    .select()
    .from(actionFollowups)
    .where(eq(actionFollowups.adAccountId, account.id));
  const events = await tx
    .select()
    .from(monitoringEvents)
    .where(
      and(
        eq(monitoringEvents.adAccountId, account.id),
        gte(monitoringEvents.at, new Date(`${since}T00:00:00Z`)),
      ),
    )
    .orderBy(desc(monitoringEvents.at))
    .limit(1000);
  const nextSteps = [
    ...(!account.lastInsightsSyncAt || summary.spend === null
      ? ['Revisar cobertura de datos y sincronización antes de interpretar resultados.']
      : []),
    ...incidents
      .filter((i) => ['open', 'acknowledged'].includes(i.status))
      .map((i) => `Revisar incidente ${i.id} (${i.category}, ${i.severity}).`),
    ...data.recommendations
      .filter((r) => r.status === 'accepted')
      .map((r) => `Revisar la ejecución autorizada de la recomendación ${r.id}.`),
    'Revisar los factores de confusión y diseñar un experimento antes de atribuir efectos a una acción.',
  ];
  const snapshot = {
    version: VERSION,
    generatedAt: now.toISOString(),
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      timezone: account.timezoneName,
    },
    window: { since, until, maturityDays: p.maturityDays },
    executive: {
      summary,
      previous,
      openIncidents: incidents.filter((i) => ['open', 'acknowledged', 'snoozed'].includes(i.status))
        .length,
      failedActions: actionsInWindow.filter((a) => a.state === 'failed').length,
      nextSteps,
    },
    technical: {
      series: data.series.filter((d) => d.date >= addDays(since, -days) && d.date <= until),
      audit: data.audit,
      findings: data.findings,
      recommendations: data.recommendations,
      actions: actionsInWindow,
      incidents,
      events,
      eventLimit: 1000,
      eventHistoryTruncated: events.length === 1000,
      followups,
      policy: p,
      externalEvents: p.externalEvents,
      crm: {
        status: 'unavailable',
        leadQuality: null,
        confirmedCalls: null,
        reason:
          'No hay una fuente CRM conectada y autorizada. Leads de Meta no equivalen a leads calificados ni llamadas confirmadas.',
      },
    },
    limitations: [
      'Informe descriptivo, no causal. Comparadores observacionales no garantizan tendencias paralelas ni ausencia de confusión.',
      'Un día ausente no equivale a cero. CPR = suma de gasto / suma de resultados; no se promedian ratios.',
      'Los resultados pueden revisarse después del plazo de maduración configurado; no se garantiza completitud.',
      'Objetivos, moneda, atribución y KPI deben coincidir para comparar. El snapshot conserva la versión de los datos al generar el informe.',
      'Los hallazgos, recomendaciones e incidentes reflejan el estado al generar el informe; las acciones y series corresponden al período indicado. La bitácora incluye decisiones posteriores al corte maduro.',
    ],
  };
  const report = first(
    await tx
      .insert(monitoringReports)
      .values({ tenantId, adAccountId: account.id, createdBy, periodKey, snapshot })
      .returning(),
  );
  await monitorEvent(
    tx,
    tenantId,
    account.id,
    'report_generated',
    { reportId: report.id, snapshotHash: hash(snapshot) },
    createdBy ?? undefined,
  );
  return report;
}
export type MonitorReport = Awaited<ReturnType<typeof reportSnapshot>>;
function reportSnapshot(snapshot: unknown) {
  return snapshot as {
    version: string;
    generatedAt: string;
    account: { id: string; name: string; currency: string; timezone: string };
    window: { since: string; until: string; maturityDays: number };
    executive: {
      summary: ReturnType<typeof summarize>;
      previous: ReturnType<typeof summarize>;
      openIncidents: number;
      failedActions: number;
      nextSteps: string[];
    };
    technical: {
      series: MonitorData['series'];
      audit: MonitorData['audit'];
      findings: MonitorData['findings'];
      recommendations: MonitorData['recommendations'];
      actions: MonitorData['actions'];
      incidents: (typeof monitoringIncidents.$inferSelect)[];
      events: (typeof monitoringEvents.$inferSelect)[];
      eventLimit: number;
      eventHistoryTruncated: boolean;
      followups: (typeof actionFollowups.$inferSelect)[];
      policy: MonitoringPolicy;
      externalEvents: MonitoringPolicy['externalEvents'];
      crm: { status: string; leadQuality: null; confirmedCalls: null; reason: string };
    };
    limitations: string[];
  };
}

export function createMonitoringService(db: Db) {
  return {
    overview: (ctx: TenantContext, id: string) =>
      withContext(db, ctx, async (tx) => {
        const account = await findAccount(tx, ctx, id),
          p = await policyFor(tx, id),
          data = await loadMonitorData(tx, account, addDays(localDate(account.timezoneName), -1));
        const incidents = await tx
          .select()
          .from(monitoringIncidents)
          .where(eq(monitoringIncidents.adAccountId, id))
          .orderBy(desc(monitoringIncidents.updatedAt));
        const runs = await tx
          .select()
          .from(monitoringRuns)
          .where(eq(monitoringRuns.adAccountId, id))
          .orderBy(desc(monitoringRuns.at))
          .limit(30);
        const reports = await tx
          .select({ id: monitoringReports.id, at: monitoringReports.at })
          .from(monitoringReports)
          .where(eq(monitoringReports.adAccountId, id))
          .orderBy(desc(monitoringReports.at))
          .limit(30);
        const followups = await tx
          .select()
          .from(actionFollowups)
          .where(eq(actionFollowups.adAccountId, id));
        const notifications = await tx
          .select({
            id: monitoringDeliveries.id,
            channel: monitoringDeliveries.channel,
            status: monitoringDeliveries.status,
            incidentIds: monitoringDeliveries.incidentIds,
            error: monitoringDeliveries.error,
            createdAt: monitoringDeliveries.createdAt,
          })
          .from(monitoringDeliveries)
          .where(
            and(
              eq(monitoringDeliveries.adAccountId, id),
              eq(monitoringDeliveries.userId, ctx.userId),
            ),
          )
          .orderBy(desc(monitoringDeliveries.createdAt))
          .limit(50);
        return {
          policy: { revision: p.revision, config: p.config },
          readConsentActive: await hasReadConsent(tx, account),
          incidents,
          runs,
          reports,
          followups,
          notifications,
          series: data.series,
          entities: data.entities.map(({ level, id, name }) => ({ level, id, name })),
          crm: {
            status: 'unavailable' as const,
            reason: 'Sin CRM conectado; no se infieren calidad de leads ni llamadas confirmadas.',
          },
        };
      }),
    recipients: (ctx: TenantContext, id: string) =>
      withContext(db, ctx, async (tx) => {
        await findAccount(tx, ctx, id);
        const members = await tx
          .select({ id: memberships.userId, name: authUsers.name })
          .from(memberships)
          .innerJoin(authUsers, eq(authUsers.id, memberships.userId));
        const eligible = [];
        for (const m of members)
          if (await authorizedMember(tx, ctx.tenantId, id, m.id)) eligible.push(m);
        return eligible;
      }),
    setPolicy: (ctx: TenantContext, id: string, b: z.infer<typeof PolicyBody>) =>
      withContext(db, ctx, async (tx) => {
        const account = await findAccount(tx, ctx, id);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`monitor:${ctx.tenantId}:${id}`},0))`,
        );
        const old = await policyFor(tx, id);
        if (old.revision !== b.revision)
          throw conflict('La política cambió. Recarga antes de guardar.');
        if (b.policy.enabled && !(await hasReadConsent(tx, account)))
          throw badRequest('Se necesita cliente activo y consentimiento read_insights.');
        if (b.policy.notifications.email && !b.policy.notifications.recipientIds.length)
          throw badRequest('El correo requiere destinatarios autorizados.');
        for (const userId of b.policy.notifications.recipientIds) {
          const member = await authorizedMember(tx, ctx.tenantId, id, userId);
          if (!member || (b.policy.notifications.email && !member.verified))
            throw badRequest('Destinatario sin acceso o correo sin verificar.');
        }
        const revision = old.revision + 1;
        await tx
          .insert(monitoringPolicies)
          .values({
            tenantId: ctx.tenantId,
            adAccountId: id,
            config: b.policy,
            revision,
            authorizedBy: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [monitoringPolicies.tenantId, monitoringPolicies.adAccountId],
            set: { config: b.policy, revision, authorizedBy: ctx.userId, updatedAt: new Date() },
          });
        await monitorEvent(
          tx,
          ctx.tenantId,
          id,
          'policy_authorized',
          { revision, reason: b.reason, before: old.config, after: b.policy },
          ctx.userId,
        );
        await cancelQueued(tx, `monitor:${ctx.tenantId}:${id}:`);
        if (b.policy.enabled)
          await enqueue(tx, {
            tenantId: ctx.tenantId,
            kind: 'monitor_evaluate',
            payload: { adAccountId: id },
            dedupeKey: `monitor:${ctx.tenantId}:${id}:${revision}`,
            recurringEverySeconds: 900,
          });
        return { revision, config: b.policy };
      }),
    evaluate: async (ctx: TenantContext, id: string) => {
      await withContext(db, ctx, (tx) => findAccount(tx, ctx, id));
      return evaluateAccount(db, ctx.tenantId, id);
    },
    decide: (ctx: TenantContext, id: string, b: z.infer<typeof IncidentDecision>) =>
      withContext(db, ctx, async (tx) => {
        const [i] = await tx
          .select()
          .from(monitoringIncidents)
          .where(eq(monitoringIncidents.id, id))
          .for('update');
        if (!i) throw notFound('Incidente');
        await findAccount(tx, ctx, i.adAccountId);
        if (i.revision !== b.revision)
          throw conflict('El incidente cambió. Recarga antes de decidir.');
        if (i.status === 'pending' && b.status !== 'dismissed')
          throw badRequest('El incidente aún no alcanzó la persistencia requerida.');
        await tx
          .update(monitoringIncidents)
          .set({
            status: b.status,
            revision: i.revision + 1,
            snoozedUntil:
              b.status === 'snoozed' ? new Date(Date.now() + (b.snoozeHours ?? 1) * 3600000) : null,
            updatedAt: new Date(),
            ...(b.status === 'open' && { lastNotifiedAt: null }),
          })
          .where(eq(monitoringIncidents.id, id));
        await monitorEvent(
          tx,
          ctx.tenantId,
          i.adAccountId,
          'incident_decided',
          { from: i.status, to: b.status, reason: b.reason, snoozeHours: b.snoozeHours },
          ctx.userId,
          id,
        );
        return { ok: true };
      }),
    events: (ctx: TenantContext, id: string) =>
      withContext(db, ctx, async (tx) => {
        await findAccount(tx, ctx, id);
        return tx
          .select()
          .from(monitoringEvents)
          .where(eq(monitoringEvents.adAccountId, id))
          .orderBy(desc(monitoringEvents.at))
          .limit(300);
      }),
    report: (ctx: TenantContext, id: string, days: number) =>
      withContext(db, ctx, async (tx) => {
        const account = await findAccount(tx, ctx, id),
          p = await policyFor(tx, id),
          now = new Date(),
          data = await loadMonitorData(
            tx,
            account,
            addDays(localDate(account.timezoneName, now), -1),
          );
        await refreshFollowups(tx, ctx.tenantId, account, data, p.config, now);
        return saveReport(tx, ctx.tenantId, account, data, p.config, days, now, ctx.userId);
      }),
    getReport: (ctx: TenantContext, id: string) =>
      withContext(db, ctx, async (tx) => {
        const [r] = await tx.select().from(monitoringReports).where(eq(monitoringReports.id, id));
        if (!r) throw notFound('Informe');
        await findAccount(tx, ctx, r.adAccountId);
        return { ...r, snapshot: reportSnapshot(r.snapshot) };
      }),
  };
}
export type MonitoringOverview = Awaited<
  ReturnType<ReturnType<typeof createMonitoringService>['overview']>
>;

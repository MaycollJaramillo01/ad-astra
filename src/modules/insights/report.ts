import { and, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Tx } from '../../db/client.ts';
import {
  adAccounts,
  ads,
  adsets,
  campaigns,
  clients,
  insightsDaily,
  type Level,
  tenants,
} from '../../db/schema.ts';
import { notFound } from '../../platform/errors.ts';
import type { TenantContext } from '../../platform/http.ts';
import { seesAllClients } from '../../platform/rbac.ts';
import { findAccount } from '../catalog/routes.ts';
import { localDate } from '../meta/insights.ts';
import { clientScope } from '../tenancy/clients.routes.ts';
import {
  addDays,
  BASE_FIELDS,
  type CompareMode,
  comparisonRange,
  type DateRange,
  daysBetween,
  emptyTotals,
  type NodeLevel,
  type Preset,
  resolvePreset,
  type Totals,
} from './catalog.ts';

// Servicio de consultas de la analítica (F2). Una vista = un informe: totales del nodo con su
// comparación, serie diaria, desglose de resultados, filas de los hijos y frescura de los datos.
// Todo se agrega en Postgres sobre insights_daily (ratios de sumas; los ratios los calcula el
// catálogo), con RLS y el alcance por cliente del usuario.

export interface ReportQuery {
  level: NodeLevel;
  id?: string;
  preset?: Preset;
  since?: string;
  until?: string;
  compare: CompareMode;
  currency?: string;
}

type Account = typeof adAccounts.$inferSelect;
interface Windows {
  cur: DateRange;
  prev: DateRange | null;
}
interface Agg {
  key: string | null;
  current: Totals;
  previous: Totals | null;
  /** Tipos de resultado de cada periodo: si hay varios, los resultados no se suman. */
  resultTypes: string[];
  previousResultTypes: string[];
  attribution: string[];
  /** Entidades distintas sumadas (para saber si el alcance es sumable). */
  sources: number;
}

const inWindow = (r: DateRange) => sql`${insightsDaily.date} between ${r.since} and ${r.until}`;

function totalsFrom(row: Record<string, unknown>, prefix: string): Totals {
  const t = emptyTotals();
  for (const f of BASE_FIELDS) {
    const v = row[`${prefix}${f}`];
    t[f] = v === null || v === undefined ? null : Number(v);
  }
  return t;
}

/** Sumas por grupo para el periodo actual y el de comparación, en una sola pasada. */
async function aggregate(
  tx: Tx,
  level: Level,
  where: SQL | undefined,
  w: Windows,
  key?: SQL | AnyPgColumn,
): Promise<Agg[]> {
  const fields: Record<string, SQL> = { key: key ? sql`(${key})::text` : sql`null::text` };
  for (const f of BASE_FIELDS) {
    fields[`c_${f}`] = sql`sum(${insightsDaily[f]}) filter (where ${inWindow(w.cur)})`;
    if (w.prev) fields[`p_${f}`] = sql`sum(${insightsDaily[f]}) filter (where ${inWindow(w.prev)})`;
  }
  const types = (r: DateRange) =>
    sql`array_remove(array_agg(distinct ${insightsDaily.resultIndicator}) filter (where ${insightsDaily.results} is not null and ${inWindow(r)}), null)`;
  fields.resultTypes = types(w.cur);
  if (w.prev) fields.previousResultTypes = types(w.prev);
  fields.attribution = sql`array_remove(array_agg(distinct ${insightsDaily.attributionSetting}) filter (where ${inWindow(w.cur)}), null)`;
  fields.sources = sql`count(distinct ${insightsDaily.entityMetaId}) filter (where ${inWindow(w.cur)})`;
  const query = tx
    .select(fields)
    .from(insightsDaily)
    .innerJoin(adAccounts, eq(adAccounts.id, insightsDaily.adAccountId))
    .where(
      and(
        eq(insightsDaily.level, level),
        where,
        w.prev ? or(inWindow(w.cur), inWindow(w.prev)) : inWindow(w.cur),
      ),
    )
    .$dynamic();
  const rows = (await (key ? query.groupBy(key) : query)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: (r.key as string | null) ?? null,
    current: totalsFrom(r, 'c_'),
    previous: w.prev ? totalsFrom(r, 'p_') : null,
    resultTypes: (r.resultTypes as string[] | null) ?? [],
    previousResultTypes: (r.previousResultTypes as string[] | null) ?? [],
    attribution: (r.attribution as string[] | null) ?? [],
    sources: Number(r.sources ?? 0),
  }));
}

/** El nivel de cuenta no trae `results` (Meta no lo da con objetivos mezclados): se toman de las campañas. */
function withResults(base: Agg[], fromCampaigns: Agg[]): Agg[] {
  const byKey = new Map(fromCampaigns.map((r) => [r.key, r]));
  return base.map((b) => {
    const r = byKey.get(b.key);
    return {
      ...b,
      current: { ...b.current, results: r?.current.results ?? null },
      previous: b.previous ? { ...b.previous, results: r?.previous?.results ?? null } : null,
      resultTypes: r?.resultTypes ?? [],
      previousResultTypes: r?.previousResultTypes ?? [],
    };
  });
}

const one = (rows: Agg[], w: Windows): Agg =>
  rows[0] ?? {
    key: null,
    current: emptyTotals(),
    previous: w.prev ? emptyTotals() : null,
    resultTypes: [],
    previousResultTypes: [],
    attribution: [],
    sources: 0,
  };

// --- Nodo de la jerarquía y su alcance

interface PathItem {
  level: NodeLevel;
  id: string | null;
  name: string;
}
interface Entity {
  level: 'campaign' | 'adset' | 'ad';
  metaId: string;
  adAccountId: string;
  campaignMetaId: string | null;
  adsetMetaId: string | null;
  name: string | null;
  status: string | null;
  deleted: boolean;
  learning: string | null;
  objective: string | null;
}
interface Node {
  level: NodeLevel;
  id: string | null;
  name: string;
  accounts: Account[];
  entity: Entity | null;
  path: PathItem[];
  clientStatus: string | null;
}

const learningOf = (info: unknown) =>
  info && typeof info === 'object' && 'status' in info
    ? String((info as { status: unknown }).status)
    : null;

/** Campaña, conjunto o anuncio por su id de Meta; si ya no está listado, por sus filas de Insights. */
async function findEntity(tx: Tx, level: Entity['level'], metaId: string): Promise<Entity> {
  if (!/^\d{1,30}$/.test(metaId)) throw notFound();
  let found: Entity | undefined;
  if (level === 'campaign') {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.metaId, metaId));
    if (c)
      found = {
        level,
        metaId,
        adAccountId: c.adAccountId,
        campaignMetaId: metaId,
        adsetMetaId: null,
        name: c.name,
        status: c.effectiveStatus,
        deleted: c.deletedAt !== null,
        learning: null,
        objective: c.objective,
      };
  } else if (level === 'adset') {
    const [a] = await tx.select().from(adsets).where(eq(adsets.metaId, metaId));
    if (a)
      found = {
        level,
        metaId,
        adAccountId: a.adAccountId,
        campaignMetaId: a.campaignMetaId,
        adsetMetaId: metaId,
        name: a.name,
        status: a.effectiveStatus,
        deleted: a.deletedAt !== null,
        learning: learningOf(a.learningStageInfo),
        objective: a.optimizationGoal,
      };
  } else {
    const [a] = await tx.select().from(ads).where(eq(ads.metaId, metaId));
    if (a)
      found = {
        level,
        metaId,
        adAccountId: a.adAccountId,
        campaignMetaId: a.campaignMetaId,
        adsetMetaId: a.adsetMetaId,
        name: a.name,
        status: a.effectiveStatus,
        deleted: a.deletedAt !== null,
        learning: null,
        objective: null,
      };
  }
  if (!found) {
    const [row] = await tx
      .select({
        adAccountId: insightsDaily.adAccountId,
        campaignMetaId: insightsDaily.campaignMetaId,
        adsetMetaId: insightsDaily.adsetMetaId,
      })
      .from(insightsDaily)
      .where(and(eq(insightsDaily.level, level), eq(insightsDaily.entityMetaId, metaId)))
      .limit(1);
    if (!row) throw notFound();
    found = {
      level,
      metaId,
      ...row,
      name: null,
      status: null,
      deleted: true,
      learning: null,
      objective: null,
    };
  }
  return found;
}

async function nameOf(
  tx: Tx,
  level: Entity['level'],
  metaId: string | null,
): Promise<string | null> {
  if (!metaId) return null;
  const table = level === 'campaign' ? campaigns : level === 'adset' ? adsets : ads;
  const [row] = await tx.select({ name: table.name }).from(table).where(eq(table.metaId, metaId));
  return row?.name ?? null;
}

async function resolveNode(
  tx: Tx,
  ctx: TenantContext,
  level: NodeLevel,
  id: string | undefined,
): Promise<Node> {
  const [tenant] = await tx
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId));
  const org: PathItem = { level: 'org', id: null, name: tenant?.name ?? 'Organización' };
  const visible = (where?: SQL) =>
    tx
      .select()
      .from(adAccounts)
      .where(and(clientScope(tx, ctx, adAccounts.clientId), where))
      .orderBy(adAccounts.name);

  const clientItem = async (clientId: string | null): Promise<PathItem> => {
    if (!clientId) return { level: 'client', id: 'none', name: 'Sin cliente' };
    const [c] = await tx
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, clientId));
    return { level: 'client', id: clientId, name: c?.name ?? 'Cliente' };
  };

  if (level === 'org') {
    return {
      level,
      id: null,
      name: org.name,
      accounts: await visible(),
      entity: null,
      path: [org],
      clientStatus: null,
    };
  }
  if (level === 'client') {
    if (id === 'none') {
      if (!seesAllClients(ctx.role)) throw notFound('Cliente');
      return {
        level,
        id,
        name: 'Sin cliente',
        accounts: await visible(isNull(adAccounts.clientId)),
        entity: null,
        path: [org, await clientItem(null)],
        clientStatus: null,
      };
    }
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Cliente');
    const [client] = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.id, id), clientScope(tx, ctx, clients.id)));
    if (!client) throw notFound('Cliente');
    const item = { level: 'client' as const, id, name: client.name };
    return {
      level,
      id,
      name: client.name,
      accounts: await visible(eq(adAccounts.clientId, id)),
      entity: null,
      path: [org, item],
      clientStatus: client.status,
    };
  }

  let entity: Entity | null = null;
  let accountId = id ?? '';
  if (level !== 'account') {
    entity = await findEntity(tx, level, id ?? '');
    accountId = entity.adAccountId;
  } else if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    throw notFound('Cuenta publicitaria');
  }
  const account = await findAccount(tx, ctx, accountId); // aplica el alcance por cliente
  const path: PathItem[] = [
    org,
    await clientItem(account.clientId),
    { level: 'account', id: account.id, name: account.name },
  ];
  if (entity) {
    const chain: Array<[Entity['level'], string | null]> = [
      ['campaign', entity.campaignMetaId],
      ['adset', entity.adsetMetaId],
      ['ad', entity.level === 'ad' ? entity.metaId : null],
    ];
    for (const [lvl, metaId] of chain) {
      if (!metaId) continue;
      const name = lvl === entity.level ? entity.name : await nameOf(tx, lvl, metaId);
      path.push({ level: lvl, id: metaId, name: name ?? `ID ${metaId}` });
      if (lvl === entity.level) break;
    }
  }
  const last = path[path.length - 1] as PathItem;
  return {
    level,
    id: id ?? null,
    name: last.name,
    accounts: [account],
    entity,
    path,
    clientStatus: null,
  };
}

// --- Informe

const accountIds = (accounts: Account[]) => accounts.map((a) => a.id);

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export async function buildReport(tx: Tx, ctx: TenantContext, q: ReportQuery) {
  const node = await resolveNode(tx, ctx, q.level, q.id);
  const timezone = mostCommon(node.accounts.map((a) => a.timezoneName)) ?? 'UTC';
  const today = localDate(timezone);
  const cur =
    q.since && q.until
      ? { since: q.since, until: q.until }
      : resolvePreset(q.preset ?? 'last_7d', today);
  const w: Windows = { cur, prev: comparisonRange(cur, q.compare) };

  // Monedas (ADR-020): nunca se suman monedas distintas. Por defecto, la de más gasto.
  const allIds = accountIds(node.accounts);
  const spendByCurrency = allIds.length
    ? await aggregate(
        tx,
        'account',
        inArray(insightsDaily.adAccountId, allIds),
        { cur, prev: null },
        adAccounts.currency,
      )
    : [];
  const currencies = [...new Set(node.accounts.map((a) => a.currency))].map((code) => ({
    code,
    accounts: node.accounts.filter((a) => a.currency === code).length,
    spend: spendByCurrency.find((r) => r.key === code)?.current.spend ?? null,
  }));
  currencies.sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.accounts - a.accounts);
  const currency =
    currencies.find((c) => c.code === q.currency)?.code ?? currencies[0]?.code ?? null;
  const accounts = node.accounts.filter((a) => a.currency === currency);
  const ids = accountIds(accounts);

  // Filas del propio nodo: las de su nivel. Para cartera, cliente y cuenta, las de cuenta.
  const e = node.entity;
  const nodeLevel: Level = e ? e.level : 'account';
  const nodeWhere: SQL | undefined = e
    ? and(eq(insightsDaily.adAccountId, e.adAccountId), eq(insightsDaily.entityMetaId, e.metaId))
    : inArray(insightsDaily.adAccountId, ids);
  const fromAccounts = !e;

  const withCampaignResults = async (rows: Agg[], key?: SQL | AnyPgColumn) =>
    fromAccounts ? withResults(rows, await aggregate(tx, 'campaign', nodeWhere, w, key)) : rows;

  const totals = one(await withCampaignResults(await aggregate(tx, nodeLevel, nodeWhere, w)), w);

  // Serie diaria: una fila por fecha; las del periodo actual llenan `current` y las del de comparación, `previous`.
  const dateKey = sql`${insightsDaily.date}`;
  const daily = new Map(
    (await withCampaignResults(await aggregate(tx, nodeLevel, nodeWhere, w, dateKey), dateKey)).map(
      (r) => [r.key, r],
    ),
  );
  const days = daysBetween(cur.since, cur.until);
  const series = Array.from({ length: days }, (_, i) => {
    const date = addDays(cur.since, i);
    const previousDate = w.prev ? addDays(w.prev.since, i) : null;
    return {
      date,
      previousDate,
      current: daily.get(date)?.current ?? emptyTotals(),
      previous: previousDate ? (daily.get(previousDate)?.previous ?? emptyTotals()) : null,
    };
  });

  const resultsLevel: Level = e ? e.level : 'campaign';
  const results = (
    await aggregate(
      tx,
      resultsLevel,
      and(nodeWhere, isNotNull(insightsDaily.resultIndicator)),
      w,
      insightsDaily.resultIndicator,
    )
  )
    .map((r) => ({
      indicator: r.key ?? '',
      current: r.current.results,
      previous: r.previous?.results ?? null,
    }))
    .sort((a, b) => (b.current ?? 0) - (a.current ?? 0));

  const children = await buildChildren(tx, node, accounts, w, withCampaignResults);

  const [until] = await tx
    .select({ max: sql<string | null>`max(${insightsDaily.date})::text` })
    .from(insightsDaily)
    .where(and(eq(insightsDaily.level, nodeLevel), nodeWhere));
  const syncing = accounts.filter((a) => a.syncEnabled);
  const syncTimes = syncing
    .map((a) => a.lastInsightsSyncAt?.getTime())
    .filter((t): t is number => t !== undefined);

  return {
    node: {
      level: node.level,
      id: node.id,
      name: node.name,
      statusKind: e
        ? ('delivery' as const)
        : node.level === 'account'
          ? ('account' as const)
          : ('client' as const),
      status: e
        ? e.status
        : node.level === 'account'
          ? String(accounts[0]?.accountStatus ?? '')
          : node.clientStatus,
      deleted: e?.deleted ?? false,
      learning: e?.learning ?? null,
      objective: e?.objective ?? null,
      accountId: e
        ? e.adAccountId
        : node.level === 'account'
          ? (node.accounts[0]?.id ?? null)
          : null,
    },
    path: node.path,
    range: { ...cur, days, preset: q.since ? null : (q.preset ?? 'last_7d') },
    compare: w.prev ? { mode: q.compare, ...w.prev } : null,
    today,
    timezones: [...new Set(accounts.map((a) => a.timezoneName))],
    currency,
    currencies,
    totals: {
      current: totals.current,
      previous: totals.previous,
      resultTypes: totals.resultTypes,
      previousResultTypes: totals.previousResultTypes,
      sources: fromAccounts ? accounts.length : 1,
    },
    attribution: totals.attribution,
    series,
    results,
    children,
    freshness: {
      accounts: accounts.length,
      syncEnabled: syncing.length,
      neverSynced: syncing.length - syncTimes.length,
      oldestSyncAt: syncTimes.length ? new Date(Math.min(...syncTimes)).toISOString() : null,
      newestSyncAt: syncTimes.length ? new Date(Math.max(...syncTimes)).toISOString() : null,
      dataUntil: until?.max ?? null,
      immatureFrom: addDays(today, -7),
      finalBefore: addDays(today, -28),
    },
  };
}

export type Report = Awaited<ReturnType<typeof buildReport>>;

// --- Hijos del nodo: clientes de la cartera, cuentas de un cliente, campañas, conjuntos, anuncios

const CHILD_LEVEL = {
  org: 'client',
  client: 'account',
  account: 'campaign',
  campaign: 'adset',
  adset: 'ad',
} as const;

async function buildChildren(
  tx: Tx,
  node: Node,
  accounts: Account[],
  w: Windows,
  withCampaignResults: (rows: Agg[], key?: SQL | AnyPgColumn) => Promise<Agg[]>,
) {
  if (node.level === 'ad') return null;
  const level = CHILD_LEVEL[node.level];
  const ids = accountIds(accounts);
  const rowsOf = (aggs: Agg[]) => new Map(aggs.map((a) => [a.key, a]));
  const base = {
    statusKind: 'delivery' as 'delivery' | 'account' | 'client',
    deleted: false,
    learning: null as string | null,
    objective: null as string | null,
    currency: accounts[0]?.currency ?? null,
    lastSyncAt: null as string | null,
    accounts: 1,
  };
  const withTotals = (id: string, data: Agg | undefined) => ({
    current: data?.current ?? emptyTotals(),
    previous: w.prev ? (data?.previous ?? emptyTotals()) : null,
    resultTypes: data?.resultTypes ?? [],
    previousResultTypes: data?.previousResultTypes ?? [],
    sources: data?.sources ?? 0,
    id,
  });

  if (level === 'client' || level === 'account') {
    if (!ids.length) return { level, rows: [] };
    const key =
      level === 'client'
        ? sql`coalesce(${adAccounts.clientId}::text, 'none')`
        : sql`${insightsDaily.adAccountId}`;
    const data = rowsOf(
      await withCampaignResults(
        await aggregate(tx, 'account', inArray(insightsDaily.adAccountId, ids), w, key),
        key,
      ),
    );
    if (level === 'account') {
      return {
        level,
        rows: accounts.map((a) => ({
          ...base,
          ...withTotals(a.id, data.get(a.id)),
          name: a.name,
          statusKind: 'account' as const,
          status: String(a.accountStatus),
          currency: a.currency,
          lastSyncAt: a.syncEnabled ? (a.lastInsightsSyncAt?.toISOString() ?? null) : null,
        })),
      };
    }
    const clientIds = [...new Set(accounts.map((a) => a.clientId))];
    const named = await tx
      .select({ id: clients.id, name: clients.name, status: clients.status })
      .from(clients)
      .where(
        inArray(
          clients.id,
          clientIds.filter((c): c is string => c !== null),
        ),
      );
    return {
      level,
      rows: clientIds.map((clientId) => {
        const c = named.find((n) => n.id === clientId);
        const id = clientId ?? 'none';
        return {
          ...base,
          ...withTotals(id, data.get(id)),
          name: c?.name ?? 'Sin cliente',
          statusKind: 'client' as const,
          status: c?.status ?? null,
          accounts: accounts.filter((a) => a.clientId === clientId).length,
        };
      }),
    };
  }

  // Entidades de Meta: las listadas más las que tienen datos aunque ya no se listen.
  const e = node.entity;
  const accountId = e ? e.adAccountId : (accounts[0]?.id ?? '');
  const parentWhere =
    level === 'campaign'
      ? eq(insightsDaily.adAccountId, accountId)
      : level === 'adset'
        ? and(
            eq(insightsDaily.adAccountId, accountId),
            eq(insightsDaily.campaignMetaId, e?.metaId ?? ''),
          )
        : and(
            eq(insightsDaily.adAccountId, accountId),
            eq(insightsDaily.adsetMetaId, e?.metaId ?? ''),
          );
  const data = rowsOf(await aggregate(tx, level, parentWhere, w, insightsDaily.entityMetaId));

  const listed =
    level === 'campaign'
      ? (await tx.select().from(campaigns).where(eq(campaigns.adAccountId, accountId))).map(
          (c) => ({
            id: c.metaId,
            name: c.name,
            status: c.effectiveStatus,
            deleted: c.deletedAt !== null,
            learning: null,
            objective: c.objective,
          }),
        )
      : level === 'adset'
        ? (
            await tx
              .select()
              .from(adsets)
              .where(
                and(eq(adsets.adAccountId, accountId), eq(adsets.campaignMetaId, e?.metaId ?? '')),
              )
          ).map((a) => ({
            id: a.metaId,
            name: a.name,
            status: a.effectiveStatus,
            deleted: a.deletedAt !== null,
            learning: learningOf(a.learningStageInfo),
            objective: a.optimizationGoal,
          }))
        : (
            await tx
              .select()
              .from(ads)
              .where(and(eq(ads.adAccountId, accountId), eq(ads.adsetMetaId, e?.metaId ?? '')))
          ).map((a) => ({
            id: a.metaId,
            name: a.name,
            status: a.effectiveStatus,
            deleted: a.deletedAt !== null,
            learning: null,
            objective: null,
          }));
  const known = new Set(listed.map((l) => l.id));
  const orphans = [...data.keys()]
    .filter((k): k is string => k !== null && !known.has(k))
    .map((id) => ({
      id,
      name: `ID ${id}`,
      status: null,
      deleted: true,
      learning: null,
      objective: null,
    }));
  return {
    level,
    rows: [...listed, ...orphans]
      .filter((l) => !l.deleted || data.has(l.id)) // lo borrado sin datos en el periodo no aporta
      .map((l) => ({ ...base, ...l, ...withTotals(l.id, data.get(l.id)) })),
  };
}

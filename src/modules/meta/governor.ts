import { setTimeout as sleep } from 'node:timers/promises';
import { and, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { metaRateState } from '../../db/schema.ts';
import {
  MetaApiError,
  type MetaClient,
  type MetaResponse,
  type MetaUsage,
  requestsLessData,
} from './client.ts';

// Gobernador de cuotas (ARCHITECTURE §6.3). Meta limita por app y por app + cuenta: las claves
// de bloqueo llevan el id de la app ("<app>|app", "<app>|insights", "<app>|account:act_1").
//   - Antes de cada llamada: si algún ámbito está bloqueado → ThrottledError (el trabajo se
//     reprograma sin gastar intento).
//   - Tras cada respuesta: uso ≥ 90 % en un ámbito → se bloquea el tiempo que indique Meta.
//     ≥ 75 % → pausa entre llamadas.
//   - Error de throttling de Meta → se bloquea el ámbito afectado.
// ponytail: el estado vive en una tabla y no se reparte la cuota entre tenants (TD-02).

const HARD_PCT = 90;
const SOFT_PCT = 75;
const DEFAULT_BLOCK_SECONDS = { app: 300, insights: 60, account: 300 } as const;

export class ThrottledError extends Error {
  readonly until: Date;
  readonly scope: string;
  constructor(scope: string, until: Date) {
    super(`Cuota de Meta agotada en ${scope} hasta ${until.toISOString()}`);
    this.name = 'ThrottledError';
    this.scope = scope;
    this.until = until;
  }
}

export function createGovernor(db: Db, appKey: string) {
  const key = {
    app: `${appKey}|app`,
    insights: `${appKey}|insights`,
    account: (metaAccountId: string) => `${appKey}|account:${metaAccountId}`,
  };

  async function block(scope: string, seconds: number, usage?: MetaUsage): Promise<Date> {
    const until = new Date(Date.now() + seconds * 1000);
    await db
      .insert(metaRateState)
      .values({ scope, blockedUntil: until, lastUsage: usage?.raw ?? null })
      .onConflictDoUpdate({
        target: metaRateState.scope,
        set: {
          blockedUntil: sql`greatest(coalesce(${metaRateState.blockedUntil}, excluded.blocked_until), excluded.blocked_until)`,
          lastUsage: sql`coalesce(excluded.last_usage, ${metaRateState.lastUsage})`,
          updatedAt: sql`now()`,
        },
      });
    return until;
  }

  return {
    key,

    /** Primer ámbito bloqueado de la lista, o null si se puede llamar. */
    async blocked(scopes: string[]): Promise<ThrottledError | null> {
      const rows = await db
        .select()
        .from(metaRateState)
        .where(
          and(inArray(metaRateState.scope, scopes), gt(metaRateState.blockedUntil, new Date())),
        );
      const worst = rows.sort(
        (a, b) => (b.blockedUntil?.getTime() ?? 0) - (a.blockedUntil?.getTime() ?? 0),
      )[0];
      return worst?.blockedUntil ? new ThrottledError(worst.scope, worst.blockedUntil) : null;
    },

    /** Registra el uso de una respuesta y bloquea los ámbitos que pasan del umbral. */
    async observe(usage: MetaUsage, metaAccountId?: string): Promise<{ paceMs: number }> {
      const scopes: Array<[keyof typeof DEFAULT_BLOCK_SECONDS, string | undefined]> = [
        ['app', key.app],
        ['insights', key.insights],
        ['account', metaAccountId ? key.account(metaAccountId) : undefined],
      ];
      for (const [kind, scope] of scopes) {
        const pct = usage.byScope[kind];
        if (scope && pct !== undefined && pct >= HARD_PCT) {
          await block(scope, usage.regainSeconds ?? DEFAULT_BLOCK_SECONDS[kind], usage);
        }
      }
      return { paceMs: (usage.maxPct ?? 0) >= SOFT_PCT ? 1000 : 0 };
    },

    /** Bloquea el ámbito de un error de throttling de Meta y devuelve el error a propagar. */
    async fromApiError(err: MetaApiError, metaAccountId?: string): Promise<ThrottledError | null> {
      if (err.action.kind !== 'throttle') return null;
      const kind =
        err.action.scope === 'app:insights'
          ? 'insights'
          : err.action.scope === 'account'
            ? 'account'
            : 'app';
      const scope =
        kind === 'account' && metaAccountId
          ? key.account(metaAccountId)
          : kind === 'insights'
            ? key.insights
            : key.app;
      const until = await block(
        scope,
        err.usage.regainSeconds ?? DEFAULT_BLOCK_SECONDS[kind],
        err.usage,
      );
      return new ThrottledError(scope, until);
    },
  };
}

export type Governor = ReturnType<typeof createGovernor>;

/**
 * Sesión de llamadas a Meta para un trabajo: pasa por el gobernador, cuenta las llamadas y
 * pagina por cursor. Lanza ThrottledError cuando hay que esperar.
 */
export function createMetaSession(opts: {
  client: MetaClient;
  governor: Governor;
  metaAccountId?: string;
  /** Pausa ante uso alto (0 en tests). */
  pace?: boolean;
}) {
  let calls = 0;
  const { client, governor, metaAccountId } = opts;

  async function call<T>(
    insights: boolean,
    fn: () => Promise<MetaResponse<T>>,
  ): Promise<MetaResponse<T>> {
    const scopes = [governor.key.app];
    if (insights) scopes.push(governor.key.insights);
    if (metaAccountId) scopes.push(governor.key.account(metaAccountId));
    const blocked = await governor.blocked(scopes);
    if (blocked) throw blocked;
    calls++;
    try {
      const res = await fn();
      const { paceMs } = await governor.observe(res.usage, metaAccountId);
      if (paceMs && opts.pace !== false) await sleep(paceMs);
      return res;
    } catch (err) {
      if (err instanceof MetaApiError) {
        const throttled = await governor.fromApiError(err, metaAccountId);
        if (throttled) throw throttled;
      }
      throw err;
    }
  }

  type Params = Record<string, string | number | undefined>;
  return {
    get calls() {
      return calls;
    },
    get: <T>(path: string, params: Params, insights = false) =>
      call(insights, () => client.get<T>(path, params)),

    /** Todas las páginas. Un error a mitad se propaga: nunca se devuelve un resultado truncado. */
    async getAll<T>(path: string, params: Params, insights = false): Promise<T[]> {
      const rows: T[] = [];
      let after: string | undefined;
      let limit = typeof params.limit === 'number' ? params.limit : undefined;
      while (true) {
        let page: MetaResponse<{
          data?: T[];
          paging?: { next?: string; cursors?: { after?: string } };
        }>;
        try {
          page = await call(insights, () =>
            client.get<{ data?: T[]; paging?: { next?: string; cursors?: { after?: string } } }>(
              path,
              { ...params, ...(limit !== undefined ? { limit } : {}), after },
            ),
          );
        } catch (error) {
          // Insights reduce primero su rango temporal en sync.ts, sin repetir páginas pesadas.
          if (insights || !requestsLessData(error) || limit === undefined || limit <= 25)
            throw error;
          limit = Math.max(25, Math.floor(limit / 2));
          continue;
        }
        const { body } = page;
        rows.push(...(body.data ?? []));
        after = body.paging?.next ? body.paging.cursors?.after : undefined;
        if (!after) return rows;
      }
    },
  };
}

export type MetaSession = ReturnType<typeof createMetaSession>;

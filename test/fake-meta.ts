import { appSecretProof } from '../src/modules/meta/client.ts';

// Meta simulado para los tests: responde como Graph API (rutas, paginación por cursor, errores
// con code/subcode, cabeceras de uso) sin red ni credenciales reales. Comprueba lo que Meta
// comprobaría: token válido y appsecret_proof correcto.

type Raw = Record<string, unknown>;
type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

const DAY = 86_400_000;
const days = (since: string, until: string) => {
  const out: string[] = [];
  for (let t = Date.parse(since); t <= Date.parse(until); t += DAY)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

export function createFakeMeta(opts: { appId: string; appSecret: string }) {
  const appToken = `${opts.appId}|${opts.appSecret}`;
  const state = {
    /** Tokens de conexión que Meta conoce. */
    tokens: new Map<string, { valid: boolean; scopes: string[]; appId?: string }>(),
    accounts: [] as Raw[],
    /** Listados por arista: 'act_1/campaigns' → filas. */
    edges: new Map<string, Raw[]>(),
    pageSize: 2,
    /** Rango máximo que acepta Insights antes de pedir "menos datos" (100/1487534). */
    maxDays: Number.POSITIVE_INFINITY,
    /** Gasto por fila: cambiarlo simula que Meta reexpresa los datos. */
    spend: '10.5',
    /** Cabeceras de uso que acompañan a cada respuesta. */
    headers: {} as Record<string, string>,
  };
  const calls: Array<{ path: string; params: URLSearchParams }> = [];
  const failures: Array<{ match: RegExp; reply: Reply | 'network'; times: number }> = [];

  const reply = ({ status = 200, body, headers }: Reply) =>
    new Response(JSON.stringify(body), { status, headers: { ...state.headers, ...headers } });
  const error = (code: number, message: string, subcode?: number, status = 400) =>
    reply({
      status,
      body: { error: { code, error_subcode: subcode, message, fbtrace_id: 'trace' } },
    });

  function page(rows: unknown[], params: URLSearchParams, token: string) {
    const size = Math.min(Number(params.get('limit') ?? 25), state.pageSize);
    const start = Number(params.get('after') ?? 0);
    const end = start + size;
    const more = end < rows.length;
    return reply({
      body: {
        data: rows.slice(start, end),
        paging: {
          cursors: { after: String(end) },
          // Como en Meta, `next` lleva el token: el cliente no debe seguirla.
          ...(more && {
            next: `https://graph.facebook.com/next?access_token=${token}&after=${end}`,
          }),
        },
      },
    });
  }

  function insights(act: string, params: URLSearchParams): Raw[] {
    const level = params.get('level') ?? 'account';
    const { since, until } = JSON.parse(params.get('time_range') ?? '{}') as {
      since: string;
      until: string;
    };
    const ids =
      level === 'account'
        ? [{}]
        : (state.edges.get(`${act}/${level === 'ad' ? 'ads' : `${level}s`}`) ?? []).map((e) => ({
            [`${level}_id`]: e.id,
            campaign_id: e.campaign_id ?? e.id,
          }));
    return days(since, until).flatMap((date) =>
      ids.map((id) => ({
        account_id: act.slice(4),
        ...id,
        date_start: date,
        date_stop: date,
        spend: state.spend,
        impressions: '1000',
        reach: '800',
        clicks: '12',
        inline_link_clicks: '9',
        actions: [{ action_type: 'lead', value: '2' }],
        attribution_setting: '7d_click_1d_view',
      })),
    );
  }

  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const params = url.searchParams;
    calls.push({ path, params });

    // Ad Astra manda el token en la cabecera: uno en la URL es un fallo del cliente.
    if (params.has('access_token'))
      return error(100, 'access_token en la URL (no permitido en los tests)');
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (params.get('appsecret_proof') !== appSecretProof(token, opts.appSecret)) {
      return error(100, 'Invalid appsecret_proof provided in the API argument');
    }
    const injected = failures.find((f) => f.times > 0 && f.match.test(path));
    if (injected) {
      injected.times--;
      // Los errores de red reales incluyen la URL completa (con el token).
      if (injected.reply === 'network') throw new TypeError(`fetch failed: ECONNRESET ${url.href}`);
      return reply(injected.reply);
    }

    if (path === '/debug_token') {
      if (token !== appToken) return error(190, 'Invalid OAuth access token.');
      const t = state.tokens.get(params.get('input_token') ?? '');
      return reply({
        body: {
          data: {
            app_id: t?.appId ?? opts.appId,
            type: 'SYSTEM_USER',
            is_valid: t?.valid ?? false,
            expires_at: 0,
            scopes: t?.scopes ?? [],
          },
        },
      });
    }

    if (!state.tokens.get(token)?.valid) return error(190, 'Error validating access token', 460);

    if (path === '/me/adaccounts') return page(state.accounts, params, token);
    const m = /^\/(act_\d+)\/(campaigns|adsets|ads|insights)$/.exec(path);
    if (!m) return error(100, `Unknown path ${path}`);
    const [, act = '', edge] = m;
    if (edge === 'insights') {
      const { since, until } = JSON.parse(params.get('time_range') ?? '{}') as {
        since: string;
        until: string;
      };
      if (days(since, until).length > state.maxDays) {
        return error(100, 'Please reduce the amount of data you are asking for', 1487534);
      }
      return page(insights(act, params), params, token);
    }
    return page(state.edges.get(`${act}/${edge}`) ?? [], params, token);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    state,
    calls,
    /** Las próximas `times` llamadas cuya ruta encaje responden con `r` (o fallan por red). */
    fail(match: RegExp, r: Reply | 'network', times = 1) {
      failures.push({ match, reply: r, times });
    },
    clearFailures() {
      failures.length = 0;
    },
  };
}

export type FakeMeta = ReturnType<typeof createFakeMeta>;

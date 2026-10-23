import { createHmac } from 'node:crypto';
import { redact } from '../../platform/logging.ts';
import { classifyMetaError, type ErrorAction } from './errors.ts';

// Única constante de versión (ADR-005). Se registra en cada sync_run.
export const META_API_VERSION = 'v26.0';
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Uso de cuota leído de las cabeceras de respuesta (docs/API_INTEGRATIONS.md §1.12). */
export interface MetaUsage {
  /** Mayor porcentaje de uso visto en cualquier cabecera, o null si no vino ninguna. */
  maxPct: number | null;
  /** Segundos hasta recuperar el acceso según Meta, o null si no lo indica. */
  regainSeconds: number | null;
  tier: string | null;
  raw: Record<string, unknown>;
}

const USAGE_HEADERS = [
  'x-app-usage',
  'x-ad-account-usage',
  'x-business-use-case-usage',
  'x-business-use-case', // nombre que usa la página de Marketing API (V-07)
  'x-fb-ads-insights-throttle',
];

export function parseUsage(headers: Headers): MetaUsage {
  const raw: Record<string, unknown> = {};
  const pcts: number[] = [];
  const regains: number[] = [];
  let tier: string | null = null;

  const take = (o: Record<string, unknown>) => {
    for (const k of [
      'call_count',
      'total_cputime',
      'total_time',
      'acc_id_util_pct',
      'app_id_util_pct',
    ]) {
      if (typeof o[k] === 'number') pcts.push(o[k]);
    }
    if (typeof o.estimated_time_to_regain_access === 'number') {
      regains.push(o.estimated_time_to_regain_access * 60); // Meta lo da en minutos
    }
    if (typeof o.reset_time_duration === 'number') regains.push(o.reset_time_duration); // segundos
    if (typeof o.ads_api_access_tier === 'string') tier = o.ads_api_access_tier;
  };

  for (const name of USAGE_HEADERS) {
    const value = headers.get(name);
    if (!value) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      raw[name] = value; // formato inesperado: se guarda tal cual para el diagnóstico
      continue;
    }
    raw[name] = parsed;
    if (name.startsWith('x-business-use-case')) {
      // { "<id de negocio o cuenta>": [{ type, call_count, ..., estimated_time_to_regain_access }] }
      for (const entries of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(entries)) for (const e of entries) take(e as Record<string, unknown>);
      }
    } else if (parsed && typeof parsed === 'object') {
      take(parsed as Record<string, unknown>);
    }
  }
  return {
    maxPct: pcts.length ? Math.max(...pcts) : null,
    regainSeconds: regains.length ? Math.max(...regains) : null,
    tier,
    raw,
  };
}

export class MetaApiError extends Error {
  readonly httpStatus: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly fbtraceId: string | undefined;
  readonly action: ErrorAction;
  readonly usage: MetaUsage;

  constructor(httpStatus: number, body: unknown, usage: MetaUsage) {
    const err = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
    const code = typeof err.code === 'number' ? err.code : undefined;
    const subcode = typeof err.error_subcode === 'number' ? err.error_subcode : undefined;
    super(
      redact(
        `Meta API ${httpStatus} code=${code} subcode=${subcode}: ${String(err.message ?? 'sin mensaje')}`,
      ),
    );
    this.name = 'MetaApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.subcode = subcode;
    this.fbtraceId = typeof err.fbtrace_id === 'string' ? err.fbtrace_id : undefined;
    this.action = classifyMetaError(code, subcode, err.is_transient === true);
    this.usage = usage;
  }
}

/** Fallo de transporte. El mensaje original puede incluir la URL con el token: se redacta. */
export class MetaNetworkError extends Error {
  readonly action: ErrorAction = { kind: 'retry' };
  constructor(cause: unknown) {
    super(
      redact(`Fallo de red con Meta: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
    this.name = 'MetaNetworkError';
  }
}

export interface MetaClientOptions {
  accessToken: string;
  appSecret: string;
  /** Envía el token en `Authorization: Bearer` en vez de en la URL (pendiente de V-02). */
  tokenInHeader?: boolean;
  /** Inyectable para tests: sin red real ni credenciales en la CI. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface MetaResponse<T> {
  body: T;
  usage: MetaUsage;
  headers: Headers;
}

type Params = Record<string, string | number | undefined>;

export function createMetaClient(opts: MetaClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const proof = appSecretProof(opts.accessToken, opts.appSecret);

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Params = {},
  ): Promise<MetaResponse<T>> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    query.set('appsecret_proof', proof);
    const headers: Record<string, string> = {};
    if (opts.tokenInHeader) headers.authorization = `Bearer ${opts.accessToken}`;
    else query.set('access_token', opts.accessToken);

    const url = `${BASE_URL}${path}`;
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    };
    let target = url;
    if (method === 'GET') target = `${url}?${query}`;
    else init.body = query; // application/x-www-form-urlencoded: el token no va en la URL

    let res: Response;
    try {
      res = await doFetch(target, init);
    } catch (e) {
      throw new MetaNetworkError(e);
    }
    const usage = parseUsage(res.headers);
    const body = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || body === null || (body as { error?: unknown }).error) {
      throw new MetaApiError(res.status, body, usage);
    }
    return { body, usage, headers: res.headers };
  }

  return {
    get: <T>(path: string, params?: Params) => request<T>('GET', path, params),
    post: <T>(path: string, params?: Params) => request<T>('POST', path, params),

    /**
     * Recorre todas las páginas por cursor. No sigue `paging.next` porque esa URL trae el token.
     * Un error a mitad lanza la excepción: nunca se devuelve un resultado truncado en silencio.
     */
    async *paginate<T>(
      path: string,
      params: Params = {},
    ): AsyncGenerator<MetaResponse<{ data: T[] }>> {
      let after: string | undefined;
      do {
        const page = await request<{
          data?: T[];
          paging?: { next?: string; cursors?: { after?: string } };
        }>('GET', path, { ...params, after });
        yield { ...page, body: { data: page.body.data ?? [] } };
        after = page.body.paging?.next ? page.body.paging.cursors?.after : undefined;
      } while (after);
    },
  };
}

export type MetaClient = ReturnType<typeof createMetaClient>;

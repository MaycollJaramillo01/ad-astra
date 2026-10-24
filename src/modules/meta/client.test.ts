import { describe, expect, it } from 'vitest';
import {
  appSecretProof,
  createMetaClient,
  MetaApiError,
  MetaNetworkError,
  parseUsage,
} from './client.ts';

const TOKEN = 'EAAtest-token';
const SECRET = 'app-secret';

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('respuesta no preparada');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('appSecretProof', () => {
  it('coincide con un HMAC-SHA256 calculado de forma independiente (Python hmac)', () => {
    expect(appSecretProof(TOKEN, SECRET)).toBe(
      'c86697ed2f51b08f0a03edbca0704f93d397f3ab925b1345fe6890c17b1f5439',
    );
  });
});

describe('parseUsage', () => {
  it('toma el mayor porcentaje y el mayor tiempo de espera de todas las cabeceras', () => {
    const usage = parseUsage(
      new Headers({
        'x-app-usage': JSON.stringify({ call_count: 12, total_cputime: 3, total_time: 5 }),
        'x-ad-account-usage': JSON.stringify({
          acc_id_util_pct: 40,
          reset_time_duration: 120,
          ads_api_access_tier: 'standard_access',
        }),
        'x-business-use-case-usage': JSON.stringify({
          '123': [
            {
              type: 'ads_insights',
              call_count: 91,
              total_cputime: 20,
              total_time: 30,
              estimated_time_to_regain_access: 7,
            },
          ],
        }),
      }),
    );
    expect(usage.maxPct).toBe(91);
    expect(usage.regainSeconds).toBe(420);
    expect(usage.tier).toBe('standard_access');
  });

  it('devuelve null (no 0) cuando no hay cabeceras de uso', () => {
    expect(parseUsage(new Headers())).toMatchObject({
      maxPct: null,
      regainSeconds: null,
      tier: null,
    });
  });
});

describe('createMetaClient', () => {
  it('añade appsecret_proof y versión, y el token va en la cabecera, nunca en la URL', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: '1' } }]);
    await createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetch: fn }).get('/me');
    const [call] = calls;
    if (!call) throw new Error('no se hizo ninguna llamada');
    expect(call.url).toMatch(/^https:\/\/graph\.facebook\.com\/v26\.0\/me\?/);
    expect(call.url).toContain(`appsecret_proof=${appSecretProof(TOKEN, SECRET)}`);
    expect(call.url).not.toContain(TOKEN);
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('en POST envía los parámetros en el cuerpo, no en la URL', async () => {
    const { fn, calls } = fakeFetch([{ body: { report_run_id: '9' } }]);
    await createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetch: fn }).post(
      '/act_1/insights',
      { level: 'ad' },
    );
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v26.0/act_1/insights');
    expect(String(calls[0]?.init.body)).toContain('level=ad');
    expect(String(calls[0]?.init.body)).not.toContain(TOKEN);
  });

  it('pagina por cursor sin seguir la URL de paging.next (que trae el token)', async () => {
    const { fn, calls } = fakeFetch([
      {
        body: {
          data: [1, 2],
          paging: { next: `https://x/?access_token=${TOKEN}`, cursors: { after: 'C1' } },
        },
      },
      { body: { data: [3], paging: { cursors: { after: 'C2' } } } },
    ]);
    const client = createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetch: fn });
    const rows: number[] = [];
    for await (const page of client.paginate<number>('/act_1/campaigns', { limit: 2 }))
      rows.push(...page.body.data);
    expect(rows).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('after=C1');
    expect(calls[1]?.url.startsWith('https://graph.facebook.com/v26.0/act_1/campaigns?')).toBe(
      true,
    );
  });

  it('un error de Meta a mitad de la paginación se propaga (sin truncar en silencio)', async () => {
    const { fn } = fakeFetch([
      { body: { data: [1], paging: { next: 'n', cursors: { after: 'C1' } } } },
      { status: 400, body: { error: { code: 80000, message: 'too many calls' } } },
    ]);
    const client = createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetch: fn });
    const consume = async () => {
      for await (const _ of client.paginate('/act_1/insights')) {
        // consumir
      }
    };
    await expect(consume()).rejects.toMatchObject({
      name: 'MetaApiError',
      code: 80000,
      action: { kind: 'throttle', scope: 'account' },
    });
  });

  it('clasifica el error 190 como de autenticación y conserva el uso de cuota', async () => {
    const { fn } = fakeFetch([
      {
        status: 401,
        body: {
          error: {
            code: 190,
            error_subcode: 463,
            message: 'Session has expired',
            fbtrace_id: 'T1',
          },
        },
        headers: { 'x-app-usage': JSON.stringify({ call_count: 5 }) },
      },
    ]);
    const err = await createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetch: fn })
      .get('/me')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ action: { kind: 'auth' }, fbtraceId: 'T1', usage: { maxPct: 5 } });
  });

  it('un fallo de red se convierte en MetaNetworkError reintentable y sin el token', async () => {
    const leaky = (async () => {
      throw new TypeError(
        `fetch failed for https://graph.facebook.com/v26.0/me?access_token=${TOKEN}`,
      );
    }) as unknown as typeof fetch;
    const err = await createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetch: leaky })
      .get('/me')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaNetworkError);
    expect((err as MetaNetworkError).action).toEqual({ kind: 'retry' });
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

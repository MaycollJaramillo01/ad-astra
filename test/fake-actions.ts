import { appSecretProof } from '../src/modules/meta/client.ts';

/** Graph simulado para escrituras: nunca realiza red ni usa credenciales reales. */
export function fakeActionMeta(opts: {
  appId: string;
  appSecret: string;
  token: string;
  accountId: string;
  entityId: string;
}) {
  const state = {
    scopes: ['ads_management', 'ads_read'],
    tasks: ['ADVERTISE'],
    accountStatus: 1,
    currency: 'EUR',
    timezone: 'Europe/Madrid',
    mode: 'normal' as
      | 'normal'
      | 'timeout-applied'
      | 'timeout-unapplied'
      | 'throttle'
      | 'reject'
      | 'lag',
    objects: new Map<string, Record<string, unknown>>([
      [
        opts.entityId,
        {
          id: opts.entityId,
          account_id: opts.accountId.slice(4),
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          daily_budget: '10000',
          lifetime_budget: '0',
          is_budget_schedule_enabled: false,
          stop_time: new Date(Date.now() + 365 * 86400000).toISOString(),
        },
      ],
    ]),
  };
  const writes: Array<{ id: string; params: Record<string, string> }> = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const failure = (code: number, subcode?: number) =>
    reply({ error: { code, error_subcode: subcode, message: 'Rechazo sintético' } }, 400);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input)),
      path = u.pathname.replace(/^\/v\d+\.\d+\//, ''),
      post = init?.method === 'POST';
    const params = post ? new URLSearchParams(String(init?.body)) : u.searchParams;
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    if (params.get('appsecret_proof') !== appSecretProof(token, opts.appSecret))
      return failure(100);
    if (path === 'debug_token')
      return reply({
        data: {
          is_valid: params.get('input_token') === opts.token,
          app_id: opts.appId,
          scopes: state.scopes,
          expires_at: 0,
        },
      });
    if (token !== opts.token) return failure(190);
    if (path === opts.accountId)
      return reply({
        id: opts.accountId,
        currency: state.currency,
        timezone_name: state.timezone,
        account_status: state.accountStatus,
        user_tasks: state.tasks,
      });
    const entity = state.objects.get(path);
    if (!entity) return failure(100);
    if (!post) return reply(entity);
    writes.push({
      id: path,
      params: Object.fromEntries([...params].filter(([k]) => k !== 'appsecret_proof')),
    });
    if (state.mode === 'throttle') {
      state.mode = 'normal';
      return failure(613, 4841018);
    }
    if (state.mode === 'reject') return failure(100);
    if (state.mode === 'timeout-unapplied') throw new TypeError('Synthetic timeout');
    if (state.mode !== 'lag')
      for (const key of ['status', 'daily_budget', 'lifetime_budget'])
        if (params.has(key)) {
          entity[key] = params.get(key);
          if (key === 'status') entity.effective_status = params.get(key);
        }
    if (state.mode === 'timeout-applied') throw new TypeError('Synthetic timeout after apply');
    return reply({ success: true });
  }) as typeof globalThis.fetch;
  return { state, writes, fetch };
}

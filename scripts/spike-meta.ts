// Spike de F0 contra Meta real (docs/API_INTEGRATIONS.md §1.20). Prueba MANUAL y AUTORIZADA
// (docs/TESTING.md §9): solo lectura. Nunca en la CI.
//   pnpm spike:meta     (lee .env.local)
// Salidas:
//   spike-output/report.json, spike-output/reconciliacion.csv  → locales, ignoradas por git
//   test/fixtures/meta/v26.0/*.json                             → sanitizadas; revisar antes del commit
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createMetaClient,
  META_API_VERSION,
  MetaApiError,
  type MetaClient,
  MetaNetworkError,
} from '../src/modules/meta/client.ts';
import { AD_LEVEL_INSIGHTS_FIELDS, FIELDS } from '../src/modules/meta/fields.ts';
import { createLogger, redact } from '../src/platform/logging.ts';
import { createSanitizer } from './sanitize.ts';

const log = createLogger();
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name}: copia .env.example a .env.local y rellénalo`);
  return v;
};
const appId = env('META_APP_ID');
const appSecret = env('META_APP_SECRET');
const token = env('META_ACCESS_TOKEN');

const meta = createMetaClient({ accessToken: token, appSecret });
const appToken = createMetaClient({ accessToken: `${appId}|${appSecret}`, appSecret });
const { sanitize } = createSanitizer();
const report: Record<string, unknown> = {
  api_version: META_API_VERSION,
  run_at: new Date().toISOString(),
};
const fixtures: Record<string, unknown> = {};
const headersSeen = new Map<string, string>();

type Row = Record<string, unknown>;

function describeError(e: unknown) {
  if (e instanceof MetaApiError) {
    const { httpStatus, code, subcode, action, fbtraceId, message } = e;
    return { httpStatus, code, subcode, action, fbtraceId, message };
  }
  if (e instanceof MetaNetworkError) return { network: true, message: e.message };
  return { message: redact(String(e)) };
}

async function step(id: string, fn: () => Promise<unknown>) {
  try {
    report[id] = { ok: true, result: await fn() };
    log.info({ step: id }, 'ok');
  } catch (e) {
    report[id] = { ok: false, error: describeError(e) };
    log.warn({ step: id, error: describeError(e) }, 'falló');
  }
}

function track(headers: Headers) {
  headers.forEach((value, name) => {
    if (name.startsWith('x-') && /usage|throttle|business-use-case/.test(name))
      headersSeen.set(name, value);
  });
}

async function all(client: MetaClient, path: string, params: Record<string, string | number>) {
  const rows: Row[] = [];
  for await (const page of client.paginate<Row>(path, params)) {
    track(page.headers);
    rows.push(...page.body.data);
  }
  return rows;
}

const insightsFields = (level: string) =>
  [...FIELDS.AdsInsights, ...(level === 'ad' ? AD_LEVEL_INSIGHTS_FIELDS : [])].join(',');

// --- 1. Token del usuario del sistema
await step('token', async () => {
  const { body } = await appToken.get<{ data: Row }>('/debug_token', { input_token: token });
  const d = body.data;
  return {
    type: d.type,
    app_id_matches: d.app_id === appId,
    is_valid: d.is_valid,
    expires_at: d.expires_at,
    data_access_expires_at: d.data_access_expires_at,
    scopes: d.scopes,
  };
});

// --- V-02: el cliente envía el token en Authorization: Bearer (sin access_token en la URL)
await step('V02_bearer_header', async () => {
  const { body } = await meta.get<{ id: string }>('/me', { fields: 'id' });
  return { accepted: Boolean(body.id) };
});

// --- Cuentas accesibles (V-01, V-05, V-12)
let accounts: Row[] = [];
await step('accounts', async () => {
  accounts = await all(meta, '/me/adaccounts', { fields: FIELDS.AdAccount.join(','), limit: 100 });
  fixtures.adaccounts = sanitize(accounts.slice(0, 5));
  return accounts.map((a) => ({
    id: a.id,
    currency: a.currency,
    timezone_name: a.timezone_name,
    account_status: a.account_status,
    user_tasks: a.user_tasks,
    owner_business_id: (a.business as Row | undefined)?.id ?? null,
    amount_spent_raw: a.amount_spent, // V-05: comparar con Ads Manager para confirmar unidades
    spend_cap_raw: a.spend_cap,
  }));
});

const accountId = process.env.META_SPIKE_ACCOUNT_ID || (accounts[0]?.id as string | undefined);
if (!accountId) {
  log.error('No hay cuentas accesibles: revisa las asignaciones del usuario del sistema');
} else {
  report.account_under_test = accountId;

  // --- Entidades (muestra)
  for (const [edge, object] of [
    ['campaigns', 'Campaign'],
    ['adsets', 'AdSet'],
    ['ads', 'Ad'],
    ['adcreatives', 'AdCreative'],
  ] as const) {
    await step(`entities_${edge}`, async () => {
      const { body, headers } = await meta.get<{ data: Row[] }>(`/${accountId}/${edge}`, {
        fields: FIELDS[object].join(','),
        limit: 50,
      });
      track(headers);
      fixtures[edge] = sanitize(body.data.slice(0, 5));
      return { first_page_count: body.data.length };
    });
  }

  // --- V-03: filtrado incremental por updated_time
  await step('V03_updated_time_filter', async () => {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const rows = await all(meta, `/${accountId}/campaigns`, {
      fields: 'id,updated_time',
      filtering: JSON.stringify([
        { field: 'updated_time', operator: 'GREATER_THAN', value: since },
      ]),
      limit: 500,
    });
    return { accepted: true, campaigns_updated_last_30d: rows.length };
  });

  // --- Insights síncronos en los 4 niveles (V-04, V-08) + conciliación (CA-F0-02)
  const syncCounts: Record<string, number> = {};
  for (const level of ['account', 'campaign', 'adset', 'ad']) {
    await step(`insights_sync_${level}`, async () => {
      const rows = await all(meta, `/${accountId}/insights`, {
        level,
        date_preset: 'last_30d', // respeta la zona horaria de la cuenta, como Ads Manager
        time_increment: 1,
        fields: insightsFields(level),
        limit: 500,
      });
      syncCounts[level] = rows.length;
      fixtures[`insights_${level}`] = sanitize(rows.slice(0, 3));
      if (level === 'account') {
        const csv = ['date,spend,impressions,clicks,inline_link_clicks'];
        for (const r of rows)
          csv.push(
            [r.date_start, r.spend, r.impressions, r.clicks, r.inline_link_clicks].join(','),
          );
        mkdirSync('spike-output', { recursive: true });
        writeFileSync('spike-output/reconciliacion.csv', `${csv.join('\n')}\n`);
      }
      return {
        rows: rows.length,
        attribution_settings: [...new Set(rows.map((r) => r.attribution_setting))],
        results_sample: rows.find((r) => r.results)?.results ?? null,
      };
    });
  }

  // --- Insights asíncronos (reexpresión / backfill)
  await step('insights_async_ad', async () => {
    const started = Date.now();
    const { body } = await meta.post<{ report_run_id: string }>(`/${accountId}/insights`, {
      level: 'ad',
      date_preset: 'last_30d',
      time_increment: 1,
      fields: insightsFields('ad'),
    });
    const runId = body.report_run_id;
    let status = '';
    while (Date.now() - started < 10 * 60_000) {
      const { body: run } = await meta.get<{
        async_status: string;
        async_percent_completion: number;
      }>(`/${runId}`, { fields: 'async_status,async_percent_completion' });
      status = run.async_status;
      if (['Job Completed', 'Job Failed', 'Job Skipped'].includes(status)) break;
      await sleep(5000);
    }
    const rows =
      status === 'Job Completed' ? await all(meta, `/${runId}/insights`, { limit: 500 }) : [];
    return {
      status,
      seconds: Math.round((Date.now() - started) / 1000),
      rows: rows.length,
      sync_rows: syncCounts.ad,
    };
  });

  // --- V-09: alcance del registro de actividad
  await step('V09_activities', async () => {
    const since = Math.floor(Date.now() / 1000) - 90 * 86400;
    const { body, headers } = await meta.get<{ data: Row[] }>(`/${accountId}/activities`, {
      fields: FIELDS.AdActivity.join(','),
      since,
      limit: 100,
    });
    track(headers);
    fixtures.activities = sanitize(body.data.slice(0, 5));
    const times = body.data.map((a) => String(a.event_time)).sort();
    return {
      first_page_count: body.data.length,
      oldest: times[0] ?? null,
      newest: times.at(-1) ?? null,
    };
  });
}

// --- V-07: cabeceras de uso realmente devueltas
report.V07_usage_headers = Object.fromEntries(headersSeen);

// Canario sobre nuestra propia salida: si el token o el secret aparecieran, no se escribe nada.
const serializedReport = JSON.stringify(report, null, 2);
const serializedFixtures = JSON.stringify(fixtures);
for (const secret of [token, appSecret]) {
  if (serializedReport.includes(secret) || serializedFixtures.includes(secret)) {
    throw new Error('La salida contiene una credencial: abortado sin escribir archivos');
  }
}
mkdirSync('spike-output', { recursive: true });
writeFileSync('spike-output/report.json', `${serializedReport}\n`);
const dir = `test/fixtures/meta/${META_API_VERSION}`;
mkdirSync(dir, { recursive: true });
for (const [name, data] of Object.entries(fixtures)) {
  writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(data, null, 2)}\n`);
}
log.info(
  { report: 'spike-output/report.json', fixtures: dir },
  'Spike terminado: revisa las fixtures antes del commit',
);

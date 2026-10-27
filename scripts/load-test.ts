import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { setTimeout } from 'node:timers/promises';

const port = 3002,
  base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['test/browser-server.ts'], {
  env: { ...process.env, TEST_SERVER_PORT: String(port), E2E_ACCOUNT_COUNT: '50' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.resume();
server.stderr.resume();
let exited = false;
server.once('exit', () => {
  exited = true;
});
try {
  let ready = false;
  for (let n = 0; n < 240; n++) {
    if (exited) throw new Error('Servidor de carga terminó antes de estar listo');
    try {
      if ((await fetch(`${base}/v1/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(250);
  }
  if (!ready) throw new Error('Servidor de carga no disponible');
  const f = JSON.parse(await readFile('spike-output/readiness/browser.json', 'utf8')) as {
    tenantId: string;
    ownerId: string;
    cookies: Record<string, string>;
    accounts: number;
    days: number;
    campaignId: string;
  };
  const until = new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    since = new Date(Date.now() - 395 * 86400000).toISOString().slice(0, 10);
  const headers = {
    'x-tenant-id': f.tenantId,
    cookie: `ad-astra.session_token=${f.cookies[f.ownerId]}`,
  };
  async function request(path: string) {
    const start = performance.now(),
      response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    return { ms: performance.now() - start, status: response.status };
  }
  async function measure(level: 'org' | 'campaign') {
    const path = `/v1/analytics?level=${level}&since=${since}&until=${until}&compare=none${level === 'campaign' ? `&id=${f.campaignId}` : ''}`;
    const cold = await request(path);
    for (let i = 0; i < 4; i++) await request(path);
    const samples: Array<{ ms: number; status: number }> = [],
      start = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        while (next++ < 100) samples.push(await request(path));
      }),
    );
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b),
      durationMs = performance.now() - start;
    const percentile = (p: number) => Math.round(sorted[Math.ceil(sorted.length * p) - 1] ?? 0);
    return {
      level,
      coldMs: Math.round(cold.ms),
      cacheMs: 15000,
      requests: samples.length,
      concurrency: 10,
      errors: samples.filter((s) => s.status !== 200).length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: Math.round(sorted.at(-1) ?? 0),
      requestsPerSecond: Number(((samples.length / durationMs) * 1000).toFixed(2)),
      targetP95Ms: level === 'org' ? 1500 : 500,
    };
  }
  const measurements = [await measure('org'), await measure('campaign')],
    evidence = {
      at: new Date().toISOString(),
      synthetic: true,
      transport: 'HTTP loopback + Better Auth + Fastify + Postgres RLS',
      dataset: {
        accounts: f.accounts,
        days: f.days,
        entitiesPerAccount: { campaign: 1, adset: 1, ad: 1 },
        dailyRows: 50 * 395 * 4,
      },
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      measurements,
      scope: 'Carga local; excluye red de nube, cold starts, Google OAuth y proveedores externos.',
    };
  await writeFile('spike-output/readiness/load.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (measurements.some((m) => m.errors > 0 || m.p95Ms >= m.targetP95Ms)) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Falló la carga');
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
}

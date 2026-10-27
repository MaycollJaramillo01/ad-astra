// Prueba MANUAL autorizada: API NVIDIA real + rutas, herramientas y verificador reales.
// Solo fixtures sintéticos en localhost:55432/ad_astra_test. Nunca usa la BD de producción.
// NVIDIA_API_KEY=... pnpm ai:smoke:nvidia -- --yes

import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { testEnv } from '../test/env.ts';

const { values } = parseArgs({ options: { yes: { type: 'boolean', default: false } } });
if (!values.yes)
  throw new Error('Indica --yes para autorizar llamadas NVIDIA con datos ficticios.');
const key = process.env.NVIDIA_API_KEY;
if (!key) throw new Error('Falta NVIDIA_API_KEY.');
Object.assign(process.env, testEnv, {
  NVIDIA_API_KEY: key,
  AI_PROVIDER: 'nvidia',
  AI_MODEL: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  AI_EFFORT: 'low',
});

const { eq } = await import('drizzle-orm');
const { withContext } = await import('../src/db/client.ts');
const s = await import('../src/db/schema.ts');
const { testApp } = await import('../test/app.ts');
const { seedTenant, testDb, loadEntities } = await import('../test/seed.ts');
const { stack, series, leadsDay } = await import('../test/audit-fixtures.ts');
const { loadConfig } = await import('../src/platform/config.ts');
const { createProvider } = await import('../src/modules/ai/provider.ts');
const config = loadConfig();
const llm = await createProvider(config);
if (!llm) throw new Error('No se pudo configurar NVIDIA.');
const db = testDb();
const tenant = await seedTenant(db, `nvidia-live-${crypto.randomUUID().slice(0, 8)}`);
await withContext(db, { tenantId: tenant.tenantId }, async (tx) => {
  await tx.insert(s.clientConsents).values({
    tenantId: tenant.tenantId,
    clientId: tenant.client.id,
    scope: ['read_insights', 'ai_processing'],
    grantedByName: 'Fixture sintético',
    grantedByEmail: 'fixture@example.test',
    grantedAt: new Date(),
    recordedBy: tenant.owner.id,
  });
  await tx
    .update(s.adAccounts)
    .set({ currency: 'USD', lastInsightsSyncAt: new Date() })
    .where(eq(s.adAccounts.id, tenant.account.id));
});
await loadEntities(db, tenant.tenantId, tenant.account.id, tenant.account.metaAccountId, [
  ...stack(
    '10001',
    series(7, () => leadsDay(100, 10)),
  ),
]);
const t = await testApp({ llm, config });
const rows: Array<Record<string, unknown>> = [];
let conversationId: string | null = null;
try {
  for (const question of [
    'Consulta las métricas de esta cuenta entre 2026-10-14 y 2026-10-20, sin comparación, y resume el gasto y los leads en USD. Usa solo las cifras de las herramientas; no recomiendes cambios.',
    'A partir de la misma evidencia, explica las limitaciones de esos datos sin calcular cifras nuevas ni proponer acciones.',
  ]) {
    const started = Date.now();
    const res = await t.as(tenant.owner, tenant.tenantId).post('/v1/ai/ask', {
      question,
      conversationId,
      view: { level: 'account', id: tenant.account.id },
    });
    if (res.statusCode !== 200) throw new Error(`Ruta del asistente: HTTP ${res.statusCode}`);
    const turn = res.json();
    conversationId = turn.conversationId;
    rows.push({
      http: res.statusCode,
      status: turn.message.status,
      verified: turn.message.verification?.status,
      tools: turn.message.evidence.map((e: { tool: string }) => e.tool),
      figures: turn.message.verification?.figures,
      citedValues: turn.message.answer?.claims.flatMap((c: { figures: Array<{ value: number }> }) =>
        c.figures.map((f) => f.value),
      ),
      issues: turn.message.verification?.issues.map((i: { code: string }) => i.code),
      budgetEstimateUsd: turn.message.costUsd,
      ms: Date.now() - started,
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
  const usage = await withContext(db, { tenantId: tenant.tenantId }, (tx) =>
    tx
      .select()
      .from(s.llmUsage)
      .where(eq(s.llmUsage.conversationId, conversationId as string)),
  );
  const report = {
    checkedAt: new Date().toISOString(),
    provider: llm.id,
    model: llm.model,
    syntheticDataOnly: true,
    database: 'localhost:55432/ad_astra_test',
    passed:
      rows.every((r) => r.status === 'answered') &&
      (rows[0]?.citedValues as number[] | undefined)?.includes(700) === true &&
      (rows[0]?.citedValues as number[] | undefined)?.includes(70) === true,
    turns: rows,
    calls: usage.map((u) => ({
      model: u.model,
      status: u.status,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      requestId: u.requestId,
    })),
  };
  await mkdir('spike-output', { recursive: true });
  await writeFile('spike-output/nvidia-assistant-smoke.json', JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await t.app.close();
}

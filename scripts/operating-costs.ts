import { mkdir, writeFile } from 'node:fs/promises';
import { costOf } from '../src/modules/ai/provider.ts';

export function estimate(input: {
  accounts: number;
  developers: number;
  cu: number;
  storageGb: number;
  historyGb: number;
  cpuHours: number;
  memoryGbHours: number;
  invocations: number;
  questions: number;
  insightPages: number;
  restatementPages: number;
  entityPages: number;
  extras: [number, number];
}) {
  const vercelUsage =
    input.cpuHours * 0.128 +
    input.memoryGbHours * 0.0106 +
    (Math.max(0, input.invocations - 1e6) * 0.6) / 1e6;
  const vercel = 20 * input.developers + Math.max(0, vercelUsage - 20),
    neon = input.cu * 720 * 0.106 + input.storageGb * 0.35 + input.historyGb * 0.2;
  const perQuestion = costOf('claude-opus-5-5', {
      input: 30000,
      output: 3000,
      cacheRead: 10000,
      cacheWrite: 0,
    }),
    llm = input.questions * perQuestion;
  const subtotal = vercel + neon + llm,
    round = (n: number) => Number(n.toFixed(2));
  return {
    assumptions: input,
    monthlyUsd: {
      vercel: round(vercel),
      neon: round(neon),
      llm: round(llm),
      subtotal: round(subtotal),
      illustrativeRange: [round(subtotal + input.extras[0]), round(subtotal + input.extras[1])],
    },
    perQuestionUsd: round(perQuestion),
    estimatedMetaCalls:
      input.accounts *
      (30 * 24 * 4 * input.insightPages +
        30 * 4 * input.restatementPages +
        30 * 4 * 3 * input.entityPages +
        30),
    metaApiTariffUsd: null,
    limitations: [
      'Tarifas de referencia consultadas el 2026-10-26, región Vercel cle1 y Neon Launch; no son una factura ni un intervalo probabilístico.',
      'Cuatro niveles Insights, incremental horario, reexpresión diaria y entidades 4 veces/día son hipótesis para dimensionar, no llamadas medidas. No incluye backfill, reintentos, validación de app ni descubrimiento compartido.',
      'Tokens son totales por pregunta entre todas sus llamadas; caché real, esfuerzo, historial y número de rondas cambian el costo.',
      'Extras son una provisión configurable para backups, correo, logs, egress y CI; no sustituyen cotizaciones. No incluye impuestos, soporte, desarrollo, cambio de plan GitHub ni gasto publicitario.',
      'Los desarrolladores de Vercel no equivalen a usuarios de la aplicación. La cuota de Meta y el uso facturado deben verificarse en los proveedores.',
    ],
  };
}
export const scenarios = {
  pilot: estimate({
    accounts: 10,
    developers: 1,
    cu: 0.25,
    storageGb: 5,
    historyGb: 2,
    cpuHours: 1,
    memoryGbHours: 720,
    invocations: 30000,
    questions: 200,
    insightPages: 1,
    restatementPages: 4,
    entityPages: 1,
    extras: [10, 50],
  }),
  agency: estimate({
    accounts: 50,
    developers: 2,
    cu: 1,
    storageGb: 25,
    historyGb: 20,
    cpuHours: 20,
    memoryGbHours: 5000,
    invocations: 200000,
    questions: 1000,
    insightPages: 3,
    restatementPages: 30,
    entityPages: 2,
    extras: [25, 100],
  }),
  scale: estimate({
    accounts: 500,
    developers: 3,
    cu: 4,
    storageGb: 200,
    historyGb: 200,
    cpuHours: 80,
    memoryGbHours: 20000,
    invocations: 2000000,
    questions: 5000,
    insightPages: 10,
    restatementPages: 100,
    entityPages: 6,
    extras: [100, 500],
  }),
};
if (import.meta.main) {
  await mkdir('spike-output/readiness', { recursive: true });
  await writeFile('spike-output/readiness/costs.json', JSON.stringify(scenarios, null, 2));
  console.log(JSON.stringify(scenarios, null, 2));
}

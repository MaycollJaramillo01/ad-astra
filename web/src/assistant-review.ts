import type { Finding } from '../../src/contracts.ts';

export type ReviewTopic = { finding: Finding; count: number };
const score = (f: Finding) => (Number.isFinite(Number(f.priority)) ? Number(f.priority) : 0);

/** Reutiliza la prioridad del motor; agrupa la misma regla por cuenta para reducir ruido. */
export function reviewTopics(findings: Finding[], limit = 5): ReviewTopic[] {
  const groups = new Map<string, ReviewTopic>();
  const sorted = findings
    .filter((f) => f.status === 'open')
    .sort(
      (a, b) =>
        score(b) - score(a) || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id),
    );
  for (const finding of sorted) {
    const key = `${finding.adAccountId}:${finding.ruleId}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { finding, count: 1 });
  }
  return [...groups.values()].slice(0, limit);
}

export const REVIEW_GUIDE = [
  {
    title: 'Medición y calidad de datos',
    description:
      'Confirma sincronización, eventos y cambios de atribución antes de comparar resultados.',
    prompt:
      'Revisa la frescura de los datos, la medición y los cambios de atribución. Indica qué limita la comparación antes de analizar el rendimiento.',
    to: '/cuentas',
    icon: 'connect',
  },
  {
    title: 'Gasto y costo por resultado',
    description: 'Busca desvíos frente al periodo anterior y comprueba si hay volumen suficiente.',
    prompt:
      'Compara gasto y costo por resultado con el periodo anterior. Prioriza los desvíos con evidencia suficiente y separa monedas y objetivos.',
    to: '/analitica',
    icon: 'trend',
  },
  {
    title: 'Entrega y fatiga creativa',
    description:
      'Revisa restricciones, frecuencia y señales de desgaste dentro del mismo objetivo.',
    prompt:
      'Revisa hallazgos de entrega y fatiga creativa. Distingue señales observadas de hipótesis y explica qué validar antes de actuar.',
    to: '/monitoreo',
    icon: 'monitor',
  },
] as const;

import type { Signal, Summary } from '../../src/modules/monitoring/model.ts';

type PerformanceDetail = {
  kind?: string;
  recent?: Summary;
  baseline?: Summary;
  threshold?: number;
};
const number = (v: number) => v.toLocaleString('es', { maximumFractionDigits: 2 });
export function presentSignal(signal: Signal, currency: string) {
  const d = (signal.detail ?? {}) as PerformanceDetail;
  if (signal.hit === false)
    return {
      title: 'La última evaluación ya no detecta esta condición',
      description:
        'Consulta las ventanas y la persistencia requerida para confirmar el cierre del incidente.',
      next: 'Comprobar evolución y evidencia',
    };
  if (signal.hit === null)
    return {
      title: 'Todavía no hay evidencia suficiente',
      description:
        'Faltan datos completos o comparables para evaluar esta condición. Revisa la cobertura antes de tomar una decisión.',
      next: 'Revisar cobertura y ventanas de datos',
    };
  if (signal.category === 'performance' && d.recent && d.baseline) {
    const recent = d.recent,
      baseline = d.baseline;
    const window = `${recent.since} — ${recent.until}`;
    if (d.kind === 'spend_without_results')
      return {
        title: `${recent.spend === null ? 'Gasto' : `${number(recent.spend)} ${currency} invertidos`} sin resultados registrados`,
        description: `En el período ${window}. Comprueba la medición de conversiones y la entrega de la campaña.`,
        next: 'Revisar campaña y medición',
      };
    if (
      d.kind === 'cpr_increase' &&
      recent.cpr !== null &&
      baseline.cpr !== null &&
      baseline.cpr > 0
    ) {
      const delta = (recent.cpr / baseline.cpr - 1) * 100;
      return {
        title: `El costo por resultado ${delta >= 0 ? 'aumentó' : 'bajó'} ${number(Math.abs(delta))} %`,
        description: `Pasó de ${number(baseline.cpr)} a ${number(recent.cpr)} ${currency}. Período reciente: ${window}.`,
        next: 'Revisar qué conjuntos concentran el cambio',
      };
    }
    if (
      d.kind === 'results_drop' &&
      recent.results !== null &&
      baseline.results !== null &&
      baseline.results > 0
    ) {
      const delta =
        (recent.results / recent.expected / (baseline.results / baseline.expected) - 1) * 100;
      return {
        title: `Los resultados diarios ${delta <= 0 ? 'cayeron' : 'subieron'} ${number(Math.abs(delta))} %`,
        description: `${number(recent.results / recent.expected)} por día frente a ${number(baseline.results / baseline.expected)} en la referencia. Período reciente: ${window}.`,
        next: 'Revisar entrega, gasto y resultados por conjunto',
      };
    }
  }
  const copy: Record<string, { title: string; description: string; next: string }> = {
    connection: {
      title: 'La conexión con Meta necesita atención',
      description:
        'Comprueba la vigencia de la conexión y los permisos para recuperar las actualizaciones.',
      next: 'Revisar datos y conexión',
    },
    sync_stale: {
      title: 'Los datos de la cuenta están atrasados',
      description:
        'Revisa la última sincronización y sus errores antes de interpretar el rendimiento.',
      next: 'Revisar sincronizaciones',
    },
    recommendation_stale: {
      title: 'Hay recomendaciones pendientes de decisión',
      description:
        'Revisa su evidencia y decide si corresponde preparar un cambio o descartarlas con un motivo.',
      next: 'Revisar recomendaciones',
    },
    action_failed: {
      title: 'Una acción necesita revisión',
      description:
        'Consulta el resultado y las comprobaciones de la acción. Si el envío es incierto, comprueba lo aplicado antes de reintentar.',
      next: 'Revisar acciones y resultados',
    },
    audit: {
      title: 'La auditoría encontró señales que revisar',
      description:
        'Consulta los hallazgos priorizados, la entidad afectada y las recomendaciones asociadas.',
      next: 'Revisar hallazgos y campañas',
    },
  };
  return (
    copy[signal.category] ?? {
      title: 'Se detectó una condición que requiere revisión',
      description: 'Revisa la entidad y la evidencia para decidir el siguiente paso.',
      next: 'Revisar entidad afectada',
    }
  );
}

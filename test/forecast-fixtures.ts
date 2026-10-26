import type { DailyRow } from '../src/modules/forecasting/forecast.ts';
import { mulberry32, normal, poissonSample } from '../src/modules/forecasting/simulate.ts';
import { addDays } from '../src/modules/insights/catalog.ts';

// Datos SINTÉTICOS de parámetros conocidos para el pronóstico y la simulación: gasto con
// estacionalidad semanal, tendencia o cambios de régimen y ruido log-normal; impresiones, clics y
// leads con ruido de Poisson. Todo determinista por semilla.

export const UNTIL = '2026-10-20';
/** Factores del día de la semana (índice t % 7), media 1. */
export const WEEKLY = [1.15, 1.1, 1.0, 0.95, 0.9, 0.85, 1.05];

export interface SyntheticSpec {
  days: number;
  seed: number;
  until?: string;
  /** Gasto diario esperado el día t (0 = el primero) antes del factor semanal. */
  spend: (t: number) => number;
  weekly?: number[];
  /** Desviación típica del ruido log-normal del gasto. */
  spendNoise?: number;
  /** Leads esperados dado el gasto del día: k · gasto^b. */
  leads?: { k: number; b: number };
  /** Multiplicador de los leads esperados de una fecha (festivos, días de pago…). */
  effect?: (date: string) => number;
  attribution?: (t: number) => string;
}

export function synthetic(spec: SyntheticSpec): DailyRow[] {
  const rand = mulberry32(spec.seed);
  const until = spec.until ?? UNTIL;
  const weekly = spec.weekly ?? WEEKLY;
  const sd = spec.spendNoise ?? 0.15;
  const rows: DailyRow[] = [];
  for (let t = 0; t < spec.days; t++) {
    const expected = spec.spend(t) * (weekly[t % 7] as number);
    const z = normal(rand);
    if (expected <= 0) continue; // sin entrega: Meta no devuelve fila
    const spend = expected * Math.exp(sd * z - (sd * sd) / 2);
    const impressions = poissonSample(spend * 100, rand);
    const date = addDays(until, t - spec.days + 1);
    const lift = spec.effect?.(date) ?? 1;
    rows.push({
      date,
      attribution: spec.attribution?.(t) ?? '7d_click_1d_view',
      values: {
        spend,
        impressions,
        inlineLinkClicks: poissonSample(impressions * 0.01, rand),
        leads: spec.leads ? poissonSample(lift * spec.leads.k * spend ** spec.leads.b, rand) : 0,
      },
    });
  }
  return rows;
}

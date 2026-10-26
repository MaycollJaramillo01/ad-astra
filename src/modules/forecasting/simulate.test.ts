import { describe, expect, it } from 'vitest';
import { UNTIL } from '../../../test/forecast-fixtures.ts';
import { addDays } from '../insights/catalog.ts';
import {
  analyzeExperiment,
  type CurveFit,
  causalElasticity,
  confoundingSd,
  designExperiment,
  experimentPower,
  fitCurve,
  learned,
  localElasticity,
  monotone,
  mulberry32,
  normal,
  type Plan,
  poissonSample,
  RESPONSE,
  simulatePlans,
  validatedRange,
  validateExtremes,
  validateResponse,
  type Week,
} from './simulate.ts';

const moments = (f: () => number, n = 40_000) => {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const x = f();
    s += x;
    s2 += x * x;
  }
  const mean = s / n;
  return { mean, variance: s2 / n - mean * mean };
};

/**
 * Semanas con eventos ~ Poisson(0,5 · gasto^b · e^choque), gasto log-normal (sd del log = `sd`) y
 * choques log-normales (sd 0,15); `common` añade un choque compartido con otra serie.
 */
function weeks(
  seed: number,
  b: number,
  sd: number,
  n = 26,
  common?: number[],
  truth = (s: number) => 0.5 * s ** b,
): Week[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const spend = 2000 * Math.exp(sd * normal(rand));
    const shock = common ? (common[i] as number) : 0.15 * normal(rand);
    return {
      end: addDays(UNTIL, 7 * (i - n + 1)),
      index: i - (n - 1),
      spend,
      events: poissonSample(truth(spend) * Math.exp(shock - 0.0113), rand),
      others: 0,
      share: [0, 0, 0, 0],
    };
  });
}

const plan = (
  fit: CurveFit,
  current: number,
  planned: number,
  id = 'c1',
  group = 'leads',
): Plan => ({
  id,
  group,
  fit,
  currentDaily: current,
  plannedDaily: planned,
  othersCurrent: 0,
  othersPlanned: 0,
  experiment: null,
  shares: [],
});

describe('muestreo reproducible', () => {
  it('Poisson con sus momentos y PRNG determinista', () => {
    const rand = mulberry32(3);
    expect(moments(() => poissonSample(7, rand)).variance).toBeCloseTo(7, 0);
    expect(moments(() => poissonSample(400, rand)).mean).toBeCloseTo(400, 0);
    expect(mulberry32(9)()).toBe(mulberry32(9)());
  });
});

describe('curva de respuesta v2', () => {
  it('recupera la elasticidad cuando el gasto varía (intervalo creíble del 80 % calibrado)', () => {
    let inside = 0;
    let reps = 0;
    for (let s = 1; s <= 60; s++) {
      const fit = fitCurve(weeks(s, 0.55, 0.4));
      if (!fit) continue;
      reps++;
      // Elasticidad en el gasto medio geométrico: b + 2q·0 = b.
      const e = localElasticity(fit, Math.exp(fit.xMean));
      if (Math.abs(e.mean - 0.55) <= 1.2816 * e.sd) inside++;
      expect(learned(fit, 1, RESPONSE.priors.elasticity.sd)).toBeGreaterThan(0.5);
    }
    expect(reps).toBe(60);
    expect(inside / reps).toBeGreaterThan(0.68);
    expect(inside / reps).toBeLessThan(0.95);
  });

  it('sin variación del gasto, la elasticidad vuelve al a priori y se declara poco aprendida', () => {
    const fit = fitCurve(weeks(4, 0.3, 0.005)) as CurveFit;
    expect(fit.theta[1]).toBeCloseTo(RESPONSE.priors.elasticity.mean, 1);
    expect(learned(fit, 1, RESPONSE.priors.elasticity.sd)).toBeLessThan(0.1);
  });

  it('exige semanas y eventos mínimos', () => {
    expect(fitCurve(weeks(1, 0.8, 0.3, RESPONSE.minWeeks - 1))).toBeNull();
    expect(fitCurve(weeks(1, 0.8, 0.3).map((w) => ({ ...w, events: 0 })))).toBeNull();
  });

  it('los choques quitan el ruido de Poisson y tienen media multiplicativa 1', () => {
    const fit = fitCurve(weeks(8, 0.8, 0.35)) as CurveFit;
    expect(fit.shockSd).toBeGreaterThan(0.05);
    expect(fit.shockSd).toBeLessThan(0.3);
    const meanExp = fit.shockList.reduce((s, x) => s + Math.exp(x), 0) / fit.shockList.length;
    expect(meanExp).toBeCloseTo(1, 10);
  });

  it('la curva es monótona: más gasto propio nunca da menos eventos', () => {
    expect(monotone(0.5, -0.4, 2)).toBeCloseTo(0.5 * 0.625 - 0.4 * 0.625 ** 2, 10); // tope en el vértice
    expect(monotone(0.5, 0, 1)).toBeCloseTo(0.5, 10);
    expect(monotone(-0.2, 0, 1)).toBe(0); // pendiente negativa: plano
    expect(monotone(0.5, 0.3, -2)).toBeLessThanOrEqual(0);
    for (const d of [-1.5, -0.5, 0.3, 1, 2])
      expect(Math.sign(monotone(0.6, -0.2, d)) * Math.sign(d)).toBeGreaterThanOrEqual(0);
  });
});

describe('validación', () => {
  it('la de un paso está calibrada con un modelo bien especificado', () => {
    const cov: number[] = [];
    for (let s = 1; s <= 8; s++) {
      const v = validateResponse(weeks(s * 5, 0.8, 0.35), s);
      expect(v.evaluated).toBe(26 - RESPONSE.minWeeks);
      if (v.coverage !== null) cov.push(v.coverage);
    }
    const mean = cov.reduce((a, b) => a + b, 0) / cov.length;
    expect(mean).toBeGreaterThan(0.68);
    expect(mean).toBeLessThan(0.92);
  });

  it('la de extremos mide hasta dónde extrapola la curva y fija el rango publicable', () => {
    const ws = weeks(21, 0.8, 0.35);
    const fit = fitCurve(ws) as CurveFit;
    const ext = validateExtremes(ws, 1);
    expect(ext.evaluated).toBe(2 * Math.max(3, Math.round(26 / 5)));
    expect(ext.reachAbove).toBeGreaterThan(0);
    expect(ext.reachBelow).toBeGreaterThan(0);
    const range = validatedRange(fit, ws, ext);
    if (range.reliableShape) {
      expect(range.max).toBeGreaterThan(fit.spendRange[1]);
      expect(range.min).toBeLessThan(fit.spendRange[0]);
    } else {
      expect(range.max).toBeLessThan(fit.spendRange[1]);
    }
    // Una validación de extremos fallida limita el rango al intercuartílico.
    const bad = validatedRange(fit, ws, { ...ext, coverage: 0 });
    expect(bad.reliableShape).toBe(false);
    expect(bad.max).toBeLessThan(fit.spendRange[1]);
    expect(bad.min).toBeGreaterThan(fit.spendRange[0]);
  });
});

describe('elasticidad causal y confusión', () => {
  it('sin experimento suma el sesgo de confusión; con experimento domina el experimento', () => {
    const obs = { mean: 0.9, sd: 0.05 };
    const none = causalElasticity(obs, 0.2, null);
    expect(none.source).toBe('observational');
    expect(none.sd).toBeCloseTo(Math.sqrt(0.05 ** 2 + 0.2 ** 2), 10);
    // Con experimento manda el experimento: la observada (0,9) puede estar sesgada más allá de σ.
    expect(causalElasticity(obs, 0.2, { mean: 0.5, se: 0.08 })).toEqual({
      mean: 0.5,
      sd: 0.08,
      source: 'experiment',
    });
  });

  it('calibra la confusión con los experimentos propios (≥ 3)', () => {
    expect(confoundingSd([]).sd).toBe(RESPONSE.confounding.sd);
    const pairs = [0.4, -0.3, 0.5, -0.4].map((d) => ({
      observed: 0.7 + d,
      observedSe: 0.05,
      experimental: 0.7,
      experimentalSe: 0.1,
    }));
    const c = confoundingSd(pairs);
    expect(c.source).toBe('experiments');
    expect(c.sd).toBeGreaterThan(0.3);
    expect(c.sd).toBeLessThan(0.45);
  });
});

describe('Monte Carlo de escenarios', () => {
  const fit = fitCurve(weeks(11, 0.8, 0.35)) as CurveFit;
  const current = Math.exp(fit.xMean) / 7;

  it('es determinista con la semilla y no cambia nada si el plan es el actual', () => {
    const a = simulatePlans([plan(fit, current, current)], 28, { seed: 5, draws: 2000 });
    expect(simulatePlans([plan(fit, current, current)], 28, { seed: 5, draws: 2000 })).toEqual(a);
    const o = a.outcomes[0];
    expect(o?.expectedChange.p10).toBe(0);
    expect(o?.expectedChange.p90).toBe(0);
    // 4 semanas al gasto medio geométrico ≈ 4 · e^a (a: nivel de la última semana).
    expect(o?.events.p50).toBeGreaterThan(4 * Math.exp(fit.theta[0] as number) * 0.8);
    expect(o?.events.p50).toBeLessThan(4 * Math.exp(fit.theta[0] as number) * 1.2);
  });

  it('más gasto da más eventos; la confusión ensancha el cambio esperado; pausar da 0', () => {
    const run = (factor: number, biasSd = RESPONSE.confounding.sd) =>
      simulatePlans([plan(fit, current, current * factor)], 28, { seed: 2, draws: 4000, biasSd })
        .outcomes[0];
    const more = run(1.3);
    expect(more?.expectedChange.p50).toBeGreaterThan(0);
    expect(more?.largeChange).toBe(false); // +30 % justo en el límite
    expect(run(1.5)?.largeChange).toBe(true);
    const spread = (o: ReturnType<typeof run>) =>
      (o?.expectedChange.p90 ?? 0) - (o?.expectedChange.p10 ?? 0);
    expect(spread(run(1.5))).toBeGreaterThan(spread(run(1.5, 0)));
    expect(run(5)?.extrapolation).toBe(true);
    const paused = run(0);
    expect(paused?.events).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(paused?.probNoEvents).toBe(1);
  });

  it('las campañas que se mueven juntas dan un total más disperso que si fueran independientes', () => {
    const rand = mulberry32(77);
    const common = Array.from({ length: 26 }, () => 0.3 * normal(rand));
    const a = fitCurve(weeks(31, 0.8, 0.3, 26, common)) as CurveFit;
    const b = fitCurve(weeks(32, 0.8, 0.3, 26, common)) as CurveFit;
    // Mismas curvas, pero con los choques de b en semanas que no coinciden con las de a.
    const shifted: CurveFit = {
      ...b,
      shocks: new Map([...b.shocks].map(([k, v]) => [addDays(k, -365), v])),
    };
    const width = (second: CurveFit) => {
      const t = simulatePlans([plan(a, 300, 300, 'a'), plan(second, 300, 300, 'b')], 28, {
        seed: 3,
        draws: 4000,
      }).totals[0];
      return (t?.events.p90 ?? 0) - (t?.events.p10 ?? 0);
    };
    expect(width(b)).toBeGreaterThan(width(shifted) * 1.1);
  });
});

describe('experimentos de presupuesto', () => {
  it('diseña bloques aleatorizados equilibrados y reproducibles', () => {
    const levels = [0.8, 1, 1.25];
    const s = designExperiment({ start: '2026-11-02', levels, blocks: 3, seed: 7 });
    expect(s).toHaveLength(9);
    expect(s[0]).toMatchObject({ period: 1, since: '2026-11-02', until: '2026-11-08' });
    expect(s[8]?.until).toBe('2027-01-03');
    for (let b = 0; b < 3; b++)
      expect(
        s
          .slice(3 * b, 3 * b + 3)
          .map((p) => p.multiplier)
          .sort(),
      ).toEqual([...levels].sort());
    expect(designExperiment({ start: '2026-11-02', levels, blocks: 3, seed: 7 })).toEqual(s);
  });

  it('la potencia mejora con más bloques y niveles más separados', () => {
    const base = { weeklyEvents: 50, shockSd: 0.15, burnInDays: 2 };
    const narrow = experimentPower({ ...base, levels: [0.8, 1, 1.25], blocks: 3 });
    expect(experimentPower({ ...base, levels: [0.8, 1, 1.25], blocks: 6 }).se).toBeLessThan(
      narrow.se,
    );
    expect(experimentPower({ ...base, levels: [0.6, 1, 1.6], blocks: 3 }).se).toBeLessThan(
      narrow.se,
    );
  });

  /**
   * La demanda semanal sube el gasto (el anunciante lo sube cuando va bien) y los eventos: la
   * regresión observacional sobreestima la elasticidad; el experimento aleatorizado la recupera.
   */
  it('el análisis por variable instrumental recupera la elasticidad causal', () => {
    const truth = 0.6;
    let inside = 0;
    let reps = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = mulberry32(seed * 13);
      const schedule = designExperiment({
        start: '2026-06-01',
        levels: [0.6, 1, 1.6],
        blocks: 4,
        seed,
      });
      const days = new Map<string, { spend: number; events: number }>();
      for (const p of schedule) {
        const demand = Math.exp(0.15 * normal(rand));
        for (let d = 0; d < 7; d++) {
          // Cumplimiento imperfecto: Meta no entrega exactamente el plan.
          const spend = 300 * p.multiplier * Math.exp(0.1 * normal(rand)) * demand ** 0.5;
          days.set(addDays(p.since, d), {
            spend,
            events: poissonSample(0.4 * spend ** truth * demand, rand),
          });
        }
      }
      const r = analyzeExperiment(
        schedule,
        (date) => days.get(date) ?? { spend: 0, events: 0 },
        '2026-12-31',
        300,
        2,
      );
      expect(r.complete).toBe(true);
      if (!r.elasticity) continue;
      reps++;
      if (truth >= r.elasticity.lower && truth <= r.elasticity.upper) inside++;
    }
    expect(reps).toBeGreaterThan(35);
    expect(inside / reps).toBeGreaterThan(0.65);
  });

  it('sin cumplimiento del plan el instrumento es débil y no concluye', () => {
    const schedule = designExperiment({
      start: '2026-06-01',
      levels: [0.8, 1, 1.25],
      blocks: 3,
      seed: 2,
    });
    const rand = mulberry32(5);
    const r = analyzeExperiment(
      schedule,
      () => ({ spend: 300 * Math.exp(0.2 * normal(rand)), events: 40 }),
      '2026-12-31',
      300,
    );
    expect(r.elasticity).toBeNull();
    expect(r.reasons[0]).toContain('Instrumento débil');
  });
});

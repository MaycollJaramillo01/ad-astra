import { describe, expect, it } from 'vitest';
import { UNTIL } from '../../../test/forecast-fixtures.ts';
import { addDays } from '../insights/catalog.ts';
import {
  fitResponse,
  gammaSample,
  mulberry32,
  negBinomialSample,
  normal,
  poissonSample,
  RESPONSE,
  simulatePlans,
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

/** 26 semanas con eventos ~ Poisson(0,5 · gasto^b) y gasto log-normal (sd del log = `sd`). */
function weeks(seed: number, b: number, sd: number, n = 26): Week[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const spend = 2000 * Math.exp(sd * normal(rand));
    return {
      end: addDays(UNTIL, 7 * (i - n)),
      spend,
      events: poissonSample(0.5 * spend ** b, rand),
    };
  });
}

describe('muestreo reproducible', () => {
  it('Gamma, Poisson y binomial negativa con sus momentos', () => {
    const rand = mulberry32(3);
    const g = moments(() => gammaSample(2.5, rand));
    expect(g.mean).toBeCloseTo(2.5, 1);
    expect(g.variance).toBeCloseTo(2.5, 0);
    expect(moments(() => gammaSample(0.4, rand)).mean).toBeCloseTo(0.4, 1);
    expect(moments(() => poissonSample(7, rand)).variance).toBeCloseTo(7, 0);
    expect(moments(() => poissonSample(400, rand)).mean).toBeCloseTo(400, 0);
    const nb = moments(() => negBinomialSample(20, 3, rand));
    expect(nb.mean).toBeCloseTo(20, 0);
    expect(nb.variance / nb.mean).toBeGreaterThan(2.7);
    expect(nb.variance / nb.mean).toBeLessThan(3.3);
    expect(mulberry32(9)()).toBe(mulberry32(9)());
  });
});

describe('curva de respuesta', () => {
  it('recupera la elasticidad cuando el gasto varía (intervalo creíble del 80 % calibrado)', () => {
    let inside = 0;
    let reps = 0;
    for (let s = 1; s <= 60; s++) {
      const fit = fitResponse(weeks(s, 0.55, 0.4));
      if (!fit) continue;
      reps++;
      const sd = Math.sqrt(fit.cov.bb);
      if (Math.abs(fit.b - 0.55) <= 1.2816 * sd) inside++;
      expect(fit.learned).toBeGreaterThan(0.6);
    }
    expect(reps).toBe(60);
    expect(inside / reps).toBeGreaterThan(0.68);
    expect(inside / reps).toBeLessThan(0.92);
  });

  it('sin variación del gasto, b vuelve al a priori y se declara poco aprendida', () => {
    const fit = fitResponse(weeks(4, 0.3, 0.005));
    expect(fit?.b).toBeCloseTo(RESPONSE.prior.mean, 1);
    expect(fit?.learned).toBeLessThan(0.1);
  });

  it('exige semanas y eventos mínimos', () => {
    expect(fitResponse(weeks(1, 0.8, 0.3, RESPONSE.minWeeks - 1))).toBeNull();
    expect(fitResponse(weeks(1, 0.8, 0.3).map((w) => ({ ...w, events: 0 })))).toBeNull();
  });

  it('la validación de un paso está calibrada con un modelo bien especificado', () => {
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
});

describe('Monte Carlo de escenarios', () => {
  const fit = fitResponse(weeks(11, 0.8, 0.35));
  if (!fit) throw new Error('ajuste de prueba');
  const current = 2000 / 7;

  it('es determinista con la semilla y no cambia nada si el plan es el actual', () => {
    const plan = { id: 'c1', group: 'leads', fit, currentDaily: current, plannedDaily: current };
    const a = simulatePlans([plan], 28, { seed: 5, draws: 2000 });
    expect(simulatePlans([plan], 28, { seed: 5, draws: 2000 })).toEqual(a);
    const o = a.outcomes[0];
    expect(o?.expectedChange.p10).toBe(0);
    expect(o?.expectedChange.p90).toBe(0);
    // 4 semanas al gasto medio geométrico ≈ 4 · e^a.
    expect(o?.events.p50).toBeGreaterThan(4 * Math.exp(fit.a) * 0.85);
    expect(o?.events.p50).toBeLessThan(4 * Math.exp(fit.a) * 1.15);
    expect((o?.cost.p10 as number) <= (o?.cost.p50 as number)).toBe(true);
  });

  it('más gasto da más eventos con rendimientos decrecientes y marca la extrapolación', () => {
    const run = (factor: number) =>
      simulatePlans(
        [{ id: 'c1', group: 'leads', fit, currentDaily: current, plannedDaily: current * factor }],
        28,
        { seed: 2, draws: 4000 },
      ).outcomes[0];
    const more = run(1.3);
    expect(more?.expectedChange.p50).toBeGreaterThan(0);
    expect(more?.extrapolation).toBe(false);
    expect(more?.largeChange).toBe(false); // +30 % justo en el límite
    expect(run(1.5)?.largeChange).toBe(true);
    // b ≈ 0,8: +30 % de gasto da menos de +30 % de eventos y el costo por evento sube.
    expect((more?.events.p50 as number) / (run(1)?.events.p50 as number)).toBeLessThan(1.3);
    expect(run(5)?.extrapolation).toBe(true);
    const paused = run(0);
    expect(paused?.events).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(paused?.probNoEvents).toBe(1);
  });

  it('suma los totales por tipo de evento', () => {
    const plans = [
      { id: 'a', group: 'leads', fit, currentDaily: current, plannedDaily: current },
      { id: 'b', group: 'leads', fit, currentDaily: current, plannedDaily: current },
      { id: 'c', group: 'purchases', fit, currentDaily: current, plannedDaily: current },
    ];
    const { totals, outcomes } = simulatePlans(plans, 28, { seed: 1, draws: 3000 });
    expect(totals.map((t) => t.group)).toEqual(['leads', 'purchases']);
    const leads = totals[0];
    expect(leads?.spend).toBeCloseTo(2 * current * 28, 6);
    const single = outcomes[0]?.events.p50 as number;
    expect(leads?.events.p50).toBeGreaterThan(1.8 * single);
    expect(leads?.events.p50).toBeLessThan(2.2 * single);
  });
});

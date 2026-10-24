import { describe, expect, it } from 'vitest';
import { poissonSample, rng } from '../../../test/audit-fixtures.ts';
import {
  benjaminiHochberg,
  coefficientOfVariation,
  costPosterior,
  gammaP,
  gammaQuantile,
  lnGamma,
  normalCdf,
  poissonCdf,
  poissonUpper,
  proportionDropP,
  robustZ,
  wilson,
} from './stats.ts';

describe('funciones especiales contra valores conocidos', () => {
  it('lnΓ, P(a, x), Poisson y normal', () => {
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
    expect(gammaP(1, 2)).toBeCloseTo(1 - Math.exp(-2), 12);
    expect(gammaP(3, 30)).toBeCloseTo(1, 10);
    expect(poissonCdf(2, 3)).toBeCloseTo(Math.exp(-3) * (1 + 3 + 4.5), 12);
    expect(poissonUpper(5, 2)).toBeCloseTo(1 - Math.exp(-2) * (1 + 2 + 2 + 4 / 3 + 2 / 3), 12);
    expect(poissonCdf(0, 4)).toBeCloseTo(Math.exp(-4), 12);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655254, 8);
    expect(normalCdf(0)).toBe(0.5);
  });

  it('cuantil de la Gamma e intervalo del costo por evento', () => {
    expect(gammaQuantile(0.5, 1, 1)).toBeCloseTo(Math.LN2, 8);
    expect(gammaP(4, gammaQuantile(0.9, 4, 2) * 2)).toBeCloseTo(0.9, 8);
    // 40 resultados con 200 de gasto y referencia 5: la estimación es 5, el intervalo la contiene.
    const post = costPosterior(200, 40, 5, 5);
    expect(post.estimate).toBeCloseTo(5, 10);
    const [lo, hi] = post.interval(0.8);
    expect(lo).toBeLessThan(5);
    expect(hi).toBeGreaterThan(5);
    // Sin datos, la estimación es la referencia (la a priori manda).
    expect(costPosterior(0, 0, 7, 5).estimate).toBeCloseTo(7, 10);
    // Muchos datos a 10 por evento: la a priori apenas pesa.
    expect(costPosterior(10_000, 1000, 5, 5).estimate).toBeCloseTo(9.975, 2);
    expect(costPosterior(10_000, 1000, 5, 5).probCostAbove(8)).toBeGreaterThan(0.99);
  });

  it('tasas: Wilson y prueba de dos proporciones', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo + hi).toBeCloseTo(1, 10);
    expect(proportionDropP(100, 10_000, 60, 10_000)).toBeLessThan(0.01); // 1 % → 0,6 %
    expect(proportionDropP(100, 10_000, 100, 10_000)).toBeCloseTo(0.5, 6);
  });

  it('variación, z robusta y Benjamini-Hochberg', () => {
    expect(coefficientOfVariation([10, 10, 10])).toBe(0);
    expect(coefficientOfVariation([5])).toBeNull();
    const z = robustZ(100, [10, 11, 9, 10, 12, 10, 9, 11]);
    expect(z?.z).toBeGreaterThan(3.5);
    expect(robustZ(10, [10, 10, 10])).toBeNull(); // sin variación no se juzga
    expect(benjaminiHochberg([0.02, 0.5, 0.03], 0.05)).toEqual([true, false, true]);
    expect(benjaminiHochberg([0.04, 0.06], 0.05)).toEqual([false, false]);
  });
});

describe('calibración con datos sintéticos de parámetros conocidos', () => {
  it('la prueba de Poisson no supera la tasa nominal de falsos positivos', () => {
    const rand = rng(7);
    const alpha = 0.05;
    let falsePositives = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      const expected = 5 + (i % 40); // de 5 a 44 resultados esperados
      const observed = poissonSample(expected, rand);
      if (poissonCdf(observed, expected) < alpha) falsePositives++;
    }
    // Poisson es discreta y conservadora: la tasa real queda por debajo de α.
    expect(falsePositives / trials).toBeLessThanOrEqual(alpha);
    expect(falsePositives / trials).toBeGreaterThan(alpha / 4);
  });

  it('Benjamini-Hochberg mantiene la tasa de falsos descubrimientos por debajo de q', () => {
    // BH garantiza E[V/R] ≤ (m0/m)·q por ejecución (aquí 0,9 · 0,1 = 0,09).
    const rand = rng(11);
    const runs = 400;
    let fdpSum = 0;
    for (let run = 0; run < runs; run++) {
      // 90 hipótesis nulas (p uniforme) y 10 efectos reales (p muy pequeños).
      const p = [
        ...Array.from({ length: 90 }, () => rand()),
        ...Array.from({ length: 10 }, () => rand() * 1e-4),
      ];
      const reject = benjaminiHochberg(p, 0.1);
      const discoveries = reject.filter(Boolean).length;
      const falseOnes = reject.slice(0, 90).filter(Boolean).length;
      fdpSum += discoveries ? falseOnes / discoveries : 0;
    }
    expect(fdpSum / runs).toBeLessThanOrEqual(0.1);
  });
});

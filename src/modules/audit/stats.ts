// Estadística del motor de auditoría (ARCHITECTURE §6.5). Funciones puras y deterministas: no
// usan aleatoriedad ni reloj. Precisión suficiente para decidir umbrales (≈1e-10 en las colas).
//
//   - Conteos (resultados, clics, impresiones): Poisson y su conjugada Gamma.
//   - Tasas (CTR, conversión por clic): Beta-Binomial, Wilson y prueba de dos proporciones.
//   - Anomalías en series diarias: puntuación z robusta (mediana y MAD, Iglewicz-Hoaglin).
//   - Muchas pruebas en una ejecución: Benjamini-Hochberg.

const EPS = 1e-14;

/** ln Γ(x), aproximación de Lanczos (g = 7, n = 9). */
export function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0] as number;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += (c[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Función gamma incompleta regularizada inferior P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (a <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    // Serie
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 10_000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - gln));
  }
  // Fracción continua (Lentz) para Q(a, x)
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - gln) * h);
}

/** P(X ≤ k) con X ~ Poisson(λ). */
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  if (lambda <= 0) return 1;
  return 1 - gammaP(Math.floor(k) + 1, lambda);
}

/** P(X ≥ k) con X ~ Poisson(λ). */
export function poissonUpper(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (lambda <= 0) return 0;
  return gammaP(Math.ceil(k), lambda);
}

/** Φ(z), normal estándar acumulada (vía erf(x) = P(½, x²)). */
export function normalCdf(z: number): number {
  const half = 0.5 * gammaP(0.5, (z * z) / 2);
  return z >= 0 ? 0.5 + half : 0.5 - half;
}

/**
 * Cuantil de una Gamma(forma α, tasa β): bisección sobre la acumulada (determinista, sin
 * depender de semillas ni de aproximaciones con error variable).
 */
export function gammaQuantile(p: number, alpha: number, beta: number): number {
  if (p <= 0) return 0;
  let lo = 0;
  let hi = Math.max(1, alpha) / beta;
  while (gammaP(alpha, hi * beta) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(alpha, mid * beta) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Costo por evento con contracción Gamma-Poisson (ARCHITECTURE §6.6). La tasa de eventos por
 * unidad gastada λ tiene a priori Gamma(k, k·costoRef): equivale a k eventos "virtuales" al costo
 * de referencia, que pesan poco cuando hay datos y mucho cuando no.
 */
export function costPosterior(spend: number, events: number, refCost: number, k: number) {
  const alpha = k + events;
  const beta = k * refCost + spend;
  return {
    alpha,
    beta,
    /** Estimación del costo por evento. */
    estimate: beta / alpha,
    /** Intervalo creíble del costo (invertido desde los cuantiles de λ). */
    interval: (level = 0.8): [number, number] => {
      const tail = (1 - level) / 2;
      return [1 / gammaQuantile(1 - tail, alpha, beta), 1 / gammaQuantile(tail, alpha, beta)];
    },
    /** P(costo real > c) = P(λ < 1/c). */
    probCostAbove: (c: number) => gammaP(alpha, beta / c),
  };
}

/** Intervalo de Wilson para una proporción. */
export function wilson(successes: number, n: number, z = 1.2816): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Tasa con contracción Beta-Binomial: k ensayos "virtuales" a la tasa de referencia. */
export function ratePosterior(successes: number, n: number, refRate: number, k: number) {
  const a = k * refRate + successes;
  const b = k * (1 - refRate) + (n - successes);
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return {
    mean,
    interval: (z = 1.2816): [number, number] => [
      Math.max(0, mean - z * sd),
      Math.min(1, mean + z * sd),
    ],
  };
}

/**
 * Prueba de dos proporciones (unilateral): ¿la tasa 2 es menor que la 1? Devuelve el valor p.
 * Válida con muestras grandes; quien la llama exige mínimos de impresiones.
 */
export function proportionDropP(x1: number, n1: number, x2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return normalCdf((x2 / n2 - x1 / n1) / se);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Coeficiente de variación (desviación típica muestral / media). */
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / mean;
}

/**
 * Puntuación z robusta de Iglewicz-Hoaglin: 0,6745 · (x − mediana) / MAD. Resiste a los propios
 * valores atípicos de la historia (una media y una desviación típica se contaminarían). null si
 * la serie no varía (MAD = 0) y no se puede juzgar.
 */
export function robustZ(
  x: number,
  history: number[],
): { z: number; median: number; mad: number } | null {
  const m = median(history);
  if (m === null) return null;
  const mad = median(history.map((v) => Math.abs(v - m)));
  if (!mad) return null;
  return { z: (0.6745 * (x - m)) / mad, median: m, mad };
}

/** Benjamini-Hochberg: qué hipótesis se rechazan controlando la tasa de falsos descubrimientos q. */
export function benjaminiHochberg(pValues: number[], q: number): boolean[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const m = pValues.length;
  let cutoff = -1;
  order.forEach(({ p }, rank) => {
    if (p <= ((rank + 1) / m) * q) cutoff = rank;
  });
  const reject = new Array<boolean>(m).fill(false);
  for (let r = 0; r <= cutoff; r++) reject[(order[r] as { i: number }).i] = true;
  return reject;
}

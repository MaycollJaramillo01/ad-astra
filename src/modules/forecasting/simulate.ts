import { addDays } from '../insights/catalog.ts';
import { coverageOk, type History } from './forecast.ts';

// Escenarios de presupuesto (ARCHITECTURE §6.10, docs/FORECASTING.md §5–6). Funciones puras: la
// aleatoriedad sale de un PRNG con semilla, así que misma entrada y semilla → mismo resultado.
//
//   1. Curva de respuesta semanal por campaña (Poisson con sobredispersión, Laplace):
//        log μ = a + b·x + q·x² + d·τ + g·o + Σ η·cuota de días de evento
//      x: ln gasto semanal centrado; q: curvatura; τ: tendencia; o: gasto de las otras campañas con
//      el mismo evento (canibalización o arrastre); los controles reducen la confusión.
//   2. Elasticidad contrafactual: la observada en el gasto actual más un sesgo de confusión
//      N(0, σ²) (no identificable sin experimento), o la de un experimento aleatorizado.
//   3. Validación de un paso (calibración cerca del gasto observado) y de extremos (se dejan fuera
//      las semanas de más y de menos gasto: ¿extrapola bien la curva?). Fuera del rango validado
//      no se publica.
//   4. Monte Carlo: parámetros + sesgo + choques semanales remuestreados por bloques de semanas a
//      la vez en todas las campañas (conserva la correlación entre campañas y la persistencia).
//   5. Experimentos de presupuesto: diseño por bloques aleatorizados, potencia y análisis por
//      variable instrumental (el nivel asignado al azar instrumenta el gasto real).

export const SIMULATION_VERSION = 'simulate-2.0.0';

/** Ficha del simulador: se publica con cada escenario (CA-F6-03). */
export const SIMULATION_CARD = {
  assumptions: [
    'El gasto es el plan: se supone que Meta entrega el gasto diario indicado; la entrega real puede quedarse por debajo.',
    'Por campaña, log(eventos semanales) = nivel + b·ln(gasto) + curvatura + tendencia + efecto del gasto de las otras campañas con el mismo evento + efectos de festivos, fechas comerciales, pagos y promociones; a prioris débiles y visibles en la ficha.',
    'Más gasto propio nunca reduce los eventos de la campaña (curva monótona); el gasto de las otras puede sumar o restar (efecto cruzado estimado, con su incertidumbre).',
    'Sin experimento, el efecto de cambiar el gasto es la elasticidad observada más un sesgo de confusión desconocido, N(0; σ²) con σ = 0,2 por defecto (o calibrado con los experimentos propios); con experimento, la elasticidad causal medida.',
    'Las campañas se mueven juntas como lo hicieron en la historia: los choques semanales se remuestrean por bloques de semanas a la vez en todas ellas.',
    'La tendencia se usa para no confundir el efecto del gasto con la evolución del mercado, pero no se proyecta: el escenario parte del nivel de la última semana.',
    'Mismo objetivo, segmentación y creatividades. Pausar una campaña da 0 eventos.',
  ],
  limitations: [
    'Estimación, no garantía.',
    'Sin un experimento aleatorizado, el efecto de un cambio de presupuesto no es causal: el término de confusión ensancha el rango, pero no elimina el sesgo si este es mayor que lo supuesto.',
    'Fuera del rango validado (el gasto observado ampliado solo hasta donde la validación de extremos comprobó que la curva extrapola bien) no se publica.',
    'Un cambio grande de presupuesto puede reiniciar la fase de aprendizaje de Meta; los experimentos lo amortiguan descartando los primeros días de cada periodo, pero los escenarios no lo modelan.',
    'Con poca variación del gasto en la historia, la elasticidad y la curvatura las deciden sobre todo los a prioris (ver "aprendido de los datos").',
    'La validación es semanal y condicionada al gasto observado; no certifica la cobertura del total a varios meses ni la de un cambio de presupuesto. En pruebas con campañas correlacionadas la cobertura del total fue inferior al 80 % nominal.',
  ],
};

/** Categorías de evento con efecto propio en la curva semanal (cuota de días de la semana). */
export const SHARE_CATEGORIES = ['holiday', 'commercial', 'payday', 'promotion'] as const;

export const RESPONSE = {
  /** A prioris (media, sd). La elasticidad en el gasto medio; la tendencia, por 26 semanas. */
  priors: {
    intercept: 10,
    elasticity: { mean: 0.7, sd: 0.25 },
    curvature: 0.15,
    trend: 0.5,
    spillover: 0.2,
    event: 0.5,
  },
  /** Sesgo de confusión de la elasticidad observada: sd por defecto y correlación entre campañas. */
  confounding: { sd: 0.2, correlation: 0.5, minExperiments: 3, floor: 0.05 },
  minWeeks: 8,
  minEvents: 10,
  maxWeeks: 26,
  /** Semanas evaluadas en la validación de un paso para publicar el escenario. */
  minValidated: 10,
  validationDraws: 2000,
  /** Cambio relativo del gasto a partir del cual el escenario se marca como cambio grande. */
  largeChange: 0.3,
  draws: 10_000,
  experiment: { minPeriods: 6, minF: 10, burnInDays: 2 },
};

// --- Aleatoriedad reproducible

/** PRNG mulberry32: uniforme en [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal estándar (Box-Muller; se usa uno de los dos valores). */
export function normal(rand: () => number): number {
  const u = 1 - rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Poisson: Knuth con λ < 30; aproximación normal (con corrección de continuidad) por encima. */
export function poissonSample(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0;
  // ponytail: la normal sesga un poco las colas con 30 ≤ λ < 100; PTRS si hiciera falta exactitud.
  if (lambda >= 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rand)));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

export interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
}
export function quantiles(draws: Float64Array | number[]): Quantiles {
  const s = Float64Array.from(draws).sort();
  const q = (p: number) => {
    const h = (s.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.min(s.length - 1, lo + 1);
    const a = s[lo] as number;
    const b = s[hi] as number;
    return a === b ? a : a + (h - lo) * (b - a);
  };
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

// --- Álgebra lineal para pocos parámetros (k ≤ 9)

const at = (a: readonly number[], i: number) => a[i] as number;
const row = (m: readonly number[][], i: number) => m[i] as number[];

/** Cholesky: A = L·Lᵀ (A simétrica definida positiva). */
export function cholesky(A: readonly number[][]): number[][] | null {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = at(row(A, i), j);
      for (let k = 0; k < j; k++) s -= at(row(L, i), k) * at(row(L, j), k);
      if (i === j) {
        if (s <= 0) return null;
        row(L, i)[i] = Math.sqrt(s);
      } else row(L, i)[j] = s / at(row(L, j), j);
    }
  return L;
}
function cholSolve(L: readonly number[][], b: readonly number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = at(b, i);
    for (let k = 0; k < i; k++) s -= at(row(L, i), k) * at(y, k);
    y[i] = s / at(row(L, i), i);
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = at(y, i);
    for (let k = i + 1; k < n; k++) s -= at(row(L, k), i) * at(x, k);
    x[i] = s / at(row(L, i), i);
  }
  return x;
}
function cholInverse(L: readonly number[][]): number[][] {
  const n = L.length;
  return Array.from({ length: n }, (_, j) =>
    cholSolve(
      L,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    ),
  );
}
const dot = (a: readonly number[], b: readonly number[]) =>
  a.reduce((s, x, i) => s + x * at(b, i), 0);

// --- Regresión de Poisson con a prioris normales (aproximación de Laplace)

export interface PoissonFit {
  theta: number[];
  cov: number[][];
  /** Sobredispersión de Pearson (≥ 1) con los grados de libertad efectivos. */
  phi: number;
  /** Parámetros efectivos: Σ (1 − var a posteriori ÷ var a priori). */
  pEff: number;
  mu: number[];
}

/**
 * Modo del a posteriori por Newton con búsqueda de paso y covarianza (−∇²)⁻¹ en el modo. La
 * verosimilitud de cuasi-Poisson se divide por φ, que se estima con el ajuste a φ = 1.
 */
export function poissonLaplace(
  X: readonly number[][],
  y: readonly number[],
  mean: readonly number[],
  sd: readonly number[],
): PoissonFit | null {
  const k = mean.length;
  const solve = (phi: number) => {
    let theta = [...mean];
    const logPost = (t: readonly number[]) =>
      X.reduce((s, xr, w) => {
        const eta = Math.min(50, dot(xr, t));
        return s + (at(y, w) * eta - Math.exp(eta)) / phi;
      }, 0) - t.reduce((s, tj, j) => s + ((tj - at(mean, j)) / at(sd, j)) ** 2 / 2, 0);
    let A: number[][] = [];
    for (let iter = 0; iter < 100; iter++) {
      const g = theta.map((tj, j) => -(tj - at(mean, j)) / at(sd, j) ** 2);
      A = Array.from({ length: k }, (_, i) =>
        Array.from({ length: k }, (_, j) => (i === j ? 1 / at(sd, i) ** 2 : 0)),
      );
      X.forEach((xr, w) => {
        const mu = Math.exp(Math.min(50, dot(xr, theta)));
        const r = (at(y, w) - mu) / phi;
        for (let i = 0; i < k; i++) {
          g[i] = at(g, i) + at(xr, i) * r;
          for (let j = 0; j < k; j++)
            row(A, i)[j] = at(row(A, i), j) + (at(xr, i) * at(xr, j) * mu) / phi;
        }
      });
      const L = cholesky(A);
      if (!L) return null;
      let step = cholSolve(L, g);
      const before = logPost(theta);
      let tries = 0;
      while (logPost(theta.map((tj, j) => tj + at(step, j))) < before - 1e-12 && tries++ < 40)
        step = step.map((s) => s / 2);
      theta = theta.map((tj, j) => tj + at(step, j));
      if (step.reduce((s, x) => s + Math.abs(x), 0) < 1e-10) break;
    }
    const L = cholesky(A);
    if (!L) return null;
    const cov = cholInverse(L);
    return { theta, cov };
  };
  const first = solve(1);
  if (!first) return null;
  const mu1 = X.map((xr) => Math.exp(Math.min(50, dot(xr, first.theta))));
  const pEff = first.cov.reduce((s, r, j) => s + Math.max(0, 1 - at(r, j) / at(sd, j) ** 2), 0);
  const pearson = y.reduce(
    (s, yw, w) => s + (yw - at(mu1, w)) ** 2 / Math.max(at(mu1, w), 1e-9),
    0,
  );
  const phi = Math.max(1, pearson / Math.max(1, y.length - pEff));
  const final = phi > 1 ? solve(phi) : first;
  if (!final) return null;
  return {
    ...final,
    phi,
    pEff,
    mu: X.map((xr) => Math.exp(Math.min(50, dot(xr, final.theta)))),
  };
}

// --- 1. Datos semanales y curva de respuesta

export interface Week {
  /** Último día del bloque de 7 días. */
  end: string;
  /** Semanas desde la última (0 = la última; −1 la anterior…), aunque falten semanas. */
  index: number;
  spend: number;
  events: number;
  /** Gasto de las otras campañas con el mismo evento (0 si no hay). */
  others: number;
  /** Parte de los días de la semana en cada categoría de SHARE_CATEGORIES. */
  share: number[];
}

/**
 * Bloques de 7 días que acaban en el último día de la historia (quitan la estacionalidad semanal).
 * Se descartan las semanas sin gasto y las que tocan una incidencia.
 */
export function weeksOf(
  h: History,
  eventField: string,
  othersOn: (date: string) => number = () => 0,
): Week[] {
  const spend = h.field('spend');
  const events = h.field(eventField);
  const out: Week[] = [];
  for (
    let end = spend.length - 1, j = 0;
    end >= 6 && out.length < RESPONSE.maxWeeks;
    end -= 7, j++
  ) {
    let s = 0;
    let e = 0;
    let o = 0;
    let skip = false;
    const share = SHARE_CATEGORIES.map(() => 0);
    for (let i = end - 6; i <= end; i++) {
      if (h.excluded[i] || !Number.isFinite(at(spend, i)) || !Number.isFinite(at(events, i)))
        skip = true;
      s += at(spend, i);
      e += at(events, i);
      o += othersOn(h.dates[i] as string);
      const c = SHARE_CATEGORIES.indexOf(h.event[i]?.category as (typeof SHARE_CATEGORIES)[number]);
      if (c >= 0) share[c] = at(share, c) + 1 / 7;
    }
    if (!skip && s > 0 && Number.isFinite(o))
      out.push({ end: h.dates[end] as string, index: -j, spend: s, events: e, others: o, share });
  }
  return out.reverse();
}

export interface CurveFit extends PoissonFit {
  /** Cholesky de la covarianza (para extraer parámetros). */
  chol: number[][];
  xMean: number;
  /** Gasto de las otras campañas: suelo (10 % de su media) y media de su log. */
  oFloor: number;
  oMean: number;
  hasOthers: boolean;
  weeks: number;
  events: number;
  spendRange: [number, number];
  /** Choque semanal (log) sin el ruido de Poisson, por semana (fin) y en lista. */
  shocks: Map<string, number>;
  shockList: number[];
  shockSd: number;
}

/** Términos: 0 nivel · 1 b · 2 curvatura · 3 tendencia · 4 otras campañas · 5–8 eventos. */
const features =
  (fit: Pick<CurveFit, 'xMean' | 'oFloor' | 'oMean' | 'hasOthers'>) =>
  (spend: number, index: number, others: number, share: readonly number[]) => {
    const x = Math.log(spend) - fit.xMean;
    const o = fit.hasOthers ? Math.log(Math.max(others, fit.oFloor)) - fit.oMean : 0;
    return [1, x, x * x, index / 26, o, ...share];
  };

export function fitCurve(weeks: readonly Week[], priors = RESPONSE.priors): CurveFit | null {
  const n = weeks.length;
  const events = weeks.reduce((s, w) => s + w.events, 0);
  if (n < RESPONSE.minWeeks || events < RESPONSE.minEvents) return null;
  const xMean = weeks.reduce((s, w) => s + Math.log(w.spend), 0) / n;
  const othersMean = weeks.reduce((s, w) => s + w.others, 0) / n;
  const hasOthers = othersMean > 0;
  const oFloor = 0.1 * othersMean;
  const oMean = hasOthers
    ? weeks.reduce((s, w) => s + Math.log(Math.max(w.others, oFloor)), 0) / n
    : 0;
  const norm = { xMean, oFloor, oMean, hasOthers };
  const f = features(norm);
  const X = weeks.map((w) => f(w.spend, w.index, w.others, w.share));
  const y = weeks.map((w) => w.events);
  const mean = [
    Math.log(events / n + 0.5),
    priors.elasticity.mean,
    0,
    0,
    0,
    ...SHARE_CATEGORIES.map(() => 0),
  ];
  const sd = [
    priors.intercept,
    priors.elasticity.sd,
    priors.curvature,
    priors.trend,
    priors.spillover,
    ...SHARE_CATEGORIES.map(() => priors.event),
  ];
  const p = poissonLaplace(X, y, mean, sd);
  if (!p) return null;
  const chol = cholesky(p.cov);
  if (!chol) return null;

  // Choques: residuo log menos la parte esperada del ruido de Poisson (deconvolución por
  // contracción) e inflado por el ajuste dentro de la muestra; media de e^choque = 1.
  const r = weeks.map((w, i) => Math.log((w.events + 0.5) / (at(p.mu, i) + 0.5)));
  const rMean = r.reduce((s, x) => s + x, 0) / n;
  const r2 = r.reduce((s, x) => s + (x - rMean) ** 2, 0) / n;
  const poissonPart = p.mu.reduce((s, m) => s + 1 / (m + 0.5), 0) / n;
  const shockVar = (Math.max(0, r2 - poissonPart) * n) / Math.max(1, n - p.pEff);
  const k = r2 > 0 ? Math.sqrt(shockVar / r2) : 0;
  const raw = r.map((x) => k * (x - rMean));
  const correction = Math.log(raw.reduce((s, x) => s + Math.exp(x), 0) / n);
  const shockList = raw.map((x) => x - correction);
  const spends = weeks.map((w) => w.spend);
  return {
    ...p,
    chol,
    ...norm,
    weeks: n,
    events,
    spendRange: [Math.min(...spends), Math.max(...spends)],
    shocks: new Map(weeks.map((w, i) => [w.end, at(shockList, i)])),
    shockList,
    shockSd: Math.sqrt(shockVar),
  };
}

/** Extracción de θ del a posteriori normal. */
function sampleTheta(fit: CurveFit, rand: () => number): number[] {
  const z = fit.theta.map(() => normal(rand));
  return fit.theta.map((t, i) => t + dot(row(fit.chol, i), z));
}

/** Elasticidad observada en un gasto semanal (b + 2q·x) con su desviación típica a posteriori. */
export function localElasticity(fit: CurveFit, weeklySpend: number) {
  const x = Math.log(weeklySpend) - fit.xMean;
  const c = fit.cov;
  const variance = at(row(c, 1), 1) + 4 * x * x * at(row(c, 2), 2) + 4 * x * at(row(c, 1), 2);
  return {
    mean: at(fit.theta, 1) + 2 * at(fit.theta, 2) * x,
    sd: Math.sqrt(Math.max(0, variance)),
  };
}

/** Eventos semanales esperados con un gasto semanal y el de las otras campañas (semana sin eventos). */
export function expectedWeekly(fit: CurveFit, weeklySpend: number, othersWeekly = 0): number {
  const x = features(fit)(
    weeklySpend,
    0,
    othersWeekly,
    SHARE_CATEGORIES.map(() => 0),
  );
  return Math.exp(Math.min(50, dot(x, fit.theta)));
}

/** Lo aprendido de los datos para un término: 1 − var a posteriori ÷ var a priori. */
export const learned = (fit: CurveFit, term: number, priorSd: number) =>
  Math.max(0, 1 - at(row(fit.cov, term), term) / priorSd ** 2);

/**
 * Curva monótona: el cambio de log μ al mover el log gasto en Δ desde el punto de anclaje, con
 * pendiente e y curvatura q, nunca baja al subir el gasto ni sube al bajarlo.
 */
export function monotone(e: number, q: number, delta: number): number {
  const f = (z: number) => e * z + q * z * z;
  const vertex = q !== 0 ? -e / (2 * q) : Number.NaN;
  const candidates = [0, f(delta)];
  if (
    Number.isFinite(vertex) &&
    (delta >= 0 ? vertex > 0 && vertex < delta : vertex < 0 && vertex > delta)
  )
    candidates.push(f(vertex));
  return delta >= 0 ? Math.max(...candidates) : Math.min(...candidates);
}

// --- 2. Validación

/** PIT aleatorizado de un conteo frente a extracciones de su predictiva (Czado et al., 2009). */
function pit(fit: CurveFit, x: number[], observed: number, rand: () => number) {
  let below = 0;
  let equal = 0;
  let sum = 0;
  for (let i = 0; i < RESPONSE.validationDraws; i++) {
    const mu = Math.exp(Math.min(50, dot(x, sampleTheta(fit, rand))));
    const shock = at(fit.shockList, Math.floor(rand() * fit.shockList.length));
    const yi = poissonSample(mu * Math.exp(shock), rand);
    if (yi < observed) below++;
    else if (yi === observed) equal++;
    sum += mu;
  }
  return {
    u: (below + rand() * equal) / RESPONSE.validationDraws,
    mean: sum / RESPONSE.validationDraws,
  };
}

export interface Validation {
  evaluated: number;
  /** Fracción de semanas con PIT aleatorizado dentro de [0,1; 0,9] (nominal 80 %). */
  coverage: number | null;
  mae: number | null;
  /** MAE ÷ MAE del costo constante de las 4 semanas previas (< 1 lo supera). */
  relMae: number | null;
}

/** Validación de un paso: con las semanas anteriores, predecir la siguiente dado su gasto. */
export function validateResponse(weeks: readonly Week[], seed = 1): Validation {
  const rand = mulberry32(seed);
  let evaluated = 0;
  let inside = 0;
  let abs = 0;
  let baseAbs = 0;
  let baseN = 0;
  for (let w = RESPONSE.minWeeks; w < weeks.length; w++) {
    const fit = fitCurve(weeks.slice(0, w));
    if (!fit) continue;
    const target = weeks[w] as Week;
    const p = pit(
      fit,
      features(fit)(target.spend, target.index, target.others, target.share),
      target.events,
      rand,
    );
    evaluated++;
    if (p.u >= 0.1 && p.u <= 0.9) inside++;
    abs += Math.abs(target.events - p.mean);
    const prev = weeks.slice(w - 4, w);
    const ps = prev.reduce((s, x) => s + x.spend, 0);
    if (ps > 0) {
      baseAbs += Math.abs(
        target.events - (target.spend * prev.reduce((s, x) => s + x.events, 0)) / ps,
      );
      baseN++;
    }
  }
  return {
    evaluated,
    coverage: evaluated ? inside / evaluated : null,
    mae: evaluated ? abs / evaluated : null,
    relMae: baseN && baseAbs > 0 ? abs / baseAbs : null,
  };
}

export interface ExtremesValidation {
  evaluated: number;
  coverage: number | null;
  /** Hasta dónde se extrapoló en la prueba, en log del gasto semanal, por arriba y por abajo. */
  reachAbove: number;
  reachBelow: number;
}

/**
 * Validación de extremos: se ajusta sin la quinta parte de semanas de más gasto y se predicen; lo
 * mismo con las de menos gasto. Es la prueba de que la curva extrapola bien (la de un paso solo
 * prueba cerca del gasto habitual y no detecta una forma equivocada lejos de él).
 */
export function validateExtremes(weeks: readonly Week[], seed = 1): ExtremesValidation {
  const rand = mulberry32(seed + 7919);
  const n = weeks.length;
  const k = Math.max(3, Math.round(n / 5));
  const none = { evaluated: 0, coverage: null, reachAbove: 0, reachBelow: 0 };
  if (n - k < RESPONSE.minWeeks) return none;
  const sorted = [...weeks].sort((a, b) => a.spend - b.spend);
  let evaluated = 0;
  let inside = 0;
  const reach = { above: 0, below: 0 };
  for (const side of ['above', 'below'] as const) {
    const held = side === 'above' ? sorted.slice(n - k) : sorted.slice(0, k);
    const rest = weeks.filter((w) => !held.includes(w));
    const fit = fitCurve(rest);
    if (!fit) continue;
    const restLog = rest.map((w) => Math.log(w.spend));
    const edge = side === 'above' ? Math.max(...restLog) : Math.min(...restLog);
    for (const w of held) {
      const p = pit(fit, features(fit)(w.spend, w.index, w.others, w.share), w.events, rand);
      evaluated++;
      if (p.u >= 0.1 && p.u <= 0.9) inside++;
      const d = side === 'above' ? Math.log(w.spend) - edge : edge - Math.log(w.spend);
      reach[side] = Math.max(reach[side], d);
    }
  }
  return {
    evaluated,
    coverage: evaluated ? inside / evaluated : null,
    reachAbove: reach.above,
    reachBelow: reach.below,
  };
}

/**
 * Rango de gasto semanal donde se publican escenarios: el observado, ampliado hasta donde la
 * validación de extremos comprobó que la curva extrapola bien; si esa validación falla, solo el
 * rango intercuartílico (la forma de la curva no es fiable lejos del centro).
 */
export function validatedRange(fit: CurveFit, weeks: readonly Week[], ext: ExtremesValidation) {
  const logs = weeks.map((w) => Math.log(w.spend)).sort((a, b) => a - b);
  if (ext.coverage !== null && coverageOk(ext.coverage, ext.evaluated))
    return {
      min: fit.spendRange[0] * Math.exp(-ext.reachBelow),
      max: fit.spendRange[1] * Math.exp(ext.reachAbove),
      reliableShape: true,
    };
  const q = (p: number) => Math.exp(at(logs, Math.round((logs.length - 1) * p)));
  return { min: q(0.25), max: q(0.75), reliableShape: false };
}

/** Correlación media de los choques entre campañas en las semanas comunes (≥ 6). */
export function shockCorrelation(fits: readonly CurveFit[]): number | null {
  const pairs: number[] = [];
  for (let i = 0; i < fits.length; i++)
    for (let j = i + 1; j < fits.length; j++) {
      const a = fits[i] as CurveFit;
      const b = fits[j] as CurveFit;
      const common = [...a.shocks.keys()].filter((k) => b.shocks.has(k));
      if (common.length < 6) continue;
      const xs = common.map((k) => a.shocks.get(k) as number);
      const ys = common.map((k) => b.shocks.get(k) as number);
      const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
      const my = ys.reduce((s, x) => s + x, 0) / ys.length;
      const sxy = xs.reduce((s, x, k) => s + (x - mx) * (at(ys, k) - my), 0);
      const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
      if (sxx > 0 && syy > 0) pairs.push(sxy / Math.sqrt(sxx * syy));
    }
  return pairs.length ? pairs.reduce((s, x) => s + x, 0) / pairs.length : null;
}

/** Autocorrelación de orden 1 media de los choques (semanas consecutivas), acotada a [0; 0,9]. */
export function shockPersistence(fits: readonly CurveFit[]): number {
  const values: number[] = [];
  for (const f of fits) {
    const weeks = [...f.shocks].sort((a, b) => a[0].localeCompare(b[0]));
    const pairs: Array<[number, number]> = [];
    for (let i = 1; i < weeks.length; i++) {
      const prev = weeks[i - 1] as [string, number];
      const cur = weeks[i] as [string, number];
      if (addDays(prev[0], 7) === cur[0]) pairs.push([prev[1], cur[1]]);
    }
    if (pairs.length < 6) continue;
    const m = f.shockList.reduce((s, x) => s + x, 0) / f.shockList.length;
    const v = f.shockList.reduce((s, x) => s + (x - m) ** 2, 0) / f.shockList.length;
    if (v > 0)
      values.push(pairs.reduce((s, [a, b]) => s + (a - m) * (b - m), 0) / pairs.length / v);
  }
  const mean = values.length ? values.reduce((s, x) => s + x, 0) / values.length : 0;
  return Math.min(0.9, Math.max(0, mean));
}

// --- 3. Elasticidad causal y sesgo de confusión

export interface ExperimentEstimate {
  mean: number;
  se: number;
}

/**
 * Elasticidad para un cambio de presupuesto. Sin experimento: la observada con un sesgo de
 * confusión N(0; σ²) sumado. Con un experimento concluyente: la experimental sola. Combinarla con
 * la observada empeora cuando el sesgo real supera σ (E6: 25 % de cobertura frente a 85 %).
 */
export function causalElasticity(
  observed: { mean: number; sd: number },
  biasSd: number,
  experiment: ExperimentEstimate | null,
) {
  if (experiment)
    return { mean: experiment.mean, sd: experiment.se, source: 'experiment' as const };
  return {
    mean: observed.mean,
    sd: Math.sqrt(observed.sd ** 2 + biasSd ** 2),
    source: 'observational' as const,
  };
}

/**
 * σ del sesgo de confusión: 0,2 por defecto; con ≥ 3 experimentos propios, la discrepancia media
 * entre la elasticidad observada antes de cada experimento y la medida, sin su ruido de muestreo.
 */
export function confoundingSd(
  pairs: ReadonlyArray<{
    observed: number;
    observedSe: number;
    experimental: number;
    experimentalSe: number;
  }>,
) {
  const c = RESPONSE.confounding;
  if (pairs.length < c.minExperiments)
    return { sd: c.sd, source: 'default' as const, n: pairs.length };
  const excess =
    pairs.reduce(
      (s, p) => s + (p.observed - p.experimental) ** 2 - p.observedSe ** 2 - p.experimentalSe ** 2,
      0,
    ) / pairs.length;
  return {
    sd: Math.max(c.floor, Math.sqrt(Math.max(0, excess))),
    source: 'experiments' as const,
    n: pairs.length,
  };
}

// --- 4. Monte Carlo de escenarios

export interface Plan {
  id: string;
  /** Agrupa los totales (mismo tipo de evento). */
  group: string;
  fit: CurveFit;
  currentDaily: number;
  plannedDaily: number;
  /** Gasto semanal de las otras campañas del grupo, ahora y con el plan. */
  othersCurrent: number;
  othersPlanned: number;
  experiment: ExperimentEstimate | null;
  /** Cuota de días de evento de cada semana del horizonte (SHARE_CATEGORIES). */
  shares: number[][];
}

export interface PlanOutcome {
  id: string;
  spend: number;
  events: Quantiles;
  /** Costo por evento (null = sin cota: P(0 eventos) alta). */
  cost: { p10: number | null; p50: number | null; p90: number | null };
  probNoEvents: number;
  /** Cambio de los eventos esperados frente a mantener el gasto actual (parámetros y confusión). */
  expectedChange: Quantiles;
  /** Gasto semanal planificado fuera del rango observado. */
  extrapolation: boolean;
  /** Cambio del gasto diario de más de ±30 %. */
  largeChange: boolean;
}

export function simulatePlans(
  plans: readonly Plan[],
  horizonDays: number,
  opts: { draws?: number; seed?: number; biasSd?: number } = {},
) {
  const draws = opts.draws ?? RESPONSE.draws;
  const rand = mulberry32(opts.seed ?? 1);
  const biasSd = opts.biasSd ?? RESPONSE.confounding.sd;
  const rho = RESPONSE.confounding.correlation;
  const K = Math.ceil(horizonDays / 7);
  const fraction = (k: number) => (k < K - 1 ? 1 : horizonDays / 7 - (K - 1));
  // Remuestreo estacionario (Politis y Romano, 1994) de semanas del calendario, la misma semana a la
  // vez en todas las campañas (conserva su correlación). Cada semana continúa el bloque con
  // probabilidad igual a la autocorrelación de los choques; si no la hay, las semanas son
  // independientes (bloques fijos con 26 semanas dan pocas sumas distintas y colas estrechas).
  const weekEnds = [...new Set(plans.flatMap((p) => [...p.fit.shocks.keys()]))].sort();
  const M = weekEnds.length;
  const persistence = shockPersistence(plans.map((p) => p.fit));

  const prepared = plans.map((plan) => {
    const f = features(plan.fit);
    const anchorSpend = plan.currentDaily > 0 ? 7 * plan.currentDaily : Math.exp(plan.fit.xMean);
    const xAnchor = Math.log(anchorSpend) - plan.fit.xMean;
    const delta = plan.plannedDaily > 0 ? Math.log((7 * plan.plannedDaily) / anchorSpend) : 0;
    const oOf = (o: number) =>
      plan.fit.hasOthers ? Math.log(Math.max(o, plan.fit.oFloor)) - plan.fit.oMean : 0;
    const exp = plan.experiment
      ? causalElasticity(localElasticity(plan.fit, anchorSpend), biasSd, plan.experiment)
      : null;
    return {
      plan,
      rows: Array.from({ length: K }, (_, k) =>
        f(anchorSpend, 0, plan.othersCurrent, plan.shares[k] ?? SHARE_CATEGORIES.map(() => 0)),
      ),
      xAnchor,
      delta,
      deltaO: oOf(plan.othersPlanned) - oOf(plan.othersCurrent),
      exp,
      events: new Float64Array(draws),
      change: new Float64Array(draws),
    };
  });

  // Campañas con choques comunes se equivocan juntas al estimar su nivel y su tendencia: esos dos
  // términos se extraen con la correlación media de los choques del grupo (modelo de un factor).
  const groupRho = new Map<string, number>();
  for (const g of new Set(plans.map((p) => p.group)))
    groupRho.set(
      g,
      Math.min(
        0.99,
        Math.max(0, shockCorrelation(plans.filter((p) => p.group === g).map((p) => p.fit)) ?? 0),
      ),
    );

  for (let i = 0; i < draws; i++) {
    const path: number[] = [];
    for (let k = 0; k < K; k++)
      path.push(
        k > 0 && rand() < persistence ? ((path[k - 1] as number) + 1) % M : Math.floor(rand() * M),
      );
    const common = normal(rand);
    const factors = new Map([...groupRho.keys()].map((g) => [g, [normal(rand), normal(rand)]]));
    for (const p of prepared) {
      const { plan } = p;
      const r = groupRho.get(plan.group) ?? 0;
      const [f0, f3] = factors.get(plan.group) as number[];
      const z = plan.fit.theta.map(() => normal(rand));
      z[0] = Math.sqrt(r) * (f0 as number) + Math.sqrt(1 - r) * at(z, 0);
      z[3] = Math.sqrt(r) * (f3 as number) + Math.sqrt(1 - r) * at(z, 3);
      const theta = plan.fit.theta.map((t, j) => t + dot(row(plan.fit.chol, j), z));
      const q = at(theta, 2);
      const elasticity = p.exp
        ? p.exp.mean + p.exp.sd * normal(rand)
        : at(theta, 1) +
          2 * q * p.xAnchor +
          biasSd * (Math.sqrt(rho) * common + Math.sqrt(1 - rho) * normal(rand));
      const bump = monotone(elasticity, q, p.delta) + at(theta, 4) * p.deltaO;
      let events = 0;
      let change = 0;
      for (let k = 0; k < K; k++) {
        const level = Math.exp(Math.min(50, dot(p.rows[k] as number[], theta))) * fraction(k);
        const current = plan.currentDaily > 0 ? level : 0;
        const planned = plan.plannedDaily > 0 ? level * Math.exp(bump) : 0;
        const shock =
          plan.fit.shocks.get(weekEnds[path[k] as number] as string) ??
          at(plan.fit.shockList, Math.floor(rand() * plan.fit.shockList.length));
        events += poissonSample(planned * Math.exp(shock), rand);
        change += planned - current;
      }
      p.events[i] = events;
      p.change[i] = change;
    }
  }

  const totals = new Map<string, { events: Float64Array; change: Float64Array; spend: number }>();
  const outcomes: PlanOutcome[] = prepared.map((p) => {
    const { plan } = p;
    const spend = plan.plannedDaily * horizonDays;
    const t = totals.get(plan.group) ?? {
      events: new Float64Array(draws),
      change: new Float64Array(draws),
      spend: 0,
    };
    for (let i = 0; i < draws; i++) {
      t.events[i] = (t.events[i] as number) + (p.events[i] as number);
      t.change[i] = (t.change[i] as number) + (p.change[i] as number);
    }
    t.spend += spend;
    totals.set(plan.group, t);
    const weekly = 7 * plan.plannedDaily;
    return {
      id: plan.id,
      spend,
      ...summarize(p.events, spend),
      expectedChange: quantiles(p.change),
      extrapolation:
        weekly > 0 && (weekly < plan.fit.spendRange[0] || weekly > plan.fit.spendRange[1]),
      largeChange:
        plan.currentDaily > 0
          ? Math.abs(plan.plannedDaily / plan.currentDaily - 1) > RESPONSE.largeChange + 1e-9
          : plan.plannedDaily > 0,
    };
  });
  return {
    outcomes,
    totals: [...totals].map(([group, t]) => ({
      group,
      spend: t.spend,
      ...summarize(t.events, t.spend),
      expectedChange: quantiles(t.change),
    })),
  };
}

/** Eventos y costo por evento de las extracciones; con 0 eventos el costo no tiene cota. */
function summarize(events: Float64Array, spend: number) {
  const q = quantiles(events);
  const zero = events.reduce((n, e) => n + (e === 0 ? 1 : 0), 0) / events.length;
  // El costo baja cuando suben los eventos: su P10 sale del P90 de los eventos y al revés.
  const cost = (e: number) => (spend === 0 ? 0 : e > 0 ? spend / e : null);
  return {
    events: q,
    cost: { p10: cost(q.p90), p50: cost(q.p50), p90: cost(q.p10) },
    probNoEvents: zero,
  };
}

// --- 5. Experimentos de presupuesto aleatorizados

export interface ExperimentPeriod {
  period: number;
  since: string;
  until: string;
  multiplier: number;
}

/**
 * Diseño por bloques aleatorizados: periodos de 7 días; cada bloque contiene cada nivel una vez en
 * orden aleatorio (con semilla). Equilibra los niveles frente a la tendencia y a la estacionalidad.
 */
export function designExperiment(opts: {
  start: string;
  levels: readonly number[];
  blocks: number;
  seed: number;
}): ExperimentPeriod[] {
  const rand = mulberry32(opts.seed);
  const out: ExperimentPeriod[] = [];
  for (let b = 0; b < opts.blocks; b++) {
    const order = [...opts.levels];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    for (const m of order) {
      const since = addDays(opts.start, 7 * out.length);
      out.push({ period: out.length + 1, since, until: addDays(since, 6), multiplier: m });
    }
  }
  return out;
}

/**
 * Error típico esperado de la elasticidad medida (aproximado, con cumplimiento perfecto):
 * se ≈ σ_y / √Σ(z − z̄)², con σ_y² = 1/eventos por periodo analizado + σ²_choque.
 */
export function experimentPower(opts: {
  weeklyEvents: number;
  shockSd: number;
  levels: readonly number[];
  blocks: number;
  burnInDays: number;
}) {
  const perPeriod = (opts.weeklyEvents * (7 - opts.burnInDays)) / 7;
  const varY = 1 / Math.max(perPeriod, 1e-9) + opts.shockSd ** 2;
  const z = opts.levels.map((m) => Math.log(m));
  const zMean = z.reduce((s, x) => s + x, 0) / z.length;
  const szz = opts.blocks * z.reduce((s, x) => s + (x - zMean) ** 2, 0);
  const se = szz > 0 ? Math.sqrt(varY / szz) : Number.POSITIVE_INFINITY;
  // Diferencia detectable con α = 0,05 bilateral y potencia del 80 %.
  return { se, detectable: 2.8 * se };
}

export interface ExperimentResult {
  periods: number;
  analyzed: number;
  complete: boolean;
  /** Elasticidad causal (variable instrumental) e intervalo del 80 %. */
  elasticity: { point: number; se: number; lower: number; upper: number } | null;
  /** Primera etapa: pendiente del log gasto real sobre el log nivel asignado. */
  firstStage: { slope: number; se: number; f: number } | null;
  /** Gasto real ÷ asignado (mediana): ¿se aplicó el plan? */
  compliance: number | null;
  reasons: string[];
}

/**
 * Análisis por variable instrumental: z = ln(multiplicador asignado al azar), x = ln(gasto real),
 * y = eventos, con tendencia. Forma reducida de Poisson (ρ) y primera etapa por MCO (π):
 * b = ρ/π, error típico por el método delta. Solo periodos maduros y sin los días de transición.
 */
export function analyzeExperiment(
  schedule: readonly ExperimentPeriod[],
  day: (date: string) => { spend: number; events: number },
  cut: string,
  baseDaily: number,
  burnInDays = RESPONSE.experiment.burnInDays,
): ExperimentResult {
  const rows: Array<{ z: number; x: number; y: number; t: number; ratio: number }> = [];
  for (const p of schedule) {
    if (p.until > cut) continue;
    let spend = 0;
    let events = 0;
    for (let d = addDays(p.since, burnInDays); d <= p.until; d = addDays(d, 1)) {
      const v = day(d);
      spend += v.spend;
      events += v.events;
    }
    if (spend <= 0 || !Number.isFinite(spend) || !Number.isFinite(events)) continue;
    rows.push({
      z: Math.log(p.multiplier),
      x: Math.log(spend),
      y: events,
      t: p.period / schedule.length,
      ratio: spend / (baseDaily * p.multiplier * (7 - burnInDays)),
    });
  }
  const base: ExperimentResult = {
    periods: schedule.length,
    analyzed: rows.length,
    complete: schedule.every((p) => p.until <= cut),
    elasticity: null,
    firstStage: null,
    compliance: rows.length
      ? ([...rows.map((r) => r.ratio)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null)
      : null,
    reasons: [],
  };
  const levels = new Set(rows.map((r) => r.z));
  if (rows.length < RESPONSE.experiment.minPeriods || levels.size < 2)
    return {
      ...base,
      reasons: [
        `${rows.length} periodos analizables de ${schedule.length} (hacen falta ${RESPONSE.experiment.minPeriods} y al menos dos niveles).`,
      ],
    };
  const X = rows.map((r) => [1, r.z, r.t]);
  // Primera etapa por MCO.
  const xtx = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => X.reduce((s, xr) => s + at(xr, i) * at(xr, j), 0)),
  );
  const L = cholesky(xtx);
  if (!L) return { ...base, reasons: ['Diseño degenerado: los niveles no varían.'] };
  const beta = cholSolve(
    L,
    [0, 1, 2].map((i) =>
      X.reduce((s, xr, w) => s + at(xr, i) * (rows[w] as (typeof rows)[number]).x, 0),
    ),
  );
  const rss = rows.reduce((s, r, w) => s + (r.x - dot(row(X, w), beta)) ** 2, 0);
  const s2 = rss / Math.max(1, rows.length - 3);
  const piSe = Math.sqrt(s2 * at(row(cholInverse(L), 1), 1));
  const pi = at(beta, 1);
  const f = piSe > 0 ? (pi / piSe) ** 2 : Number.POSITIVE_INFINITY;
  // Forma reducida de Poisson con a prioris casi planos.
  const yMean = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const rf = poissonLaplace(
    X,
    rows.map((r) => r.y),
    [Math.log(yMean + 0.5), 0, 0],
    [10, 10, 10],
  );
  if (!rf) return { ...base, reasons: ['La forma reducida no convergió.'] };
  const rho = at(rf.theta, 1);
  const rhoSe = Math.sqrt(at(row(rf.cov, 1), 1));
  const firstStage = { slope: pi, se: piSe, f };
  if (f < RESPONSE.experiment.minF || pi <= 0)
    return {
      ...base,
      firstStage,
      reasons: [
        `Instrumento débil: el gasto real apenas siguió a los niveles asignados (F = ${f.toFixed(1)}, mínimo ${RESPONSE.experiment.minF}). Revisa que el plan se aplicara.`,
      ],
    };
  const point = rho / pi;
  const se = Math.sqrt(rhoSe ** 2 / pi ** 2 + (rho ** 2 * piSe ** 2) / pi ** 4);
  return {
    ...base,
    firstStage,
    elasticity: { point, se, lower: point - 1.2816 * se, upper: point + 1.2816 * se },
  };
}

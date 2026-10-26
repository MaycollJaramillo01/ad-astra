import type { History } from './forecast.ts';

// Escenarios de presupuesto (ARCHITECTURE §6.10, docs/FORECASTING.md §4–5). Funciones puras: la
// aleatoriedad sale de un PRNG con semilla, así que misma entrada y semilla → mismo resultado.
//
//   1. Curva de respuesta semanal por campaña: eventos ~ Poisson sobredispersa con
//      log μ = a + b·(ln gasto − media), a priori débil sobre la elasticidad b y aproximación de
//      Laplace del a posteriori (modo por Newton, covarianza = inversa del hessiano).
//   2. Validación de un paso: se ajusta con las semanas anteriores y se predice la siguiente dado
//      su gasto; cobertura del 80 % con PIT aleatorizado y error frente a "costo constante".
//   3. Monte Carlo: parámetros del a posteriori + ruido Gamma-Poisson → P10/P50/P90.
//
// Es una relación observada entre gasto y resultados, no un efecto causal: el gasto no se asignó
// al azar (lo deciden el anunciante y la entrega de Meta según el rendimiento).

export const SIMULATION_VERSION = 'simulate-1.0.0';

/** Ficha del simulador: se publica con cada escenario (CA-F6-03). */
export const SIMULATION_CARD = {
  assumptions: [
    'El gasto es el plan: se supone que Meta entrega el gasto diario indicado; la entrega real puede quedarse por debajo.',
    'Por campaña, eventos semanales ∝ gasto semanal^b, ajustado con sus últimas 26 semanas (tras el último cambio de atribución o pausa); a priori de b: N(0,7; 0,25²).',
    'Campañas independientes entre sí (sin canibalización ni efectos cruzados) y sin efectos retardados del gasto.',
    'Mismo objetivo, segmentación y creatividades. Un cambio grande de presupuesto puede reiniciar la fase de aprendizaje, y eso no está modelado.',
    'Pausar una campaña da 0 eventos.',
  ],
  limitations: [
    'Estimación, no garantía.',
    'Relación observada, no causal: el gasto histórico no se asignó al azar, así que b mezcla el efecto del presupuesto con lo que hizo que el presupuesto cambiara.',
    'Fuera del rango de gasto semanal observado es extrapolación: la forma de la curva allí no está respaldada por datos.',
    'Cambios de más de ±30 % son menos fiables: en las simulaciones de validación, con +100 % el intervalo cubrió el 67 % de los resultados reales si la forma de la curva era la correcta y el 50 % si la respuesta real saturaba antes (docs/FORECASTING.md, E4).',
    'Con poca variación del gasto en la historia, b la decide sobre todo el a priori (ver "aprendido de los datos").',
    'Los totales suman las campañas como independientes: si se mueven juntas, el rango real es más ancho.',
  ],
};

export const RESPONSE = {
  /** A priori débil de la elasticidad: N(0,7; 0,25²) → 95 % entre 0,21 y 1,19. */
  prior: { mean: 0.7, sd: 0.25 },
  /** A priori casi plano del intercepto (escala log). */
  interceptSd: 10,
  minWeeks: 8,
  minEvents: 10,
  maxWeeks: 26,
  /** Semanas evaluadas en la validación de un paso para publicar el escenario. */
  minValidated: 10,
  validationDraws: 2000,
  /**
   * Cambio relativo del gasto a partir del cual el escenario se marca como menos fiable. El margen
   * de ±50 % sobre el rango observado del diseño inicial resultó demasiado permisivo (E4).
   */
  largeChange: 0.3,
  draws: 10_000,
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

/** Gamma(forma k, escala 1) de Marsaglia y Tsang (2000); k < 1 con el aumento U^(1/k). */
export function gammaSample(k: number, rand: () => number): number {
  if (k < 1) return gammaSample(k + 1, rand) * (1 - rand()) ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let w: number;
    do {
      x = normal(rand);
      w = 1 + c * x;
    } while (w <= 0);
    w = w * w * w;
    const u = 1 - rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - w + Math.log(w)))
      return d * w;
  }
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

/** Binomial negativa como Gamma-Poisson: media μ y varianza φ·μ (φ = 1 → Poisson). */
export function negBinomialSample(mean: number, phi: number, rand: () => number): number {
  if (mean <= 0) return 0;
  if (phi <= 1 + 1e-9) return poissonSample(mean, rand);
  return poissonSample(gammaSample(mean / (phi - 1), rand) * (phi - 1), rand);
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

// --- 1. Curva de respuesta

export interface Week {
  /** Último día del bloque de 7 días. */
  end: string;
  spend: number;
  events: number;
}

/**
 * Bloques de 7 días que acaban en el último día de la historia (la semana quita la estacionalidad
 * semanal). Se descartan las semanas sin gasto y las que tocan un evento externo excluido.
 */
export function weeksOf(h: History, eventField: string): Week[] {
  const spend = h.field('spend');
  const events = h.field(eventField);
  const out: Week[] = [];
  for (let end = spend.length - 1; end >= 6 && out.length < RESPONSE.maxWeeks; end -= 7) {
    let s = 0;
    let e = 0;
    let skip = false;
    for (let i = end - 6; i <= end; i++) {
      if (h.excluded[i]) skip = true;
      s += spend[i] as number;
      e += events[i] as number;
    }
    if (!skip && s > 0) out.push({ end: h.dates[end] as string, spend: s, events: e });
  }
  return out.reverse();
}

export interface ResponseFit {
  /** Log de los eventos semanales esperados con el gasto semanal medio (geométrico). */
  a: number;
  /** Elasticidad: +1 % de gasto semanal ↔ +b % de eventos (relación observada, no causal). */
  b: number;
  cov: { aa: number; ab: number; bb: number };
  /** Sobredispersión (varianza ÷ media de Pearson, ≥ 1). */
  phi: number;
  /** Media de ln(gasto semanal). */
  xMean: number;
  weeks: number;
  events: number;
  /** Gasto semanal mínimo y máximo observados. */
  spendRange: [number, number];
  /** 1 − var a posteriori ÷ var a priori de b: 0 = lo decide el supuesto, 1 = los datos. */
  learned: number;
}

export function fitResponse(weeks: readonly Week[], prior = RESPONSE.prior): ResponseFit | null {
  const n = weeks.length;
  const events = weeks.reduce((s, w) => s + w.events, 0);
  if (n < RESPONSE.minWeeks || events < RESPONSE.minEvents) return null;
  const x = weeks.map((w) => Math.log(w.spend));
  const xMean = x.reduce((a, b) => a + b, 0) / n;
  const xc = x.map((xi) => xi - xMean);
  const y = weeks.map((w) => w.events);
  const ma = Math.log(events / n + 0.5);
  const va = RESPONSE.interceptSd ** 2;
  const vb = prior.sd ** 2;

  const mode = (phi: number) => {
    const logPost = (a: number, b: number) =>
      y.reduce(
        (s, yi, i) =>
          s + (yi * (a + b * (xc[i] as number)) - Math.exp(a + b * (xc[i] as number))) / phi,
        0,
      ) -
      (a - ma) ** 2 / (2 * va) -
      (b - prior.mean) ** 2 / (2 * vb);
    let a = ma;
    let b = prior.mean;
    let haa = 0;
    let hab = 0;
    let hbb = 0;
    for (let iter = 0; iter < 100; iter++) {
      let ga = -(a - ma) / va;
      let gb = -(b - prior.mean) / vb;
      haa = -1 / va;
      hab = 0;
      hbb = -1 / vb;
      y.forEach((yi, i) => {
        const xi = xc[i] as number;
        const mu = Math.exp(a + b * xi);
        ga += (yi - mu) / phi;
        gb += ((yi - mu) * xi) / phi;
        haa -= mu / phi;
        hab -= (mu * xi) / phi;
        hbb -= (mu * xi * xi) / phi;
      });
      const det = haa * hbb - hab * hab;
      let da = -(hbb * ga - hab * gb) / det;
      let db = -(-hab * ga + haa * gb) / det;
      const before = logPost(a, b);
      while (logPost(a + da, b + db) < before - 1e-12 && Math.abs(da) + Math.abs(db) > 1e-12) {
        da /= 2;
        db /= 2;
      }
      a += da;
      b += db;
      if (Math.abs(da) + Math.abs(db) < 1e-10) break;
    }
    const det = haa * hbb - hab * hab;
    return { a, b, cov: { aa: -hbb / det, ab: hab / det, bb: -haa / det } };
  };

  const first = mode(1);
  const pearson = y.reduce((s, yi, i) => {
    const mu = Math.exp(first.a + first.b * (xc[i] as number));
    return s + (yi - mu) ** 2 / mu;
  }, 0);
  const phi = Math.max(1, pearson / (n - 2));
  const fit = phi > 1 ? mode(phi) : first;
  const spends = weeks.map((w) => w.spend);
  return {
    ...fit,
    phi,
    xMean,
    weeks: n,
    events,
    spendRange: [Math.min(...spends), Math.max(...spends)],
    learned: Math.max(0, 1 - fit.cov.bb / vb),
  };
}

/** Extracción de (a, b) del a posteriori normal (Cholesky 2 × 2). */
function sampleParams(fit: ResponseFit, rand: () => number) {
  const l11 = Math.sqrt(fit.cov.aa);
  const l21 = fit.cov.ab / l11;
  const l22 = Math.sqrt(Math.max(0, fit.cov.bb - l21 * l21));
  const z1 = normal(rand);
  const z2 = normal(rand);
  return { a: fit.a + l11 * z1, b: fit.b + l21 * z1 + l22 * z2 };
}

/** Eventos semanales esperados con un gasto semanal dado. */
const weeklyMean = (p: { a: number; b: number }, fit: ResponseFit, weeklySpend: number) =>
  weeklySpend > 0 ? Math.exp(p.a + p.b * (Math.log(weeklySpend) - fit.xMean)) : 0;

// --- 2. Validación de un paso

export interface Validation {
  evaluated: number;
  /** Fracción de semanas con PIT aleatorizado dentro de [0,1; 0,9] (nominal 80 %). */
  coverage: number | null;
  mae: number | null;
  /** MAE ÷ MAE del costo constante de las 4 semanas previas (< 1 lo supera). */
  relMae: number | null;
}

export function validateResponse(weeks: readonly Week[], seed = 1): Validation {
  const rand = mulberry32(seed);
  let evaluated = 0;
  let inside = 0;
  let abs = 0;
  let baseAbs = 0;
  let baseN = 0;
  for (let w = RESPONSE.minWeeks; w < weeks.length; w++) {
    const fit = fitResponse(weeks.slice(0, w));
    if (!fit) continue;
    const target = weeks[w] as Week;
    let below = 0;
    let equal = 0;
    let sum = 0;
    for (let i = 0; i < RESPONSE.validationDraws; i++) {
      const mu = weeklyMean(sampleParams(fit, rand), fit, target.spend);
      const yi = negBinomialSample(mu, fit.phi, rand);
      if (yi < target.events) below++;
      else if (yi === target.events) equal++;
      sum += mu;
    }
    // PIT aleatorizado (Czado, Gneiting y Held, 2009): uniforme si el modelo está bien calibrado.
    const pit = (below + rand() * equal) / RESPONSE.validationDraws;
    evaluated++;
    if (pit >= 0.1 && pit <= 0.9) inside++;
    abs += Math.abs(target.events - sum / RESPONSE.validationDraws);
    const prev = weeks.slice(w - 4, w);
    const ps = prev.reduce((s, p) => s + p.spend, 0);
    if (ps > 0) {
      baseAbs += Math.abs(
        target.events - (target.spend * prev.reduce((s, p) => s + p.events, 0)) / ps,
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

// --- 3. Monte Carlo de escenarios

export interface Plan {
  id: string;
  /** Agrupa los totales (mismo tipo de evento). */
  group: string;
  fit: ResponseFit;
  currentDaily: number;
  plannedDaily: number;
}

export interface PlanOutcome {
  id: string;
  spend: number;
  events: Quantiles;
  /** Costo por evento (null = sin cota: P(0 eventos) alta). */
  cost: { p10: number | null; p50: number | null; p90: number | null };
  probNoEvents: number;
  /** Cambio de los eventos esperados frente a mantener el gasto actual (incertidumbre de parámetros). */
  expectedChange: Quantiles;
  /** Gasto semanal planificado fuera del rango observado. */
  extrapolation: boolean;
  /** Cambio del gasto diario de más de ±30 %: escenario menos fiable. */
  largeChange: boolean;
}

export function simulatePlans(
  plans: readonly Plan[],
  horizonDays: number,
  opts: { draws?: number; seed?: number } = {},
) {
  const draws = opts.draws ?? RESPONSE.draws;
  const rand = mulberry32(opts.seed ?? 1);
  const k = horizonDays / 7;
  const totals = new Map<string, { events: Float64Array; change: Float64Array; spend: number }>();
  const outcomes: PlanOutcome[] = plans.map((plan) => {
    const { fit } = plan;
    const events = new Float64Array(draws);
    const change = new Float64Array(draws);
    for (let i = 0; i < draws; i++) {
      const p = sampleParams(fit, rand);
      const mu = k * weeklyMean(p, fit, 7 * plan.plannedDaily);
      events[i] = negBinomialSample(mu, fit.phi, rand);
      change[i] = mu - k * weeklyMean(p, fit, 7 * plan.currentDaily);
    }
    const spend = plan.plannedDaily * horizonDays;
    const t = totals.get(plan.group) ?? {
      events: new Float64Array(draws),
      change: new Float64Array(draws),
      spend: 0,
    };
    for (let i = 0; i < draws; i++) {
      (t.events as Float64Array)[i] = (t.events[i] as number) + (events[i] as number);
      (t.change as Float64Array)[i] = (t.change[i] as number) + (change[i] as number);
    }
    t.spend += spend;
    totals.set(plan.group, t);
    const weekly = 7 * plan.plannedDaily;
    return {
      id: plan.id,
      spend,
      ...summarize(events, spend),
      expectedChange: quantiles(change),
      extrapolation: weekly > 0 && (weekly < fit.spendRange[0] || weekly > fit.spendRange[1]),
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

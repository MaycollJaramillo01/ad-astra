import { robustZ } from '../audit/stats.ts';
import { addDays } from '../insights/catalog.ts';

// Pronóstico de series diarias "si nada cambia" (ARCHITECTURE §6.10, docs/FORECASTING.md).
// Funciones puras y deterministas: no leen el reloj ni la BD y no usan aleatoriedad.
//
//   1. Historia utilizable: desde el último cambio de atribución o la última pausa (≥ 7 días sin
//      gasto); los días de eventos externos marcados se excluyen y los atípicos aislados se acotan.
//   2. Modelos: ingenuo estacional (referencia obligatoria), perfil semanal y Holt-Winters
//      amortiguado (ETS(A,Ad,A)).
//   3. Backtest de origen móvil semanal con hueco de maduración: MAE, MASE y MAE relativo al
//      ingenuo estacional sobre los mismos puntos.
//   4. Intervalos empíricos (conformes en el tiempo): cuantiles de los errores fuera de muestra de
//      orígenes cuyo resultado ya se conocía; la cobertura se mide en orígenes posteriores.
//   5. Publicación solo si el modelo supera al baseline (CA-F6-01) y la cobertura del 80 % cae en
//      [70 %, 90 %] (CA-F6-02).

export const FORECAST_VERSION = 'forecast-1.0.0';

/** Ficha del pronóstico: se publica con cada resultado (CA-F6-03). */
export const FORECAST_CARD = {
  assumptions: [
    'Si nada cambia: presupuestos, segmentación, creatividades y entrega de Meta siguen como en la historia reciente.',
    'Estacionalidad solo semanal; la anual, los festivos y las fechas de pago no se modelan (harían falta 2 años o más de historia).',
    'Los días cuyas conversiones aún maduran no entran en el ajuste; el horizonte empieza mañana.',
    'Los días marcados como eventos externos no se ajustan ni se puntúan; los picos aislados se acotan.',
    'La historia empieza tras el último cambio de atribución o la última pausa de 7 días o más.',
  ],
  limitations: [
    'Estimación, no garantía: el intervalo del 80 % deja fuera, en el backtest, alrededor de 1 de cada 5 valores.',
    'Un evento futuro (promoción, festivo, cambio de presupuesto) no está dentro del intervalo.',
    'Los intervalos se calibran con errores pasados: tras un cambio de régimen dejan de valer hasta volver a calibrarse.',
    'Correlación, no causalidad: el pronóstico prolonga patrones, no explica por qué ocurren.',
    'Meta reexpresa los últimos 28 días: los datos recientes aún pueden cambiar un poco.',
  ],
};

export const CRITERIA = {
  /** Periodo de la estacionalidad (semanal). */
  period: 7,
  /** Días mínimos de entrenamiento en cada origen del backtest. */
  minTrain: 56,
  /** Un origen por semana; como mucho los 30 más recientes. */
  step: 7,
  maxOrigins: 30,
  /** Orígenes ya observados con los que se calibra cada intervalo. */
  minCalibration: 6,
  /** Orígenes con intervalo evaluado para medir la cobertura. */
  minEvaluated: 6,
  /** Días seguidos sin gasto que cuentan como pausa: la historia empieza después. */
  pauseDays: 7,
  /** Volumen mínimo de una serie de conteo: eventos por día en los últimos 56 días. */
  minDailyEvents: 0.5,
  /** Nivel de los intervalos y cobertura empírica aceptable. */
  level: 0.8,
  coverage: [0.7, 0.9] as const,
  /** Atípico aislado: |z robusta| ≥ 5 frente a los 28 días previos y vuelta a |z| < 3 en 2 días. */
  anomalyZ: 5,
};

const v = (a: readonly number[], i: number) => a[i] as number;
const finite = (x: number) => Number.isFinite(x);

function meanLast(y: readonly number[], k: number): number {
  let s = 0;
  let n = 0;
  for (let t = Math.max(0, y.length - k); t < y.length; t++) {
    if (finite(v(y, t))) {
      s += v(y, t);
      n++;
    }
  }
  return n ? s / n : 0;
}

/** Cuantil con interpolación lineal (tipo 7) de una lista ordenada. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return v(sorted, lo) + (h - lo) * (v(sorted, hi) - v(sorted, lo));
}
const sortNum = (a: number[]) => a.sort((x, y) => x - y);

// --- 1. Historia utilizable

export interface DailyRow {
  date: string;
  attribution: string | null;
  values: Record<string, number>;
}
export interface ExcludedRange {
  since: string;
  until: string;
  label: string;
}
export type BreakReason = 'attribution' | 'pause';

export interface History {
  /** Primer día utilizable (null si no hay datos). */
  start: string | null;
  until: string;
  dates: string[];
  /** Cambios de régimen detectados; la historia empieza en el último. */
  breaks: Array<{ date: string; reason: BreakReason }>;
  /** Días de eventos externos dentro de la historia (no se ajustan ni se puntúan). */
  excluded: boolean[];
  /** La entidad lleva ≥ 7 días sin gasto al final: está en pausa. */
  pausedAtEnd: boolean;
  /** Valor diario de un campo (0 en los días sin fila: sin entrega). */
  field: (name: string) => number[];
}

/**
 * Historia utilizable hasta `until`. Un día sin fila es un día sin entrega (0). La serie arranca
 * en el primer día con datos o, si después hubo un cambio de atribución o una pausa, tras el último.
 */
export function prepareHistory(
  rows: readonly DailyRow[],
  until: string,
  exclude: readonly ExcludedRange[] = [],
): History {
  const used = rows.filter((r) => r.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  const empty: History = {
    start: null,
    until,
    dates: [],
    breaks: [],
    excluded: [],
    pausedAtEnd: false,
    field: () => [],
  };
  const first = used[0];
  if (!first) return empty;
  const byDate = new Map(used.map((r) => [r.date, r]));
  const all: string[] = [];
  for (let d = first.date; d <= until; d = addDays(d, 1)) all.push(d);
  const spend = all.map((d) => byDate.get(d)?.values.spend ?? 0);

  const breaks: History['breaks'] = [];
  let cut = 0;
  let setting: string | null = null;
  all.forEach((d, i) => {
    const a = byDate.get(d)?.attribution ?? null;
    if (a && setting && a !== setting) {
      breaks.push({ date: d, reason: 'attribution' });
      cut = Math.max(cut, i);
    }
    if (a) setting = a;
  });
  let pausedAtEnd = false;
  for (let i = 0; i < spend.length; ) {
    if (v(spend, i) > 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < spend.length && v(spend, j) <= 0) j++;
    if (j - i >= CRITERIA.pauseDays) {
      if (j < spend.length) {
        breaks.push({ date: all[j] as string, reason: 'pause' });
        cut = Math.max(cut, j);
      } else pausedAtEnd = true;
    }
    i = j;
  }
  breaks.sort((a, b) => a.date.localeCompare(b.date));

  const dates = all.slice(cut);
  const excluded = dates.map((d) => exclude.some((r) => d >= r.since && d <= r.until));
  return {
    start: dates[0] ?? null,
    until,
    dates,
    breaks,
    excluded,
    pausedAtEnd,
    field: (name) => dates.map((d) => byDate.get(d)?.values[name] ?? 0),
  };
}

export interface Series {
  /** Para ajustar: excluidos = NaN y atípicos aislados acotados. */
  train: number[];
  /** Para puntuar: excluidos = NaN. */
  actual: number[];
  /** Índices de los atípicos acotados. */
  anomalies: number[];
}

/**
 * Serie de un campo. Los atípicos aislados (un pico que no se sostiene) se acotan a mediana ±
 * 5 MAD normalizadas para que no arrastren el nivel; un cambio sostenido no es aislado y se deja.
 */
export function seriesOf(h: History, field: string): Series {
  const actual = h.field(field).map((x, i) => (h.excluded[i] ? Number.NaN : x));
  const train = [...actual];
  const anomalies: number[] = [];
  for (let i = 28; i < train.length; i++) {
    const window = train.slice(i - 28, i).filter(finite);
    if (window.length < 14 || !finite(v(train, i))) continue;
    const z = robustZ(v(train, i), window);
    if (!z || Math.abs(z.z) < CRITERIA.anomalyZ) continue;
    // Aislado si los dos días siguientes con dato vuelven a lo normal; sin ellos no se confirma.
    const next = train
      .slice(i + 1, i + 8)
      .filter(finite)
      .slice(0, 2);
    const calm = next.length === 2 && next.every((x) => Math.abs(robustZ(x, window)?.z ?? 0) < 3);
    if (!calm) continue;
    train[i] = z.median + (Math.sign(z.z) * CRITERIA.anomalyZ * z.mad) / 0.6745;
    anomalies.push(i);
  }
  return { train, actual, anomalies };
}

// --- 2. Modelos. Cada uno recibe el entrenamiento (NaN = sin dato) y devuelve `steps` días.

export type ModelId = 'snaive' | 'weekday' | 'ets';
export const MODELS: Record<ModelId, { label: string; method: string }> = {
  snaive: {
    label: 'Ingenuo estacional',
    method: 'Repite la última semana observada: ŷ(T+h) = y(T+h−7·⌈h/7⌉). Referencia obligatoria.',
  },
  weekday: {
    label: 'Perfil semanal',
    method:
      'Media de los últimos 28 días × factor del día de la semana (media del día ÷ media general, últimos 56 días).',
  },
  ets: {
    label: 'Holt-Winters amortiguado',
    method:
      'ETS(A,Ad,A): nivel, tendencia amortiguada y estacionalidad semanal aditivas, en forma de corrección de errores; parámetros por mínimos cuadrados de un paso sobre una rejilla.',
  },
};

export function seasonalNaive(train: readonly number[], steps: number): number[] {
  const T = train.length;
  const fallback = meanLast(train, 28);
  return Array.from({ length: steps }, (_, i) => {
    for (let t = T + i - 7 * Math.ceil((i + 1) / 7); t >= 0; t -= 7)
      if (finite(v(train, t))) return v(train, t);
    return fallback;
  });
}

export function weekdayProfile(train: readonly number[], steps: number): number[] {
  const T = train.length;
  const level = meanLast(train, 28);
  const sums = [0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  let n = 0;
  for (let t = Math.max(0, T - 56); t < T; t++) {
    if (!finite(v(train, t))) continue;
    sums[t % 7] = v(sums, t % 7) + v(train, t);
    counts[t % 7] = v(counts, t % 7) + 1;
    total += v(train, t);
    n++;
  }
  const mean = n ? total / n : 0;
  const factor = (p: number) => (v(counts, p) && mean > 0 ? v(sums, p) / v(counts, p) / mean : 1);
  return Array.from({ length: steps }, (_, i) => level * factor((T + i) % 7));
}

export interface EtsParams {
  alpha: number;
  beta: number;
  gamma: number;
  phi: number;
}
interface EtsState {
  level: number;
  trend: number;
  season: number[];
  /** Índice del siguiente día. */
  t: number;
}

/** Rejilla: 0 < β ≤ α·0,2, γ < 1 − α (Hyndman y Athanasopoulos, FPP3 §8.3). */
const ETS_GRID: EtsParams[] = (() => {
  const out: EtsParams[] = [];
  for (const alpha of [0.03, 0.07, 0.15, 0.3, 0.5])
    for (const bStar of [0, 0.05, 0.2])
      for (const gamma of [0.02, 0.07, 0.15, 0.3])
        for (const phi of bStar === 0 ? [0.9] : [0.85, 0.92, 0.98])
          if (gamma < 1 - alpha) out.push({ alpha, beta: alpha * bStar, gamma, phi });
  return out;
})();

/** Estado inicial con las dos primeras semanas: nivel, pendiente entre semanas y estacionalidad. */
function etsInit(y: readonly number[]): EtsState | null {
  if (y.length < 21) return null;
  const head = y.slice(0, 14);
  const known = head.filter(finite);
  if (known.length < 7) return null;
  const fill = known.reduce((a, b) => a + b, 0) / known.length;
  const w = head.map((x) => (finite(x) ? x : fill));
  const m1 = w.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
  const m2 = w.slice(7).reduce((a, b) => a + b, 0) / 7;
  const trend = (m2 - m1) / 7;
  // Desviación de cada día respecto a la media de su semana, sin la parte de la pendiente.
  const season = Array.from(
    { length: 7 },
    (_, p) => (v(w, p) - m1 + v(w, p + 7) - m2) / 2 - (p - 3) * trend,
  );
  const sm = season.reduce((a, b) => a + b, 0) / 7;
  return { level: m2 + 3 * trend, trend, season: season.map((s) => s - sm), t: 14 };
}

function etsRun(y: readonly number[], p: EtsParams, s0: EtsState) {
  let { level, trend } = s0;
  const season = [...s0.season];
  let sse = 0;
  for (let t = s0.t; t < y.length; t++) {
    const seas = v(season, t % 7);
    const pred = level + p.phi * trend + seas;
    const e = finite(v(y, t)) ? v(y, t) - pred : 0;
    if (t >= 21) sse += e * e;
    level = level + p.phi * trend + p.alpha * e;
    trend = p.phi * trend + p.beta * e;
    season[t % 7] = seas + p.gamma * e;
  }
  return { sse, state: { level, trend, season, t: y.length } };
}

/** Ajuste de ETS(A,Ad,A): parámetros con el menor error cuadrático de un paso. */
export function fitEts(train: readonly number[]): { params: EtsParams; state: EtsState } | null {
  const init = etsInit(train);
  if (!init) return null;
  let best: { sse: number; params: EtsParams; state: EtsState } | null = null;
  for (const params of ETS_GRID) {
    const r = etsRun(train, params, init);
    if (!best || r.sse < best.sse) best = { sse: r.sse, params, state: r.state };
  }
  return best && { params: best.params, state: best.state };
}

export function etsForecast(train: readonly number[], steps: number): number[] {
  const fit = fitEts(train);
  if (!fit) return weekdayProfile(train, steps);
  const { params: p, state } = fit;
  let damp = 0;
  let pow = 1;
  return Array.from({ length: steps }, (_, i) => {
    pow *= p.phi;
    damp += pow;
    return Math.max(0, state.level + damp * state.trend + v(state.season, (state.t + i) % 7));
  });
}

const FORECASTERS: Record<ModelId, (train: readonly number[], steps: number) => number[]> = {
  snaive: seasonalNaive,
  weekday: weekdayProfile,
  ets: etsForecast,
};

// --- 3. Backtest de origen móvil

export interface Horizon {
  /** Días pronosticados que cuentan (el horizonte de planificación). */
  horizon: number;
  /** Días entre el corte y el horizonte (conversiones aún por madurar). */
  gap: number;
}

/** Días de historia que exige un horizonte: entrenamiento + orígenes para calibrar y evaluar. */
export function requiredDays({ horizon, gap }: Horizon): number {
  const lag = Math.ceil((gap + horizon) / CRITERIA.step);
  const origins = CRITERIA.minCalibration + lag + CRITERIA.minEvaluated;
  return CRITERIA.minTrain + gap + horizon + CRITERIA.step * (origins - 1);
}

/** Orígenes (tamaño del entrenamiento) en orden cronológico, uno por semana desde el final. */
export function originsFor(n: number, { horizon, gap }: Horizon): number[] {
  const out: number[] = [];
  for (
    let T = n - gap - horizon;
    T >= CRITERIA.minTrain && out.length < CRITERIA.maxOrigins;
    T -= 7
  )
    out.push(T);
  return out.reverse();
}

export interface OriginRun {
  T: number;
  pred: number[];
  actual: number[];
  /** Nivel de los últimos 28 días del entrenamiento: normaliza los errores. */
  norm: number;
  /** Denominador del MASE: error medio del ingenuo estacional de un paso en el entrenamiento. */
  scale: number;
}

function runOrigins(s: Series, origins: number[], model: ModelId, h: Horizon): OriginRun[] {
  return origins.map((T) => {
    const train = s.train.slice(0, T);
    const pred = FORECASTERS[model](train, h.gap + h.horizon).slice(h.gap);
    const actual = s.actual.slice(T + h.gap, T + h.gap + h.horizon);
    let sum = 0;
    let n = 0;
    for (let t = 7; t < T; t++) {
      if (finite(v(train, t)) && finite(v(train, t - 7))) {
        sum += Math.abs(v(train, t) - v(train, t - 7));
        n++;
      }
    }
    return { T, pred, actual, norm: Math.max(meanLast(train, 28), 1e-9), scale: n ? sum / n : 0 };
  });
}

export interface ModelScore {
  model: ModelId;
  /** Error absoluto medio diario fuera de muestra. */
  mae: number;
  /** MASE (Hyndman y Koehler, 2006): MAE ÷ error del ingenuo estacional de un paso, por origen. */
  mase: number | null;
  /** MAE ÷ MAE del ingenuo estacional en los mismos puntos: < 1 lo supera (CA-F6-01). */
  relMae: number | null;
  /** Error del total del horizonte: Σ|ΣA − ΣP| ÷ ΣΣA. */
  wapeTotal: number | null;
  /** Sesgo del total: Σ(ΣP − ΣA) ÷ ΣΣA. */
  biasTotal: number | null;
}

function score(model: ModelId, runs: OriginRun[], reference: OriginRun[] | null): ModelScore {
  let abs = 0;
  let n = 0;
  let refAbs = 0;
  let totalAbs = 0;
  let totalBias = 0;
  let totalActual = 0;
  const scaled: number[] = [];
  runs.forEach((r, k) => {
    let a = 0;
    let m = 0;
    let sumA = 0;
    let sumP = 0;
    r.actual.forEach((act, i) => {
      if (!finite(act)) return;
      a += Math.abs(act - v(r.pred, i));
      if (reference) refAbs += Math.abs(act - v((reference[k] as OriginRun).pred, i));
      sumA += act;
      sumP += v(r.pred, i);
      m++;
    });
    abs += a;
    n += m;
    totalAbs += Math.abs(sumA - sumP);
    totalBias += sumP - sumA;
    totalActual += sumA;
    if (m && r.scale > 0) scaled.push(a / m / r.scale);
  });
  const mae = n ? abs / n : Number.NaN;
  return {
    model,
    mae,
    mase: scaled.length ? scaled.reduce((x, y) => x + y, 0) / scaled.length : null,
    relMae: reference ? (refAbs > 0 ? abs / refAbs : abs === 0 ? 1 : null) : 1,
    wapeTotal: totalActual > 0 ? totalAbs / totalActual : null,
    biasTotal: totalActual > 0 ? totalBias / totalActual : null,
  };
}

// --- 4. Intervalos y calibración

export interface Calibration {
  /** Orígenes con intervalo evaluado (calibrado solo con orígenes anteriores ya observados). */
  evaluated: number;
  dailyCoverage: number | null;
  totalCoverage: number | null;
  /** Cuantiles de los errores normalizados de todos los orígenes, por semana del horizonte. */
  daily: Array<[number, number]>;
  total: [number, number] | null;
}

/**
 * Intervalo empírico de errores ordenados con la corrección de muestra finita de la predicción
 * conforme: con m errores, el cuantil superior sube a (1 + nivel)/2 · (m + 1)/m (Vovk et al., 2005;
 * Lei et al., 2018). Sin ella, pocos orígenes dan intervalos que cubren menos de lo nominal.
 */
export function errorInterval(sorted: readonly number[]): [number, number] {
  const m = sorted.length;
  const hi = Math.min(1, (((1 + CRITERIA.level) / 2) * (m + 1)) / m);
  return [quantile(sorted, 1 - hi), quantile(sorted, hi)];
}
const bucketOf = (i: number) => Math.floor(i / 7);

/**
 * ¿Cobertura compatible con el 80 % nominal cuando solo hay n evaluaciones? Se acepta
 * [70 %, 90 %] ampliado en un error típico binomial √(0,8 · 0,2 / n): con n = 18, un modelo
 * perfectamente calibrado caería fuera de [70 %, 90 %] un 23 % de las veces por puro azar; así,
 * un 3 %. Con cientos de puntos (la cobertura diaria) el rango es prácticamente el literal.
 */
export function coverageOk(coverage: number, n: number): boolean {
  const se = Math.sqrt((CRITERIA.level * (1 - CRITERIA.level)) / Math.max(1, n));
  return coverage >= CRITERIA.coverage[0] - se && coverage <= CRITERIA.coverage[1] + se;
}

function dailyErrors(runs: OriginRun[], buckets: number): number[][] {
  const out = Array.from({ length: buckets }, () => [] as number[]);
  for (const r of runs)
    r.actual.forEach((a, i) => {
      if (finite(a)) out[bucketOf(i)]?.push((a - v(r.pred, i)) / r.norm);
    });
  return out.map(sortNum);
}
function totalErrors(runs: OriginRun[]): number[] {
  const out: number[] = [];
  for (const r of runs) {
    let d = 0;
    let m = 0;
    r.actual.forEach((a, i) => {
      if (!finite(a)) return;
      d += a - v(r.pred, i);
      m++;
    });
    if (m) out.push(d / (r.norm * m));
  }
  return sortNum(out);
}

/** Orígenes anteriores cuyo horizonte ya se había observado en el origen k (sin fuga de futuro). */
const observedBefore = (runs: OriginRun[], k: number, h: Horizon) =>
  runs.filter((r) => r.T + h.gap + h.horizon <= (runs[k] as OriginRun).T);

export function calibrate(runs: OriginRun[], h: Horizon): Calibration {
  const buckets = Math.ceil(h.horizon / 7);
  let evaluated = 0;
  let inDaily = 0;
  let nDaily = 0;
  let inTotal = 0;
  runs.forEach((r, k) => {
    const past = observedBefore(runs, k, h);
    if (past.length < CRITERIA.minCalibration) return;
    evaluated++;
    const du = dailyErrors(past, buckets).map(errorInterval);
    let sumA = 0;
    let sumP = 0;
    let m = 0;
    r.actual.forEach((a, i) => {
      if (!finite(a)) return;
      const [lo, hi] = du[bucketOf(i)] as [number, number];
      const p = v(r.pred, i);
      if (a >= Math.max(0, p + lo * r.norm) && a <= p + hi * r.norm) inDaily++;
      nDaily++;
      sumA += a;
      sumP += p;
      m++;
    });
    const [lo, hi] = errorInterval(totalErrors(past));
    if (m && sumA >= Math.max(0, sumP + lo * r.norm * m) && sumA <= sumP + hi * r.norm * m)
      inTotal++;
  });
  const tu = totalErrors(runs);
  return {
    evaluated,
    dailyCoverage: nDaily ? inDaily / nDaily : null,
    totalCoverage: evaluated ? inTotal / evaluated : null,
    daily: dailyErrors(runs, buckets).map(errorInterval),
    total: tu.length ? errorInterval(tu) : null,
  };
}

// --- 5. Pronóstico de una serie con su ficha

export type ForecastStatus = 'published' | 'not_published' | 'insufficient_data' | 'paused';

export interface SeriesForecast {
  status: ForecastStatus;
  reasons: string[];
  usableDays: number;
  requiredDays: number;
  recentDailyMean: number;
  anomalies: number[];
  backtest: {
    origins: number;
    scores: ModelScore[];
    chosen: ModelId | null;
    calibration: Calibration | null;
  } | null;
  /** Días futuros (tras el hueco): central y su intervalo del 80 %. */
  points: Array<{ point: number; lower: number; upper: number }> | null;
  total: { point: number; lower: number; upper: number } | null;
  /** Ejecuciones del modelo elegido por origen (para los costos derivados). */
  runs: OriginRun[] | null;
  /** Pronóstico central del modelo elegido para los días futuros (también sin publicar). */
  final: number[] | null;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function forecastSeries(
  history: History,
  s: Series,
  h: Horizon,
  opts: { count: boolean },
): SeriesForecast {
  const n = s.train.length;
  const required = requiredDays(h);
  const recentDailyMean = meanLast(s.actual, 56);
  const base: SeriesForecast = {
    status: 'insufficient_data',
    reasons: [],
    usableDays: n,
    requiredDays: required,
    recentDailyMean,
    anomalies: s.anomalies,
    backtest: null,
    points: null,
    total: null,
    runs: null,
    final: null,
  };
  if (history.pausedAtEnd)
    return {
      ...base,
      status: 'paused',
      reasons: [
        `Sin gasto en los últimos ${CRITERIA.pauseDays} días o más: en pausa. Si nada cambia, el pronóstico es 0.`,
      ],
    };
  if (n < required)
    return {
      ...base,
      reasons: [
        `Hay ${n} días utilizables${history.start ? ` desde ${history.start}` : ''}; este horizonte exige ${required} (${CRITERIA.minTrain} de entrenamiento y orígenes semanales suficientes para validar y calibrar). Faltan ${required - n}.`,
      ],
    };
  if (opts.count && recentDailyMean < CRITERIA.minDailyEvents)
    return {
      ...base,
      reasons: [
        `Volumen bajo: ${recentDailyMean.toFixed(2)} eventos al día en los últimos 56 días (mínimo ${CRITERIA.minDailyEvents}). Una serie diaria tan escasa no se pronostica.`,
      ],
    };

  const origins = originsFor(n, h);
  const runs = {
    snaive: runOrigins(s, origins, 'snaive', h),
    weekday: runOrigins(s, origins, 'weekday', h),
    ets: runOrigins(s, origins, 'ets', h),
  };
  const scores = (['snaive', 'weekday', 'ets'] as const).map((m) =>
    score(m, runs[m], m === 'snaive' ? null : runs.snaive),
  );
  // ponytail: se elige el candidato con menor MAE relativo en el mismo backtest con el que se
  // publica (sesgo de selección leve con 2 candidatos). Con más candidatos, separar orígenes.
  const candidates = scores.filter((x) => x.model !== 'snaive' && x.relMae !== null);
  const best = candidates.sort((a, b) => (a.relMae as number) - (b.relMae as number))[0];
  const chosen = best?.model ?? null;
  const calibration = chosen ? calibrate(runs[chosen], h) : null;
  const final = chosen ? FORECASTERS[chosen](s.train, h.gap + h.horizon).slice(h.gap) : null;
  const backtest = { origins: origins.length, scores, chosen, calibration };
  const withBacktest = { ...base, backtest, runs: chosen ? runs[chosen] : null, final };

  if (!best || (best.relMae as number) >= 1)
    return {
      ...withBacktest,
      status: 'not_published',
      reasons: [
        `Ningún modelo supera al ingenuo estacional en el backtest (mejor MAE relativo: ${best?.relMae?.toFixed(2) ?? 'n/d'}; hace falta < 1).`,
      ],
    };
  if (!calibration || calibration.evaluated < CRITERIA.minEvaluated)
    return {
      ...withBacktest,
      reasons: [
        `Solo ${calibration?.evaluated ?? 0} orígenes con intervalo evaluable (mínimo ${CRITERIA.minEvaluated}).`,
      ],
    };
  const cov = calibration.dailyCoverage ?? 0;
  if (cov < CRITERIA.coverage[0] || cov > CRITERIA.coverage[1])
    return {
      ...withBacktest,
      status: 'not_published',
      reasons: [
        `Intervalos sin calibrar: la cobertura empírica del intervalo del 80 % fue ${pct(cov)} (aceptable entre ${pct(CRITERIA.coverage[0])} y ${pct(CRITERIA.coverage[1])}).`,
      ],
    };

  const norm = Math.max(meanLast(s.train, 28), 1e-9);
  const points = (final as number[]).map((p, i) => {
    const [lo, hi] = calibration.daily[bucketOf(i)] as [number, number];
    return { point: p, lower: Math.max(0, p + lo * norm), upper: Math.max(0, p + hi * norm) };
  });
  const sum = (final as number[]).reduce((a, b) => a + b, 0);
  const [tlo, thi] = calibration.total ?? [0, 0];
  return {
    ...withBacktest,
    status: 'published',
    points,
    total: {
      point: sum,
      lower: Math.max(0, sum + tlo * norm * h.horizon),
      upper: Math.max(0, sum + thi * norm * h.horizon),
    },
  };
}

// --- Costos derivados (cociente de dos series pronosticadas): intervalo del log-cociente

export interface RatioForecast {
  status: ForecastStatus;
  reasons: string[];
  evaluated: number;
  coverage: number | null;
  total: { point: number; lower: number; upper: number } | null;
}

export function forecastRatio(
  num: SeriesForecast,
  den: SeriesForecast,
  h: Horizon,
  scale = 1,
): RatioForecast {
  const none = (status: ForecastStatus, reason: string): RatioForecast => ({
    status,
    reasons: [reason],
    evaluated: 0,
    coverage: null,
    total: null,
  });
  if (num.status !== 'published' || den.status !== 'published' || !num.runs || !den.runs)
    return none(
      num.status === 'paused' ? 'paused' : 'insufficient_data',
      'Necesita publicados el pronóstico del gasto y el del evento.',
    );
  const nr = num.runs;
  const dr = den.runs;
  const logErr = (k: number) => {
    const a = nr[k] as OriginRun;
    const b = dr[k] as OriginRun;
    let sa = 0;
    let sp = 0;
    let da = 0;
    let dp = 0;
    a.actual.forEach((x, i) => {
      const y = v(b.actual, i);
      if (!finite(x) || !finite(y)) return;
      sa += x;
      sp += v(a.pred, i);
      da += y;
      dp += v(b.pred, i);
    });
    return sa > 0 && sp > 0 && da > 0 && dp > 0 ? Math.log(sa / da / (sp / dp)) : null;
  };
  const errs = nr.map((_, k) => logErr(k));
  let evaluated = 0;
  let inside = 0;
  nr.forEach((r, k) => {
    const e = errs[k];
    if (e === null || e === undefined) return;
    const past = sortNum(
      nr
        .map((x, j) => ({ x, e: errs[j] }))
        .filter((p) => p.x.T + h.gap + h.horizon <= r.T && p.e !== null && p.e !== undefined)
        .map((p) => p.e as number),
    );
    if (past.length < CRITERIA.minCalibration) return;
    evaluated++;
    const [lo, hi] = errorInterval(past);
    if (e >= lo && e <= hi) inside++;
  });
  const [lo, hi] = errorInterval(
    sortNum(errs.filter((e): e is number => e !== null && e !== undefined)),
  );
  const coverage = evaluated ? inside / evaluated : null;
  const base = { evaluated, coverage };
  if (evaluated < CRITERIA.minEvaluated || coverage === null)
    return { ...none('insufficient_data', 'Pocos orígenes para calibrar el costo.'), ...base };
  if (!coverageOk(coverage, evaluated))
    return {
      ...none(
        'not_published',
        `Intervalo del costo sin calibrar: cobertura ${pct(coverage)} en ${evaluated} orígenes (aceptable entre ${pct(CRITERIA.coverage[0])} y ${pct(CRITERIA.coverage[1])}, más un error típico por el tamaño de la muestra).`,
      ),
      ...base,
    };
  const point = ((num.total?.point ?? 0) / (den.total?.point ?? 1)) * scale;
  return {
    status: 'published',
    reasons: [],
    ...base,
    total: { point, lower: point * Math.exp(lo), upper: point * Math.exp(hi) },
  };
}

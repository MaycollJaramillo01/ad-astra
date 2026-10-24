import { type EntityContext, eventsOf, type ReferenceSource } from './context.ts';
import {
  type AuditConfig,
  type AuditLevel,
  HEALTH_FORMULA_VERSION,
  type Profile,
  SUBINDEX_IDS,
  type Subindex,
} from './model.ts';
import { RULES_BY_ID, ruleParams } from './rules.ts';
import { costPosterior, gammaQuantile, ratePosterior } from './stats.ts';

/** Piso del CV de referencia: el parámetro `floor` de R-STAB-006 (configurable). */
const stabilityFloor = (config: AuditConfig) => {
  const rule = RULES_BY_ID.get('R-STAB-006');
  return rule ? Number(ruleParams(rule, config.rules['R-STAB-006']?.params).floor) : 0;
};

// Índice de salud health-v1 (ARCHITECTURE §6.6): de 0 a 100 por entidad, explicable componente a
// componente. Un componente sin muestra suficiente queda "insuficiente" y se excluye (nunca
// puntúa 0); con poca cobertura de pesos la puntuación es null ("Datos insuficientes").

export type ComponentStatus = 'ok' | 'insufficient' | 'not_applicable';
export interface Component {
  id: Subindex;
  status: ComponentStatus;
  /** Valor medido (costo estimado, CV, ritmo de gasto…). */
  value: number | null;
  reference: number | null;
  referenceSource: ReferenceSource | 'budget' | 'parameter' | null;
  /** Razón normalizada: > 1 es mejor que la referencia. */
  q: number | null;
  /** Puntuación 0–100 del componente. */
  s: number | null;
  weight: number;
  /** 0,9 alta · 0,6 media · 0,3 baja. */
  confidence: number | null;
  /** Tamaño de la muestra (eventos, días, impresiones o clics). */
  n: number;
  note: string;
}

export type Grade = 'excellent' | 'good' | 'attention' | 'critical' | 'insufficient';
export interface HealthScore {
  level: AuditLevel;
  entityId: string;
  profile: Profile;
  formulaVersion: string;
  windowDays: number;
  score: number | null;
  grade: Grade;
  coverage: number;
  confidence: number | null;
  components: Component[];
}

const HIGH = 0.9;
const MEDIUM = 0.6;
const LOW = 0.3;
/** Confianza según la anchura relativa del intervalo del 80 %: < 30 % alta, 30–60 % media, > 60 % baja. */
export const widthConfidence = (lo: number, hi: number, estimate: number) => {
  const rel = estimate > 0 ? (hi - lo) / estimate : Number.POSITIVE_INFINITY;
  return rel < 0.3 ? HIGH : rel < 0.6 ? MEDIUM : LOW;
};

/** s = clamp(centro + pendiente · log2(q), 0, 100): en la referencia → centro; el doble de bueno → centro + pendiente. */
export const normalize = (q: number, h: AuditConfig['health']) =>
  Math.min(100, Math.max(0, h.center + h.slope * Math.log2(Math.max(q, 1e-9))));

export const gradeOf = (score: number | null): Grade =>
  score === null
    ? 'insufficient'
    : score >= 85
      ? 'excellent'
      : score >= 70
        ? 'good'
        : score >= 50
          ? 'attention'
          : 'critical';

/**
 * Agregación: H = Σ w·s / Σ w (solo evaluables); cobertura = Σ w evaluables / Σ w con peso;
 * confianza = cobertura × media ponderada de las confianzas. Pública para poder recalcular una
 * puntuación desde los componentes guardados (CA-F3-03).
 */
export function combine(components: Component[], minCoverage: number) {
  const weighted = components.filter((c) => c.weight > 0 && c.status !== 'not_applicable');
  const total = weighted.reduce((a, c) => a + c.weight, 0);
  const ok = weighted.filter((c) => c.status === 'ok' && c.s !== null);
  const okWeight = ok.reduce((a, c) => a + c.weight, 0);
  const coverage = total > 0 ? okWeight / total : 0;
  if (okWeight === 0 || coverage < minCoverage)
    return { score: null, coverage, confidence: null, grade: gradeOf(null) };
  const score = ok.reduce((a, c) => a + c.weight * (c.s as number), 0) / okWeight;
  const confidence =
    coverage * (ok.reduce((a, c) => a + c.weight * (c.confidence ?? 0), 0) / okWeight);
  const rounded = Math.round(score * 100) / 100;
  return { score: rounded, coverage, confidence, grade: gradeOf(rounded) };
}

const none = (id: Subindex, weight: number, status: ComponentStatus, note: string): Component => ({
  id,
  status,
  value: null,
  reference: null,
  referenceSource: null,
  q: null,
  s: null,
  weight,
  confidence: null,
  n: 0,
  note,
});

/** Contracción a priori de los componentes (eventos o ensayos "virtuales" a la referencia). */
const PRIOR = { cost: 5, cvr: 200, ctr: 2000 };

function efficiency(c: EntityContext, h: AuditConfig['health'], weight: number): Component {
  const s = c.mature;
  if (c.profile === 'sales' && c.roasRef && s.spend > 0) {
    const aovFrom = s.purchases >= 3 ? s : c.base.purchases >= 3 ? c.base : null;
    if (aovFrom && aovFrom.purchaseValue > 0) {
      const aov = aovFrom.purchaseValue / aovFrom.purchases;
      const alpha = PRIOR.cost + s.purchases;
      const beta = (PRIOR.cost * aov) / c.roasRef.value + s.spend;
      if ((s.spend * c.roasRef.value) / aov >= 1) {
        const roas = (aov * alpha) / beta;
        const lo = aov * gammaQuantile(0.1, alpha, beta);
        const hi = aov * gammaQuantile(0.9, alpha, beta);
        const q = roas / c.roasRef.value;
        return {
          id: 'efficiency',
          status: 'ok',
          value: roas,
          reference: c.roasRef.value,
          referenceSource: c.roasRef.source,
          q,
          s: normalize(q, h),
          weight,
          confidence: widthConfidence(lo, hi, roas),
          n: s.purchases,
          note: 'ROAS estimado frente a la referencia',
        };
      }
    }
  }
  if (!c.costRef) return none('efficiency', weight, 'insufficient', 'sin referencia de costo');
  const events = eventsOf(s, c.kpi);
  const expected = s.spend / c.costRef.value;
  if (expected < (c.kpi.field === 'impressions' ? 1000 : 1))
    return none('efficiency', weight, 'insufficient', 'gasto insuficiente para estimar el costo');
  const post = costPosterior(s.spend, events, c.costRef.value, PRIOR.cost);
  const [lo, hi] = post.interval(0.8);
  const q = c.costRef.value / post.estimate;
  return {
    id: 'efficiency',
    status: 'ok',
    value: post.estimate * c.kpi.scale,
    reference: c.costRef.value * c.kpi.scale,
    referenceSource: c.costRef.source,
    q,
    s: normalize(q, h),
    weight,
    confidence: widthConfidence(lo, hi, post.estimate),
    n: events,
    note: `${c.kpi.costLabel} estimado (contracción Gamma-Poisson) frente a la referencia`,
  };
}

function stability(
  c: EntityContext,
  h: AuditConfig['health'],
  weight: number,
  floor: number,
): Component {
  if (!c.cv || c.cv.days < 7)
    return none('stability', weight, 'insufficient', 'menos de 7 días con eventos');
  if (c.cvBenchmark === null)
    return none('stability', weight, 'insufficient', 'sin entidades comparables en la cuenta');
  // La referencia es la mediana de la cuenta con el mismo piso que R-STAB-006: si la cuenta es muy
  // estable (CV casi 0 tras quitar el ruido de Poisson), una variación pequeña no hunde la nota.
  const reference = Math.max(c.cvBenchmark, floor);
  // Un CV de 0 (costo idéntico cada día) es lo mejor posible: q se acota para dar 100.
  const q = c.cv.value === 0 ? 2 ** ((100 - h.center) / h.slope) : reference / c.cv.value;
  return {
    id: 'stability',
    status: 'ok',
    value: c.cv.value,
    reference,
    referenceSource: reference === c.cvBenchmark ? 'account_median' : 'parameter',
    q,
    s: normalize(q, h),
    weight,
    confidence: c.cv.days >= 12 ? HIGH : c.cv.days >= 9 ? MEDIUM : LOW,
    n: c.cv.days,
    note: 'variación del costo diario frente a la mediana de la cuenta (menor es mejor)',
  };
}

function delivery(c: EntityContext, windowDays: number, weight: number): Component {
  const e = c.entity;
  if (!e) return none('delivery', weight, 'not_applicable', 'no aplica a la cuenta');
  if (!c.active) return none('delivery', weight, 'not_applicable', 'no está activa');
  const budget =
    e.dailyBudget ?? (e.level === 'campaign' ? null : (c.campaign?.dailyBudget ?? null));
  // Con presupuesto propio: ritmo de gasto (lineal: 100 = gasta el presupuesto). Sin él: días con entrega.
  const ownBudget = e.dailyBudget;
  const ratio = ownBudget ? c.cur.spend / (ownBudget * windowDays) : c.cur.activeDays / windowDays;
  let score = 100 * Math.min(1, ratio);
  const notes = [
    ownBudget ? 'ritmo de gasto frente al presupuesto' : 'días con entrega en la ventana',
  ];
  if (e.learning === 'FAIL') {
    score *= 0.7;
    notes.push('aprendizaje limitado (×0,7)');
  }
  if (
    e.hasIssues ||
    ['DISAPPROVED', 'WITH_ISSUES', 'PENDING_BILLING_INFO'].includes(e.status ?? '')
  ) {
    score *= 0.5;
    notes.push('problemas de entrega (×0,5)');
  }
  return {
    id: 'delivery',
    status: 'ok',
    value: ratio,
    reference: ownBudget ? ownBudget * windowDays : windowDays,
    referenceSource: ownBudget ? 'budget' : 'parameter',
    q: Math.min(1, ratio),
    s: score,
    weight,
    confidence: HIGH,
    n: ownBudget ? Math.round(c.cur.spend) : c.cur.activeDays,
    note: `${notes.join('; ')}${budget && !ownBudget ? ' (presupuesto en la campaña)' : ''}`,
  };
}

function measurement(c: EntityContext, h: AuditConfig['health'], weight: number): Component {
  if (!c.conversion)
    return none('measurement', weight, 'not_applicable', 'el evento clave no es una conversión');
  const s = c.mature;
  if (s.inlineLinkClicks < 100)
    return none('measurement', weight, 'insufficient', 'menos de 100 clics en el enlace');
  if (!c.cvrRef)
    return none('measurement', weight, 'insufficient', 'sin tasa de conversión de referencia');
  const post = ratePosterior(eventsOf(s, c.kpi), s.inlineLinkClicks, c.cvrRef.value, PRIOR.cvr);
  const [lo, hi] = post.interval();
  const q = post.mean / c.cvrRef.value;
  return {
    id: 'measurement',
    status: 'ok',
    value: post.mean,
    reference: c.cvrRef.value,
    referenceSource: c.cvrRef.source,
    q,
    s: normalize(q, h),
    weight,
    confidence: widthConfidence(lo, hi, post.mean),
    n: s.inlineLinkClicks,
    note: 'conversiones registradas por clic frente a la referencia (cae si se rompe el seguimiento)',
  };
}

function fatigue(c: EntityContext, h: AuditConfig['health'], weight: number): Component {
  const a = c.prev;
  const b = c.cur;
  if (a.impressions < 1000 || b.impressions < 1000)
    return none('fatigue', weight, 'insufficient', 'menos de 1000 impresiones por semana');
  if (a.reach === 0 || b.reach === 0 || a.inlineLinkClicks === 0)
    return none('fatigue', weight, 'insufficient', 'sin alcance o clics para comparar');
  const ctrA = a.inlineLinkClicks / a.impressions;
  const ctrB = ratePosterior(b.inlineLinkClicks, b.impressions, ctrA, PRIOR.ctr).mean;
  const freqA = a.impressions / a.reach;
  const freqB = b.impressions / b.reach;
  // Media geométrica de la tendencia del CTR y de la frecuencia (que sube es peor).
  const q = Math.sqrt((ctrB / ctrA) * (freqA / freqB));
  const n = Math.min(a.impressions, b.impressions);
  return {
    id: 'fatigue',
    status: 'ok',
    value: freqB,
    reference: freqA,
    referenceSource: 'baseline',
    q,
    s: normalize(q, h),
    weight,
    confidence: n >= 10_000 ? HIGH : n >= 3000 ? MEDIUM : LOW,
    n,
    note: 'tendencia del CTR del enlace y de la frecuencia frente a la semana anterior',
  };
}

export function healthOf(c: EntityContext, config: AuditConfig): HealthScore {
  const h = config.health;
  const weights = h.weights[c.profile] ?? h.weights.other;
  const wt = (id: Subindex) => weights?.[id] ?? 0;
  const days = config.windows.evaluationDays;
  const components = [
    efficiency(c, h, wt('efficiency')),
    stability(c, h, wt('stability'), stabilityFloor(config)),
    delivery(c, days, wt('delivery')),
    measurement(c, h, wt('measurement')),
    fatigue(c, h, wt('fatigue')),
  ];
  // Sin gasto en la ventana no hay nada que puntuar.
  const scored =
    c.cur.spend > 0
      ? combine(components, h.minCoverage)
      : { score: null, coverage: 0, confidence: null, grade: gradeOf(null) };
  return {
    level: c.level,
    entityId: c.id,
    profile: c.profile,
    formulaVersion: HEALTH_FORMULA_VERSION,
    windowDays: days,
    ...scored,
    components,
  };
}

/**
 * Cuenta: media de las campañas ponderada por su gasto en la ventana. Cada componente de la
 * cuenta es la misma media sobre las campañas en las que ese componente fue evaluable.
 */
export function accountHealthOf(
  entityId: string,
  campaigns: Array<{ health: HealthScore; spend: number }>,
  config: AuditConfig,
): HealthScore {
  const withSpend = campaigns.filter((x) => x.spend > 0);
  const totalSpend = withSpend.reduce((a, x) => a + x.spend, 0);
  const scored = withSpend.filter((x) => x.health.score !== null);
  const scoredSpend = scored.reduce((a, x) => a + x.spend, 0);
  const coverage = totalSpend > 0 ? scoredSpend / totalSpend : 0;
  const components: Component[] = SUBINDEX_IDS.map((id) => {
    const parts = scored
      .map((x) => ({ spend: x.spend, comp: x.health.components.find((k) => k.id === id) }))
      .filter((x) => x.comp?.status === 'ok' && x.comp.s !== null);
    const w = parts.reduce((a, x) => a + x.spend, 0);
    if (!w) return none(id, 0, 'insufficient', 'ninguna campaña con este componente evaluable');
    return {
      ...none(
        id,
        0,
        'ok',
        'media de las campañas ponderada por gasto (informativa: la puntuación es la media de las campañas)',
      ),
      s: parts.reduce((a, x) => a + x.spend * (x.comp?.s as number), 0) / w,
      confidence: parts.reduce((a, x) => a + x.spend * (x.comp?.confidence ?? 0), 0) / w,
      n: parts.length,
    };
  });
  const enough = scoredSpend > 0 && coverage >= config.health.minCoverage;
  const score = enough
    ? Math.round(
        (scored.reduce((a, x) => a + x.spend * (x.health.score as number), 0) / scoredSpend) * 100,
      ) / 100
    : null;
  const confidence = enough
    ? coverage *
      (scored.reduce((a, x) => a + x.spend * (x.health.confidence ?? 0), 0) / scoredSpend)
    : null;
  return {
    level: 'account',
    entityId,
    profile: 'other',
    formulaVersion: HEALTH_FORMULA_VERSION,
    windowDays: config.windows.evaluationDays,
    score,
    grade: gradeOf(score),
    coverage,
    confidence,
    components,
  };
}

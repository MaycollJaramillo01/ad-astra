import { z } from 'zod';
import { addDays } from '../insights/catalog.ts';
import {
  costText,
  type EntityContext,
  eventsOf,
  inWindow,
  money,
  num,
  pct,
  type Reference,
  type ReferenceSource,
  SOURCE_LABEL,
  type Window,
  type Windows,
} from './context.ts';
import type { AuditConfig, AuditLevel, Category, Profile, Severity } from './model.ts';
import { costPosterior, gammaP, normalCdf, poissonCdf, proportionDropP, robustZ } from './stats.ts';

// Catálogo de reglas v1 (ARCHITECTURE §6.5). Cada regla es una función pura con parámetros
// validados por esquema, criterios de elegibilidad y muestra mínima explícitos, y tres salidas
// posibles: dispara, no dispara o datos insuficientes.

export interface Impact {
  metric: string;
  value: number;
  currency: string;
  method: string;
}

export type Outcome =
  | {
      status: 'triggered';
      severity: Severity;
      /** 0–1: probabilidad a posteriori, 1 − p, o 1 en las reglas deterministas. */
      confidence: number;
      /** Valor p de la prueba (para el control de falsos descubrimientos). */
      pValue?: number;
      metrics: Record<string, number | string | null>;
      reference?: { metric: string; value: number; source: ReferenceSource; n: number };
      threshold?: Record<string, number | string>;
      sample: Record<string, number>;
      window: Window;
      explanation: string;
      impact: Impact | null;
      recommendation: { key: string; text: string };
    }
  /** Si la regla hizo una prueba, su valor p (entra en el control de falsos descubrimientos). */
  | { status: 'not_triggered'; pValue?: number }
  | { status: 'insufficient_data'; reason: string };

export interface Env {
  currency: string;
  /** Gasto de la cuenta en la ventana de evaluación (base del impacto relativo). */
  accountSpend: number;
  win: Windows;
  config: AuditConfig;
  children: (level: AuditLevel, id: string) => EntityContext[];
  severityFor: (impact: number | null, floor: Severity) => Severity;
}

export interface RuleDef<S extends z.ZodObject = z.ZodObject> {
  id: string;
  version: number;
  category: Category;
  title: string;
  /** Qué detecta y por qué importa. */
  description: string;
  /** Método estadístico o lógica determinista. */
  method: string;
  /** Muestra mínima legible (la exige `evaluate`). */
  minSample: string;
  levels: AuditLevel[];
  profiles: Profile[] | 'all';
  /** Produce un valor p y entra en el control de falsos descubrimientos. */
  statistical: boolean;
  params: S;
  evaluate: (c: EntityContext, p: z.infer<S>, env: Env) => Outcome;
}

const defineRule = <S extends z.ZodObject>(r: RuleDef<S>) => r as unknown as RuleDef;
const insufficient = (reason: string): Outcome => ({ status: 'insufficient_data', reason });
const NOT: Outcome = { status: 'not_triggered' };
const notWith = (pValue: number): Outcome => ({ status: 'not_triggered', pValue });
const refOf = (metric: string, r: Reference) => ({
  metric,
  value: r.value,
  source: r.source,
  n: r.n,
});
const prob = z.number().min(0).max(1);
const NON_AWARENESS: Profile[] = [
  'traffic',
  'engagement',
  'messages',
  'leads',
  'sales',
  'app',
  'other',
];
const ENTITY_LEVELS: AuditLevel[] = ['campaign', 'adset', 'ad'];

/** Ventana usada por las reglas de costo: la madura para conversiones, la de evaluación si no. */
const costWindow = (c: EntityContext, env: Env) =>
  c.conversion ? env.win.mature : env.win.evaluation;

export const RULES: RuleDef[] = [
  defineRule({
    id: 'R-EFF-001',
    version: 1,
    category: 'efficiency',
    title: 'Costo por evento clave por encima de la referencia',
    description:
      'El costo del evento clave del objetivo (CPM, CPC, costo por visita, por conversación, por cliente potencial, por compra o por instalación) supera la referencia más allá de la tolerancia.',
    method:
      'Gamma-Poisson: tasa de eventos por unidad gastada con a priori Gamma(k, k·referencia); dispara si P(costo > referencia·(1 + tolerancia)) ≥ probabilidad mínima.',
    minSample: 'Gasto ≥ múltiplo × costo de referencia (≥ 1000 impresiones en reconocimiento)',
    levels: ENTITY_LEVELS,
    profiles: 'all',
    statistical: true,
    params: z.object({
      tolerance: z.number().min(0).max(2).default(0.2),
      minProbability: z.number().min(0.5).max(0.999).default(0.8),
      minSpendMultiple: z.number().min(0.5).max(20).default(2),
      minImpressions: z.number().int().min(100).default(1000),
      priorStrength: z.number().min(0.5).max(50).default(5),
    }),
    evaluate(c, p, env) {
      if (!c.costRef)
        return insufficient(
          'sin referencia: define un objetivo del cliente o espera a tener línea base',
        );
      const s = c.mature;
      const events = eventsOf(s, c.kpi);
      const expected = s.spend / c.costRef.value;
      const min = c.kpi.field === 'impressions' ? p.minImpressions : p.minSpendMultiple;
      if (expected < min)
        return insufficient(
          `gasto insuficiente: se esperaban ${num(expected)} ${c.kpi.label} y hacen falta ${min}`,
        );
      const post = costPosterior(s.spend, events, c.costRef.value, p.priorStrength);
      const limit = c.costRef.value * (1 + p.tolerance);
      const probability = post.probCostAbove(limit);
      if (probability < p.minProbability) return notWith(1 - probability);
      const [lo, hi] = post.interval(0.8);
      const excess = Math.max(0, s.spend - events * c.costRef.value);
      return {
        status: 'triggered',
        severity: env.severityFor(excess, 'low'),
        confidence: probability,
        pValue: 1 - probability,
        metrics: {
          spend: s.spend,
          events,
          observedCost: events > 0 ? (s.spend / events) * c.kpi.scale : null,
          estimatedCost: post.estimate * c.kpi.scale,
          interval80Low: lo * c.kpi.scale,
          interval80High: hi * c.kpi.scale,
          probabilityAboveLimit: probability,
        },
        reference: refOf(c.kpi.costLabel, { ...c.costRef, value: c.costRef.value * c.kpi.scale }),
        threshold: { tolerance: p.tolerance, minProbability: p.minProbability },
        sample: { spend: s.spend, events },
        window: costWindow(c, env),
        explanation: `El ${c.kpi.costLabel} estimado es ${costText(c, post.estimate, env.currency)} (intervalo del 80 %: ${costText(c, lo, env.currency)}–${costText(c, hi, env.currency)}) frente a una referencia de ${costText(c, c.costRef.value, env.currency)} (${SOURCE_LABEL[c.costRef.source]}). Con ${num(events)} ${c.kpi.label} y ${money(s.spend, env.currency)} de gasto, la probabilidad de que el costo real supere la referencia en más de un ${pct(p.tolerance)} es del ${pct(probability)}.`,
        impact: {
          metric: 'excess_spend',
          value: excess,
          currency: env.currency,
          method: 'gasto − eventos × costo de referencia',
        },
        recommendation: {
          key: 'review_efficiency',
          text: 'Revisar puja, audiencia y creatividades; mover presupuesto hacia las entidades con mejor costo.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-EFF-002',
    version: 1,
    category: 'efficiency',
    title: 'Gasto sin eventos clave',
    description: 'La entidad gastó lo suficiente para esperar eventos clave y no registró ninguno.',
    method:
      'Poisson: con λ = gasto / costo de referencia eventos esperados, P(0 eventos) = e^−λ; dispara si es menor que α.',
    minSample: 'Gasto ≥ 1 × costo de referencia',
    levels: ENTITY_LEVELS,
    profiles: NON_AWARENESS,
    statistical: true,
    params: z.object({ alpha: prob.default(0.05), minExpected: z.number().min(0.5).default(1) }),
    evaluate(c, p, env) {
      if (!c.costRef) return insufficient('sin referencia de costo');
      const s = c.mature;
      const events = eventsOf(s, c.kpi);
      const expected = s.spend / c.costRef.value;
      if (expected < p.minExpected)
        return insufficient(`gasto insuficiente: se esperaban ${num(expected)} ${c.kpi.label}`);
      if (events > 0) return NOT;
      const pValue = Math.exp(-expected);
      if (pValue >= p.alpha) return notWith(pValue);
      return {
        status: 'triggered',
        severity: env.severityFor(s.spend, 'medium'),
        confidence: 1 - pValue,
        pValue,
        metrics: { spend: s.spend, events, expectedEvents: expected, probabilityOfZero: pValue },
        reference: refOf(c.kpi.costLabel, { ...c.costRef, value: c.costRef.value * c.kpi.scale }),
        threshold: { alpha: p.alpha },
        sample: { spend: s.spend, expectedEvents: expected },
        window: costWindow(c, env),
        explanation: `Gastó ${money(s.spend, env.currency)} sin ${c.kpi.label}. Al costo de referencia (${costText(c, c.costRef.value, env.currency)}, ${SOURCE_LABEL[c.costRef.source]}) se esperaban ${num(expected)}; la probabilidad de no obtener ninguno por azar es del ${pct(pValue, 1)}.`,
        impact: {
          metric: 'spend_without_results',
          value: s.spend,
          currency: env.currency,
          method: 'gasto de la ventana',
        },
        recommendation: {
          key: 'check_tracking_destination',
          text: 'Verificar el seguimiento y el destino; pausar si persiste.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-PERF-003',
    version: 1,
    category: 'performance',
    title: 'Eventos clave por debajo de lo esperado',
    description:
      'Con el gasto de la ventana y la tasa histórica propia, la entidad debería haber logrado más eventos clave.',
    method:
      'Poisson: esperados = gasto × eventos/gasto de la línea base; dispara si P(X ≤ observados) < α y la caída supera el mínimo.',
    minSample: 'Línea base con ≥ 10 eventos y ≥ 5 eventos esperados en la ventana',
    levels: ENTITY_LEVELS,
    profiles: NON_AWARENESS,
    statistical: true,
    params: z.object({
      alpha: prob.default(0.05),
      minExpected: z.number().min(1).default(5),
      minBaselineEvents: z.number().int().min(5).default(10),
      minDrop: prob.default(0.2),
    }),
    evaluate(c, p, env) {
      const baseEvents = eventsOf(c.base, c.kpi);
      if (baseEvents < p.minBaselineEvents || c.base.spend <= 0)
        return insufficient(
          `línea base con ${num(baseEvents)} ${c.kpi.label} (hacen falta ${p.minBaselineEvents})`,
        );
      const s = c.mature;
      const rate = baseEvents / c.base.spend;
      const expected = s.spend * rate;
      if (expected < p.minExpected)
        return insufficient(
          `se esperaban ${num(expected)} ${c.kpi.label} (hacen falta ${p.minExpected})`,
        );
      const observed = eventsOf(s, c.kpi);
      const pValue = poissonCdf(observed, expected);
      if (pValue >= p.alpha || observed > expected * (1 - p.minDrop)) return notWith(pValue);
      const lost = expected - observed;
      const baseCost = c.base.spend / baseEvents;
      return {
        status: 'triggered',
        severity: env.severityFor(lost * baseCost, 'low'),
        confidence: 1 - pValue,
        pValue,
        metrics: {
          spend: s.spend,
          observed,
          expected,
          ratio: observed / expected,
          baselineRatePerSpend: rate,
        },
        reference: {
          metric: 'eventos por unidad gastada',
          value: rate,
          source: 'baseline',
          n: baseEvents,
        },
        threshold: { alpha: p.alpha, minDrop: p.minDrop },
        sample: { expected, baselineEvents: baseEvents },
        window: costWindow(c, env),
        explanation: `Logró ${num(observed)} ${c.kpi.label} cuando, con su gasto (${money(s.spend, env.currency)}) y su tasa de los ${env.config.windows.baselineDays} días previos, se esperaban ${num(expected)} (${pct(observed / expected - 1)}). La probabilidad de una caída así por azar es del ${pct(pValue, 1)}.`,
        impact: {
          metric: 'lost_results_cost',
          value: lost * baseCost,
          currency: env.currency,
          method: '(esperados − observados) × costo de la línea base',
        },
        recommendation: {
          key: 'diagnose_cpa',
          text: 'Diagnosticar con la descomposición del costo (subasta, creatividad, conversión).',
        },
      };
    },
  }),

  defineRule({
    id: 'R-EFF-004',
    version: 1,
    category: 'efficiency',
    title: 'ROAS por debajo de la referencia',
    description:
      'En campañas de ventas con valor de compra, el retorno queda por debajo de la referencia más allá de la tolerancia.',
    method:
      'Gamma-Poisson sobre las compras con el valor medio de la ventana: dispara si P(ROAS < referencia·(1 − tolerancia)) ≥ probabilidad mínima.',
    minSample: '≥ 3 compras en la ventana o en la línea base para el valor medio',
    levels: ENTITY_LEVELS,
    profiles: ['sales'],
    statistical: true,
    params: z.object({
      tolerance: prob.default(0.2),
      minProbability: z.number().min(0.5).max(0.999).default(0.8),
      minPurchases: z.number().int().min(1).default(3),
      priorStrength: z.number().min(0.5).max(50).default(5),
    }),
    evaluate(c, p, env) {
      if (!c.roasRef) return insufficient('sin referencia de ROAS');
      const s = c.mature;
      const aovFrom =
        s.purchases >= p.minPurchases ? s : c.base.purchases >= p.minPurchases ? c.base : null;
      if (!aovFrom || s.spend <= 0)
        return insufficient(`menos de ${p.minPurchases} compras para estimar el valor medio`);
      const aov = aovFrom.purchaseValue / aovFrom.purchases;
      if (aov <= 0) return insufficient('las compras no tienen valor');
      const alpha = p.priorStrength + s.purchases;
      const beta = (p.priorStrength * aov) / c.roasRef.value + s.spend;
      const limit = c.roasRef.value * (1 - p.tolerance);
      const probability = gammaP(alpha, (beta * limit) / aov);
      if (probability < p.minProbability) return notWith(1 - probability);
      const roas = (aov * alpha) / beta;
      const shortfall = Math.max(0, s.spend * c.roasRef.value - s.purchaseValue);
      return {
        status: 'triggered',
        severity: env.severityFor(shortfall, 'low'),
        confidence: probability,
        pValue: 1 - probability,
        metrics: {
          spend: s.spend,
          purchases: s.purchases,
          purchaseValue: s.purchaseValue,
          observedRoas: s.purchaseValue / s.spend,
          estimatedRoas: roas,
          averageOrderValue: aov,
        },
        reference: refOf('ROAS', c.roasRef),
        threshold: { tolerance: p.tolerance, minProbability: p.minProbability },
        sample: { purchases: s.purchases, spend: s.spend },
        window: costWindow(c, env),
        explanation: `El ROAS estimado es ${roas.toFixed(2)} frente a una referencia de ${c.roasRef.value.toFixed(2)} (${SOURCE_LABEL[c.roasRef.source]}), con ${num(s.purchases)} compras por ${money(s.purchaseValue, env.currency)}. La probabilidad de que quede más de un ${pct(p.tolerance)} por debajo es del ${pct(probability)}.`,
        impact: {
          metric: 'value_shortfall',
          value: shortfall,
          currency: env.currency,
          method: 'gasto × ROAS de referencia − valor de compra',
        },
        recommendation: {
          key: 'review_roas',
          text: 'Revisar catálogo, audiencias y ofertas; priorizar los productos con mejor margen.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-RATE-005',
    version: 1,
    category: 'performance',
    title: 'Caída del CTR del enlace',
    description: 'El porcentaje de clics en el enlace cae frente a la línea base propia.',
    method:
      'Prueba de dos proporciones unilateral (línea base frente a ventana); dispara si p < α y la caída relativa supera el mínimo.',
    minSample: '≥ 2000 impresiones en la línea base y en la ventana',
    levels: ['adset', 'ad'],
    profiles: NON_AWARENESS,
    statistical: true,
    params: z.object({
      alpha: prob.default(0.05),
      minImpressions: z.number().int().min(500).default(2000),
      minRelativeDrop: prob.default(0.15),
    }),
    evaluate(c, p, env) {
      if (c.base.impressions < p.minImpressions || c.cur.impressions < p.minImpressions)
        return insufficient(
          `impresiones insuficientes (${num(c.base.impressions)} y ${num(c.cur.impressions)}; hacen falta ${p.minImpressions})`,
        );
      const before = c.base.inlineLinkClicks / c.base.impressions;
      const now = c.cur.inlineLinkClicks / c.cur.impressions;
      if (before === 0) return insufficient('sin clics en la línea base');
      const pValue = proportionDropP(
        c.base.inlineLinkClicks,
        c.base.impressions,
        c.cur.inlineLinkClicks,
        c.cur.impressions,
      );
      if (pValue >= p.alpha || now > before * (1 - p.minRelativeDrop)) return notWith(pValue);
      return {
        status: 'triggered',
        severity: 'medium',
        confidence: 1 - pValue,
        pValue,
        metrics: { linkCtr: now, baselineLinkCtr: before, relativeChange: now / before - 1 },
        reference: {
          metric: 'CTR del enlace',
          value: before,
          source: 'baseline',
          n: c.base.impressions,
        },
        threshold: { alpha: p.alpha, minRelativeDrop: p.minRelativeDrop },
        sample: { impressions: c.cur.impressions, baselineImpressions: c.base.impressions },
        window: env.win.evaluation,
        explanation: `El CTR del enlace bajó de ${pct(before, 2)} a ${pct(now, 2)} (${pct(now / before - 1)}) con ${num(c.cur.impressions)} impresiones; la probabilidad de una caída así por azar es del ${pct(pValue, 2)}.`,
        impact: null,
        recommendation: {
          key: 'refresh_creative',
          text: 'Revisar la relevancia de la creatividad y del mensaje para la audiencia.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-STAB-006',
    version: 1,
    category: 'stability',
    title: 'Costo diario inestable',
    description:
      'El costo diario por evento varía mucho más que en entidades comparables de la cuenta.',
    method:
      'Coeficiente de variación del costo diario corregido por el ruido de Poisson (√max(0, CV² − 1/media de eventos diarios)); dispara si supera max(piso, factor × mediana de la cuenta para el mismo nivel y perfil).',
    minSample: '≥ 10 días con eventos en la ventana de estabilidad y ≥ 3 entidades comparables',
    levels: ['campaign', 'adset'],
    profiles: 'all',
    statistical: false,
    params: z.object({
      minDays: z.number().int().min(5).default(10),
      relativeFactor: z.number().min(1).default(1.5),
      floor: z.number().min(0).default(0.3),
    }),
    evaluate(c, p, env) {
      if (!c.cv || c.cv.days < p.minDays)
        return insufficient(`${c.cv?.days ?? 0} días con eventos (hacen falta ${p.minDays})`);
      if (c.cvBenchmark === null)
        return insufficient('sin entidades comparables en la cuenta para fijar el umbral');
      const threshold = Math.max(p.floor, c.cvBenchmark * p.relativeFactor);
      if (c.cv.value <= threshold) return NOT;
      return {
        status: 'triggered',
        severity: 'low',
        confidence: Math.min(1, c.cv.days / env.config.windows.stabilityDays) * 0.9,
        metrics: { adjustedCv: c.cv.value, accountMedianCv: c.cvBenchmark, threshold },
        reference: {
          metric: 'CV de la cuenta',
          value: c.cvBenchmark,
          source: 'account_median',
          n: 0,
        },
        threshold: { relativeFactor: p.relativeFactor, floor: p.floor },
        sample: { days: c.cv.days },
        window: env.win.stability,
        explanation: `El costo diario por ${c.kpi.label.replace(/s$/, '')} varía con un coeficiente de ${c.cv.value.toFixed(2)} (sin el ruido de muestreo), por encima del umbral ${threshold.toFixed(2)} que resulta de la mediana de la cuenta (${c.cvBenchmark.toFixed(2)}) × ${p.relativeFactor}.`,
        impact: null,
        recommendation: {
          key: 'stabilize_budget',
          text: 'Consolidar o estabilizar el presupuesto y evitar cambios frecuentes.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-FAT-007',
    version: 1,
    category: 'fatigue',
    title: 'Fatiga creativa',
    description:
      'La frecuencia sube mientras el CTR del enlace cae entre la semana anterior y la actual.',
    method:
      'Prueba de dos proporciones del CTR (semana anterior frente a la actual) y aumento de la frecuencia diaria media (impresiones ÷ alcance diario).',
    minSample: '≥ 1000 impresiones en cada semana',
    levels: ['adset', 'ad'],
    profiles: 'all',
    statistical: true,
    params: z.object({
      alpha: prob.default(0.05),
      minImpressions: z.number().int().min(200).default(1000),
      minCtrDrop: prob.default(0.15),
      minFrequencyIncrease: z.number().min(0).default(0.1),
      /** Frecuencia máxima del cliente para el perfil (opcional: sin valor por defecto universal). */
      maxFrequency: z.number().positive().nullable().default(null),
    }),
    evaluate(c, p, env) {
      const a = c.prev;
      const b = c.cur;
      if (a.impressions < p.minImpressions || b.impressions < p.minImpressions)
        return insufficient(
          `impresiones insuficientes por semana (hacen falta ${p.minImpressions})`,
        );
      if (a.reach === 0 || b.reach === 0 || a.inlineLinkClicks === 0)
        return insufficient('sin alcance o sin clics para comparar');
      const freqA = a.impressions / a.reach;
      const freqB = b.impressions / b.reach;
      const ctrA = a.inlineLinkClicks / a.impressions;
      const ctrB = b.inlineLinkClicks / b.impressions;
      const pValue = proportionDropP(
        a.inlineLinkClicks,
        a.impressions,
        b.inlineLinkClicks,
        b.impressions,
      );
      const freqUp =
        freqB >= freqA * (1 + p.minFrequencyIncrease) ||
        (p.maxFrequency !== null && freqB > p.maxFrequency);
      if (pValue >= p.alpha || ctrB > ctrA * (1 - p.minCtrDrop) || !freqUp) return notWith(pValue);
      return {
        status: 'triggered',
        severity: 'medium',
        confidence: 1 - pValue,
        pValue,
        metrics: {
          frequencyBefore: freqA,
          frequencyNow: freqB,
          linkCtrBefore: ctrA,
          linkCtrNow: ctrB,
        },
        reference: {
          metric: 'CTR del enlace de la semana anterior',
          value: ctrA,
          source: 'baseline',
          n: a.impressions,
        },
        threshold: {
          alpha: p.alpha,
          minCtrDrop: p.minCtrDrop,
          minFrequencyIncrease: p.minFrequencyIncrease,
          ...(p.maxFrequency !== null && { maxFrequency: p.maxFrequency }),
        },
        sample: { impressionsBefore: a.impressions, impressionsNow: b.impressions },
        window: { since: env.win.previous.since, until: env.win.evaluation.until },
        explanation: `La frecuencia diaria media pasó de ${freqA.toFixed(2)} a ${freqB.toFixed(2)} mientras el CTR del enlace caía de ${pct(ctrA, 2)} a ${pct(ctrB, 2)} (probabilidad por azar ${pct(pValue, 2)}): la audiencia se está cansando de la creatividad.`,
        impact: null,
        recommendation: {
          key: 'rotate_creative',
          text: 'Rotar o renovar las creatividades; ampliar la audiencia si la frecuencia sigue subiendo.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-DEL-008',
    version: 1,
    category: 'delivery',
    title: 'Activo sin entrega o con problemas',
    description:
      'Una entidad activa (ella y sus padres) no entrega en los últimos días, o Meta la marca rechazada, con problemas o sin facturación.',
    method:
      'Determinista: impresiones = 0 en los días de entrega con entrega previa o presupuesto; o estado efectivo de error de Meta.',
    minSample: '— (determinista)',
    levels: ENTITY_LEVELS,
    profiles: 'all',
    statistical: false,
    params: z.object({}),
    evaluate(c, _p, env) {
      const e = c.entity;
      if (!e) return NOT;
      const blocked = ['DISAPPROVED', 'WITH_ISSUES', 'PENDING_BILLING_INFO'].includes(
        e.status ?? '',
      );
      const silent =
        c.active &&
        c.delivery.impressions === 0 &&
        (c.base.impressions > 0 || (e.dailyBudget ?? 0) > 0);
      if (!blocked && !silent && !(c.active && e.hasIssues)) return NOT;
      const days = env.config.windows.deliveryDays;
      const planned = e.dailyBudget ? e.dailyBudget * days : null;
      const reason = blocked
        ? `Meta la marca como ${e.status === 'DISAPPROVED' ? 'rechazada' : e.status === 'PENDING_BILLING_INFO' ? 'pendiente de facturación' : 'con problemas'}`
        : silent
          ? `está activa y no tuvo impresiones en los últimos ${days} días`
          : 'Meta informa problemas de entrega';
      return {
        status: 'triggered',
        severity:
          e.status === 'PENDING_BILLING_INFO' ? 'critical' : env.severityFor(planned, 'high'),
        confidence: 1,
        metrics: {
          status: e.status,
          impressionsLastDays: c.delivery.impressions,
          baselineImpressions: c.base.impressions,
          dailyBudget: e.dailyBudget,
          hasIssues: e.hasIssues ? 1 : 0,
        },
        sample: { days },
        window: env.win.delivery,
        explanation: `La entidad ${reason}.${planned ? ` Con su presupuesto diario quedan sin ejecutar unos ${money(planned, env.currency)}.` : ''}`,
        impact: planned
          ? {
              metric: 'unspent_budget',
              value: planned,
              currency: env.currency,
              method: 'presupuesto diario × días sin entrega',
            }
          : null,
        recommendation: {
          key: 'review_delivery',
          text: 'Revisar rechazos, facturación, puja, presupuesto y audiencia.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-DEL-009',
    version: 1,
    category: 'delivery',
    title: 'Límite de puja por debajo del costo real',
    description:
      'El conjunto usa un límite de costo o de puja inferior al costo por evento que está logrando, lo que frena la entrega.',
    method:
      'Gamma-Poisson con a priori centrada en el límite: dispara si P(costo > límite) ≥ probabilidad mínima en la ventana de estabilidad.',
    minSample: '≥ 3 eventos en la ventana de estabilidad',
    levels: ['adset'],
    profiles: NON_AWARENESS,
    statistical: true,
    params: z.object({
      minEvents: z.number().int().min(1).default(3),
      minProbability: z.number().min(0.5).max(0.999).default(0.8),
      priorStrength: z.number().min(0.5).default(2),
    }),
    evaluate(c, p, env) {
      const e = c.entity;
      const capped = ['COST_CAP', 'LOWEST_COST_WITH_BID_CAP', 'TARGET_COST'].includes(
        e?.bidStrategy ?? '',
      );
      if (!e || !capped || !e.bidAmount) return NOT;
      const s = c.stability;
      const events = eventsOf(s, c.kpi);
      if (events < p.minEvents)
        return insufficient(`${num(events)} ${c.kpi.label} (hacen falta ${p.minEvents})`);
      const post = costPosterior(s.spend, events, e.bidAmount, p.priorStrength);
      const probability = post.probCostAbove(e.bidAmount);
      if (probability < p.minProbability) return notWith(1 - probability);
      return {
        status: 'triggered',
        severity: 'medium',
        confidence: probability,
        pValue: 1 - probability,
        metrics: {
          bidStrategy: e.bidStrategy,
          bidAmount: e.bidAmount,
          estimatedCost: post.estimate,
          events,
          spend: s.spend,
        },
        reference: { metric: 'límite de puja', value: e.bidAmount, source: 'target', n: 0 },
        threshold: { minProbability: p.minProbability },
        sample: { events },
        window: env.win.stability,
        explanation: `El límite (${money(e.bidAmount, env.currency)}) está por debajo del ${c.kpi.costLabel} estimado (${money(post.estimate, env.currency)}) con una probabilidad del ${pct(probability)}: Meta no puede gastar el presupuesto sin superarlo.`,
        impact: null,
        recommendation: {
          key: 'raise_bid_cap',
          text: 'Subir el límite o pasar a menor costo sin límite.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-DEL-010',
    version: 1,
    category: 'delivery',
    title: 'Aprendizaje limitado',
    description:
      'Meta informa "aprendizaje limitado" o el presupuesto no alcanza para los eventos semanales que necesita la fase de aprendizaje.',
    method:
      'Determinista: learning_stage_info = FAIL; o presupuesto semanal ÷ costo de referencia < eventos de aprendizaje.',
    minSample: '— (determinista; la proyección necesita presupuesto y costo de referencia)',
    levels: ['adset'],
    profiles: NON_AWARENESS,
    statistical: false,
    params: z.object({ learningEvents: z.number().int().min(1).default(50) }),
    evaluate(c, p, env) {
      const e = c.entity;
      if (!e || !c.active) return NOT;
      const projected = e.dailyBudget && c.costRef ? (e.dailyBudget * 7) / c.costRef.value : null;
      const failed = e.learning === 'FAIL';
      if (!failed && (projected === null || projected >= p.learningEvents)) return NOT;
      return {
        status: 'triggered',
        severity: 'medium',
        confidence: failed ? 1 : 0.8,
        metrics: {
          learningStatus: e.learning,
          dailyBudget: e.dailyBudget,
          projectedWeeklyEvents: projected,
        },
        ...(c.costRef && { reference: refOf(c.kpi.costLabel, c.costRef) }),
        threshold: { learningEvents: p.learningEvents },
        sample: { budgetDays: 7 },
        window: env.win.evaluation,
        explanation: failed
          ? 'Meta informa que el conjunto está en aprendizaje limitado: no consigue suficientes eventos para estabilizarse.'
          : `Con ${money(e.dailyBudget ?? 0, env.currency)} diarios y un ${c.kpi.costLabel} de referencia de ${costText(c, c.costRef?.value ?? 0, env.currency)}, el conjunto lograría unos ${num(projected ?? 0)} ${c.kpi.label} por semana, menos de los ${p.learningEvents} que necesita la fase de aprendizaje.`,
        impact: null,
        recommendation: {
          key: 'consolidate_or_raise_budget',
          text: 'Consolidar conjuntos o subir el presupuesto hasta los eventos semanales necesarios.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-STR-011',
    version: 1,
    category: 'structure',
    title: 'Estructura fragmentada',
    description:
      'La campaña reparte el presupuesto entre muchos conjuntos activos del mismo perfil y ninguno llega a los eventos semanales del aprendizaje.',
    method:
      'Determinista: ≥ k conjuntos activos del mismo perfil con eventos semanales (ventana normalizada a 7 días) < eventos de aprendizaje.',
    minSample: '— (determinista)',
    levels: ['campaign'],
    profiles: NON_AWARENESS,
    statistical: false,
    params: z.object({
      minAdsets: z.number().int().min(2).default(3),
      learningEvents: z.number().int().min(1).default(50),
    }),
    evaluate(c, p, env) {
      const adsets = env
        .children('campaign', c.id)
        .filter((a) => a.active && a.profile === c.profile);
      if (adsets.length < p.minAdsets) return NOT;
      const weekly = (a: EntityContext) =>
        (eventsOf(a.cur, a.kpi) * 7) / env.config.windows.evaluationDays;
      if (!adsets.every((a) => weekly(a) < p.learningEvents)) return NOT;
      const total = adsets.reduce((acc, a) => acc + weekly(a), 0);
      return {
        status: 'triggered',
        severity: 'low',
        confidence: 1,
        metrics: {
          activeAdsets: adsets.length,
          weeklyEventsTotal: total,
          maxWeeklyEventsPerAdset: Math.max(...adsets.map(weekly)),
        },
        threshold: { minAdsets: p.minAdsets, learningEvents: p.learningEvents },
        sample: { adsets: adsets.length },
        window: env.win.evaluation,
        explanation: `La campaña tiene ${adsets.length} conjuntos activos y ninguno llega a ${p.learningEvents} ${c.kpi.label} por semana (entre todos suman ${num(total)}): el presupuesto está demasiado repartido para salir del aprendizaje.`,
        impact: null,
        recommendation: {
          key: 'consolidate_adsets',
          text: 'Consolidar conjuntos (o usar Advantage+ cuando aplique).',
        },
      };
    },
  }),

  defineRule({
    id: 'R-ATT-012',
    version: 1,
    category: 'attribution',
    title: 'Ventanas de atribución distintas en una campaña',
    description:
      'Los conjuntos de una misma campaña usan configuraciones de atribución distintas: sus resultados no son comparables.',
    method:
      'Determinista: más de un attribution_setting entre los conjuntos con datos en la ventana.',
    minSample: '— (determinista)',
    levels: ['campaign'],
    profiles: 'all',
    statistical: false,
    params: z.object({}),
    evaluate(c, _p, env) {
      const settings = [
        ...new Set(env.children('campaign', c.id).flatMap((a) => a.attribution)),
      ].sort();
      if (settings.length <= 1) return NOT;
      return {
        status: 'triggered',
        severity: 'low',
        confidence: 1,
        metrics: { attributionSettings: settings.join(', ') },
        sample: { settings: settings.length },
        window: env.win.evaluation,
        explanation: `Los conjuntos de la campaña usan ${settings.length} configuraciones de atribución (${settings.join(', ')}): compararlos entre sí mezcla criterios distintos.`,
        impact: null,
        recommendation: {
          key: 'unify_attribution',
          text: 'Homogeneizar la ventana de atribución o interpretar las comparaciones con cautela.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-TRK-013',
    version: 1,
    category: 'tracking',
    title: 'Posible fallo de seguimiento',
    description:
      'Llegan clics al destino pero dejan de registrarse conversiones que la línea base sí registraba.',
    method:
      'Poisson: esperados = clics × conversiones/clic de la línea base; dispara con 0 conversiones si e^−esperados < α.',
    minSample: '≥ 100 clics en la ventana madura y ≥ 5 conversiones en la línea base',
    levels: ['campaign', 'adset'],
    profiles: ['leads', 'sales', 'app'],
    statistical: true,
    params: z.object({
      alpha: prob.default(0.01),
      minClicks: z.number().int().min(20).default(100),
      minBaselineEvents: z.number().int().min(1).default(5),
    }),
    evaluate(c, p, env) {
      const s = c.mature;
      const baseEvents = eventsOf(c.base, c.kpi);
      if (s.inlineLinkClicks < p.minClicks)
        return insufficient(`${num(s.inlineLinkClicks)} clics (hacen falta ${p.minClicks})`);
      if (baseEvents < p.minBaselineEvents || c.base.inlineLinkClicks === 0)
        return insufficient('la línea base no registraba conversiones suficientes');
      if (eventsOf(s, c.kpi) > 0) return NOT;
      const cvr = baseEvents / c.base.inlineLinkClicks;
      const expected = s.inlineLinkClicks * cvr;
      const pValue = Math.exp(-expected);
      if (pValue >= p.alpha) return notWith(pValue);
      return {
        status: 'triggered',
        severity: env.severityFor(s.spend, 'high'),
        confidence: 1 - pValue,
        pValue,
        metrics: {
          linkClicks: s.inlineLinkClicks,
          events: 0,
          baselineConversionRate: cvr,
          expectedEvents: expected,
          spend: s.spend,
        },
        reference: {
          metric: 'conversiones por clic',
          value: cvr,
          source: 'baseline',
          n: c.base.inlineLinkClicks,
        },
        threshold: { alpha: p.alpha },
        sample: { linkClicks: s.inlineLinkClicks, baselineEvents: baseEvents },
        window: env.win.mature,
        explanation: `Recibió ${num(s.inlineLinkClicks)} clics en el enlace y ninguna ${c.kpi.label.replace(/s$/, '')}, cuando con su tasa previa (${pct(cvr, 2)} por clic) se esperaban ${num(expected)}. Es muy improbable por azar (${pct(pValue, 2)}): revisa el píxel, la API de conversiones o el formulario.`,
        impact: {
          metric: 'spend_unmeasured',
          value: s.spend,
          currency: env.currency,
          method: 'gasto de la ventana madura',
        },
        recommendation: {
          key: 'check_tracking',
          text: 'Revisar el píxel, la API de conversiones, la deduplicación y el destino.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-CHG-014',
    version: 1,
    category: 'change',
    title: 'Cambio brusco en un indicador diario',
    description:
      'El gasto, el CPM o el CTR del enlace del último día se salen de lo habitual de la propia entidad.',
    method:
      'Puntuación z robusta de Iglewicz-Hoaglin (mediana y MAD de los días previos); dispara si |z| ≥ umbral y el cambio relativo supera el mínimo. Valor p normal bilateral para el control de falsos descubrimientos.',
    minSample: '≥ 14 días de historia con valor',
    levels: ['account', 'campaign'],
    profiles: 'all',
    statistical: true,
    params: z.object({
      threshold: z.number().min(2).default(3.5),
      minHistoryDays: z.number().int().min(7).default(14),
      minRelativeChange: prob.default(0.3),
      historyDays: z.number().int().min(14).max(90).default(28),
    }),
    evaluate(c, p, env) {
      // Una entidad en pausa no entrega: gastar 0 es lo esperado, no un cambio brusco.
      if (c.entity && !c.active) return NOT;
      const asOf = env.win.evaluation.until;
      const byDate = new Map(c.days.map((d) => [d.date, d]));
      // La historia empieza el primer día con gasto (una entidad nueva no tiene "ceros" previos) y
      // un día sin fila dentro de ella es un día sin entrega: gasto 0, CPM y CTR sin valor.
      const first = c.days.find((d) => d.spend > 0)?.date;
      const start =
        first && first > addDays(asOf, -p.historyDays) ? first : addDays(asOf, -p.historyDays);
      const history: Array<(typeof c.days)[number] | null> = [];
      for (let d = start; d < asOf; d = addDays(d, 1)) history.push(byDate.get(d) ?? null);
      const day = byDate.get(asOf) ?? null;
      const series: Record<string, (d: (typeof c.days)[number] | null) => number | null> = {
        spend: (d) => d?.spend ?? 0,
        cpm: (d) => (d && d.impressions > 0 ? (d.spend / d.impressions) * 1000 : null),
        linkCtr: (d) => (d && d.impressions > 0 ? d.inlineLinkClicks / d.impressions : null),
      };
      const label: Record<string, string> = {
        spend: 'el gasto',
        cpm: 'el CPM',
        linkCtr: 'el CTR del enlace',
      };
      let worst: { metric: string; value: number; z: number; median: number; n: number } | null =
        null;
      let tested = false;
      let minP = 1;
      for (const [metric, pick] of Object.entries(series)) {
        const values = history.map(pick).filter((v): v is number => v !== null);
        if (values.length < p.minHistoryDays) continue;
        const value = pick(day);
        if (value === null) continue;
        const z = robustZ(value, values);
        if (!z) continue;
        tested = true;
        minP = Math.min(minP, 2 * (1 - normalCdf(Math.abs(z.z))));
        const relative = z.median === 0 ? Number.POSITIVE_INFINITY : Math.abs(value / z.median - 1);
        if (
          Math.abs(z.z) >= p.threshold &&
          relative >= p.minRelativeChange &&
          (!worst || Math.abs(z.z) > Math.abs(worst.z))
        )
          worst = { metric, value, z: z.z, median: z.median, n: values.length };
      }
      if (!tested) return insufficient(`menos de ${p.minHistoryDays} días de historia con valor`);
      if (!worst) return notWith(minP);
      const pValue = 2 * (1 - normalCdf(Math.abs(worst.z)));
      const fmt = (v: number) => (worst?.metric === 'linkCtr' ? pct(v, 2) : money(v, env.currency));
      return {
        status: 'triggered',
        severity: 'medium',
        confidence: 1 - pValue,
        pValue,
        metrics: {
          metric: worst.metric,
          value: worst.value,
          historyMedian: worst.median,
          robustZ: worst.z,
        },
        reference: {
          metric: `mediana de ${label[worst.metric]}`,
          value: worst.median,
          source: 'baseline',
          n: worst.n,
        },
        threshold: { robustZ: p.threshold, minRelativeChange: p.minRelativeChange },
        sample: { historyDays: worst.n },
        window: { since: asOf, until: asOf },
        explanation: `${capitalize(label[worst.metric] ?? worst.metric)} de ayer (${fmt(worst.value)}) se aparta de lo habitual (mediana de ${worst.n} días: ${fmt(worst.median)}; z robusta ${worst.z.toFixed(1)}). Revisa el registro de actividad de esos días.`,
        impact: null,
        recommendation: {
          key: 'review_activity_log',
          text: 'Revisar los cambios recientes (presupuestos, pujas, creatividades) en el registro de actividad.',
        },
      };
    },
  }),

  defineRule({
    id: 'R-DATA-015',
    version: 1,
    category: 'data',
    title: 'Calidad de los datos',
    description:
      'Relaciones imposibles entre métricas o días sin datos en una cuenta que se sincroniza.',
    method:
      'Determinista: alcance > impresiones, clics > impresiones o clics en el enlace > clics; días de la ventana sin fila con historia de gasto.',
    minSample: '— (determinista)',
    levels: ['account'],
    profiles: 'all',
    statistical: false,
    params: z.object({ minBaselineActiveShare: prob.default(0.5) }),
    evaluate(c, p, env) {
      const inEval = c.days.filter((d) => inWindow(d, env.win.evaluation));
      const impossible = inEval.filter(
        (d) => d.reach > d.impressions || d.clicks > d.impressions || d.inlineLinkClicks > d.clicks,
      );
      const expectedDays = env.config.windows.evaluationDays;
      const baselineShare = c.base.activeDays / env.config.windows.baselineDays;
      const missing = baselineShare >= p.minBaselineActiveShare ? expectedDays - inEval.length : 0;
      if (impossible.length === 0 && missing <= 0) return NOT;
      return {
        status: 'triggered',
        severity: missing > 0 ? 'medium' : 'low',
        confidence: 1,
        metrics: {
          impossibleDays: impossible.length,
          missingDays: Math.max(0, missing),
          firstImpossibleDay: impossible[0]?.date ?? null,
        },
        sample: { days: expectedDays },
        window: env.win.evaluation,
        explanation: [
          impossible.length
            ? `${impossible.length} días con relaciones imposibles (p. ej. alcance mayor que las impresiones)`
            : null,
          missing > 0
            ? `${missing} días sin datos pese a que la cuenta suele entregar a diario`
            : null,
        ]
          .filter(Boolean)
          .join(' y ')
          .replace(/^./, (s) => s.toUpperCase())
          .concat('. Las cifras de esos días no son fiables hasta revisar la ingesta.'),
        impact: null,
        recommendation: {
          key: 'review_ingestion',
          text: 'Interno: revisar la sincronización y reprocesar los días afectados.',
        },
      };
    },
  }),
];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Parámetros efectivos de una regla: los por defecto con las sobrescrituras validadas. */
export function ruleParams(
  rule: RuleDef,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return rule.params.parse(override ?? {}) as Record<string, unknown>;
}

/** Aplica a un nivel y perfil. */
export const appliesTo = (rule: RuleDef, c: EntityContext) =>
  rule.levels.includes(c.level) &&
  (rule.profiles === 'all' || rule.profiles.includes(c.profile) || c.level === 'account');

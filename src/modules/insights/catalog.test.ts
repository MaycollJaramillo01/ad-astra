import { describe, expect, it } from 'vitest';
import {
  attributionLabel,
  change,
  changeTone,
  comparisonRange,
  compute,
  deliveryStatus,
  emptyTotals,
  METRIC_IDS,
  METRICS,
  type MetricContext,
  type MetricId,
  resolvePreset,
  resultLabel,
  safeDiv,
  sumTotals,
  type Totals,
} from './catalog.ts';

const totals = (t: Partial<Totals>): Totals => ({ ...emptyTotals(), ...t });
const ONE_DAY: MetricContext = { days: 1, reachSources: 1, resultTypes: 1, immature: false };

// Valor de referencia de cada métrica (CA-F2-01): una métrica sin fila aquí hace fallar el test.
const T = totals({
  spend: 200,
  impressions: 40_000,
  reach: 25_000,
  clicks: 800,
  inlineLinkClicks: 500,
  outboundClicks: 450,
  results: 40,
  leads: 20,
  purchases: 8,
  purchaseValue: 1000,
  messagingConversations: 25,
  appInstalls: 10,
  landingPageViews: 400,
  thruplays: 2000,
});
const GOLDEN: Record<MetricId, number> = {
  spend: 200,
  impressions: 40_000,
  reach: 25_000,
  frequency: 1.6,
  cpm: 5,
  clicks: 800,
  ctr: 0.02,
  linkClicks: 500,
  linkCtr: 0.0125,
  cpc: 0.4,
  outboundClicks: 450,
  landingPageViews: 400,
  costPerLandingPageView: 0.5,
  results: 40,
  costPerResult: 5,
  leads: 20,
  costPerLead: 10,
  messagingConversations: 25,
  costPerConversation: 8,
  purchases: 8,
  costPerPurchase: 25,
  purchaseValue: 1000,
  roas: 5,
  appInstalls: 10,
  costPerInstall: 20,
  thruplays: 2000,
  costPerThruplay: 0.1,
};

describe('catálogo de métricas', () => {
  it('cada métrica tiene definición, fórmula, origen y un valor de referencia', () => {
    for (const id of METRIC_IDS) {
      const m = METRICS[id];
      expect(m.label, id).toBeTruthy();
      expect(m.definition.length, id).toBeGreaterThan(10);
      expect(m.formula, id).toBeTruthy();
      expect(m.metaFields.length, id).toBeGreaterThan(0);
      expect(GOLDEN[id], `falta el valor de referencia de ${id}`).toBeDefined();
      expect(compute(id, T, ONE_DAY).value, id).toBeCloseTo(GOLDEN[id], 10);
    }
  });

  it('los ratios son ratios de sumas, no promedios de ratios', () => {
    // Día 1: CPM 100 (100 de gasto, 1000 impresiones); día 2: CPM 0,11 (1 de gasto, 9000).
    const days = [
      totals({ spend: 100, impressions: 1000 }),
      totals({ spend: 1, impressions: 9000 }),
    ];
    expect(compute('cpm', sumTotals(days), { ...ONE_DAY, days: 2 }).value).toBeCloseTo(10.1); // la media daría 50,06
  });

  it('dividir entre cero da "no disponible" con el motivo, nunca 0 ni infinito', () => {
    expect(safeDiv(10, 0, 'impresiones')).toEqual({
      value: null,
      state: 'unavailable',
      reason: 'sin impresiones',
    });
    const v = compute('costPerResult', totals({ spend: 50, results: 0 }), ONE_DAY);
    expect(v).toMatchObject({ value: null, state: 'unavailable', reason: 'sin resultados' });
    expect(compute('cpm', totals({ spend: 0, impressions: 1000 }), ONE_DAY).value).toBe(0); // cero real
  });

  it('null es no disponible y 0 es un cero informado', () => {
    expect(compute('spend', emptyTotals(), ONE_DAY)).toMatchObject({
      value: null,
      state: 'unavailable',
    });
    expect(compute('spend', totals({ spend: 0 }), ONE_DAY)).toMatchObject({
      value: 0,
      state: 'available',
    });
    expect(sumTotals([emptyTotals(), emptyTotals()]).spend).toBeNull();
    expect(sumTotals([totals({ spend: 0 }), emptyTotals()]).spend).toBe(0);
  });

  it('el alcance de un rango nunca se calcula sumando días ni fuentes (CA-F2-04)', () => {
    const t = totals({ reach: 900, impressions: 1800 });
    expect(compute('reach', t, ONE_DAY)).toMatchObject({ value: 900, state: 'estimated' });
    expect(compute('reach', t, { ...ONE_DAY, days: 7 })).toMatchObject({
      value: null,
      state: 'unavailable',
      reason: 'el alcance no se suma entre días',
    });
    expect(compute('frequency', t, { ...ONE_DAY, reachSources: 3 }).value).toBeNull();
  });

  it('varios tipos de resultado no se suman', () => {
    const t = totals({ spend: 10, results: 7 });
    expect(compute('results', t, { ...ONE_DAY, resultTypes: 2 })).toMatchObject({
      value: null,
      state: 'unavailable',
    });
    expect(compute('costPerResult', t, { ...ONE_DAY, resultTypes: 2 }).value).toBeNull();
    expect(compute('results', t, ONE_DAY).value).toBe(7);
  });

  it('marca las conversiones en maduración y el ROAS sin valor de compra como no aplicable', () => {
    const t = totals({ spend: 10, leads: 2, impressions: 100, purchases: 0, purchaseValue: 0 });
    const immature = { ...ONE_DAY, immature: true };
    expect(compute('leads', t, immature).state).toBe('immature');
    expect(compute('impressions', t, immature).state).toBe('available');
    expect(compute('roas', t, ONE_DAY)).toMatchObject({ value: null, state: 'not_applicable' });
  });

  it('variación y su lectura según la dirección buena de la métrica', () => {
    expect(change(120, 100)).toBeCloseTo(0.2);
    expect(change(5, 0)).toBeNull();
    expect(change(null, 3)).toBeNull();
    expect(changeTone('cpm', 0.2)).toBe('bad');
    expect(changeTone('results', 0.2)).toBe('good');
    expect(changeTone('spend', 0.2)).toBe('neutral');
  });
});

describe('fechas', () => {
  it('los presets siguen la semántica de Meta ("últimos N días" acaba ayer)', () => {
    expect(resolvePreset('last_7d', '2026-10-24')).toEqual({
      since: '2026-10-17',
      until: '2026-10-23',
    });
    expect(resolvePreset('today', '2026-10-24')).toEqual({
      since: '2026-10-24',
      until: '2026-10-24',
    });
    expect(resolvePreset('this_month', '2026-10-24')).toEqual({
      since: '2026-10-01',
      until: '2026-10-24',
    });
    expect(resolvePreset('last_month', '2026-03-15')).toEqual({
      since: '2026-02-01',
      until: '2026-02-28',
    });
  });

  it('comparación con el periodo anterior y con el año anterior', () => {
    const r = { since: '2026-10-17', until: '2026-10-23' };
    expect(comparisonRange(r, 'previous')).toEqual({ since: '2026-10-10', until: '2026-10-16' });
    expect(comparisonRange(r, 'year')).toEqual({ since: '2025-10-17', until: '2025-10-23' });
    expect(comparisonRange({ since: '2028-02-29', until: '2028-02-29' }, 'year')).toEqual({
      since: '2027-02-28',
      until: '2027-02-28',
    });
    expect(comparisonRange(r, 'none')).toBeNull();
  });
});

describe('etiquetas', () => {
  it('traduce tipos de resultado, ventanas de atribución y estados de entrega', () => {
    expect(resultLabel('actions:onsite_conversion.messaging_conversation_started_7d')).toBe(
      'Conversaciones iniciadas',
    );
    expect(resultLabel('actions:algo_nuevo')).toBe('algo nuevo');
    expect(attributionLabel('1d_view_7d_click')).toBe(
      '7 días tras clic y 1 día tras visualización',
    );
    expect(attributionLabel('multiple')).toMatch(/Varias/);
    expect(deliveryStatus('ACTIVE', { learning: 'LEARNING' })).toEqual({
      label: 'En aprendizaje',
      tone: 'warning',
    });
    expect(deliveryStatus('DISAPPROVED').tone).toBe('critical');
    expect(deliveryStatus('ACTIVE', { deleted: true }).label).toBe('Ya no aparece en Meta');
  });
});

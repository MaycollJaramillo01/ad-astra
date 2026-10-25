import { describe, expect, it } from 'vitest';
import {
  type Answer,
  type EvidenceRecord,
  parseNumbers,
  priorityOf,
  verifyAnswer,
} from './answer.ts';

// Verificador determinista de respuestas: cifras en formato español o inglés, evidencia citada,
// entidades, suficiencia y lenguaje.

const E1: EvidenceRecord = {
  id: 'E1',
  tool: 'get_metrics',
  sufficiency: 'sufficient',
  output: {
    data: {
      node: { id: 'acc-1', name: 'Cuenta' },
      period: { since: '2026-10-07', until: '2026-10-13' },
      metrics: [
        { id: 'spend', value: 1234.56, previous: 1000, delta: 234.56, changePct: 23.5 },
        { id: 'linkCtr', value: 1.27, previous: 1.5, changePct: -15.3 },
        { id: 'costPerResult', value: 12.35, previous: 10.2, changePct: 21.1 },
      ],
      children: { rows: [{ id: '120000000001', name: 'Campaña A' }] },
    },
  },
};
const E2: EvidenceRecord = {
  id: 'E2',
  tool: 'get_findings',
  sufficiency: 'insufficient',
  output: { data: { findings: [{ id: 'f-1', ruleId: 'R-EFF-001', confidence: 0.82 }] } },
};

const base = (patch: Partial<Answer> = {}): Answer => ({
  summary: 'El gasto subió un 23,5 % frente al periodo anterior.',
  dataSufficiency: { status: 'sufficient', reasons: [] },
  claims: [
    {
      text: 'El gasto fue de 1.234,56 USD (+234,56) y el CTR de enlace bajó al 1,27 %.',
      evidenceIds: ['E1'],
      figures: [{ label: 'Gasto', value: 1234.56, unit: 'currency', evidenceId: 'E1' }],
    },
  ],
  hypotheses: [],
  recommendations: [],
  followUpQuestions: [],
  ...patch,
});

const rec = (
  patch: Partial<Answer['recommendations'][number]> = {},
): Answer['recommendations'][number] => ({
  title: 'Revisar la campaña A',
  rationale: 'El costo por resultado subió un 21,1 % hasta 12,35 USD.',
  evidenceIds: ['E1'],
  figures: [{ label: 'Costo por resultado', value: 12.35, unit: 'currency', evidenceId: 'E1' }],
  expectedImpact: {
    hypothesis: 'Podría bajar el costo por resultado.',
    metric: 'costPerResult',
    direction: 'decrease',
    magnitude: 'medium',
  },
  confidence: { level: 'medium', rationale: 'Una semana de datos.' },
  dependencies: [],
  risk: { level: 'low', description: 'Menor entrega mientras se revisa.' },
  action: {
    type: 'review',
    entityLevel: 'campaign',
    entityId: '120000000001',
    description: 'Revisar la segmentación.',
    amount: null,
  },
  relatedFindingIds: [],
  ...patch,
});

const codes = (a: Answer, ev = [E1, E2]) => verifyAnswer(a, ev).issues.map((i) => i.code);

describe('lectura de cifras', () => {
  it('entiende separadores españoles e ingleses, sufijos de escala y porcentajes', () => {
    const [a, b, c, d, e] = parseNumbers('1.234,56 · 1,234.56 · 12,5 % · 1,2 mil · 3 campañas');
    expect(a?.value).toBe(1234.56);
    expect(b?.value).toBe(1234.56);
    expect(c).toMatchObject({ value: 12.5, percent: true });
    expect(d).toMatchObject({ value: 1.2, scale: 1000 });
    expect(e).toMatchObject({ value: 3, exempt: true });
    // Ambiguo: "1.234" puede ser mil doscientos o uno coma dos.
    expect(parseNumbers('1.234')[0]?.candidates.map((x) => x.value)).toEqual([1.234, 1234]);
    // Partes de identificadores no son cifras.
    expect(parseNumbers('E12 y act_123')).toEqual([]);
  });
});

describe('verificación', () => {
  it('acepta una respuesta fiel, con cifras redondeadas y en formato español', () => {
    const v = verifyAnswer(base({ recommendations: [rec()] }), [E1, E2]);
    expect(v.issues).toEqual([]);
    expect(v).toMatchObject({ status: 'verified', figures: { checked: 2, verified: 2 } });
  });

  it('rechaza cifras inventadas en el texto y en figures', () => {
    expect(codes(base({ summary: 'El gasto subió un 40 %.' }))).toEqual(['untraceable_number']);
    const fig = base();
    fig.claims[0]!.figures[0]!.value = 999.99;
    expect(codes(fig)).toEqual(['untraceable_figure']);
    // Una cifra que sí existe, pero en otra evidencia, no vale para esta afirmación.
    const other = base();
    other.claims[0]!.text = 'La confianza del hallazgo es 0,82.';
    expect(codes(other)).toEqual(['untraceable_number']);
  });

  it('rechaza evidencia, entidades, hallazgos e identificadores que no existen', () => {
    expect(
      codes(base({ claims: [{ text: 'Sin datos.', evidenceIds: ['E9'], figures: [] }] })),
    ).toEqual(['unknown_evidence']);
    expect(codes(base({ claims: [{ text: 'Sin cita.', evidenceIds: [], figures: [] }] }))).toEqual([
      'missing_evidence',
    ]);
    expect(
      codes(base({ recommendations: [rec({ action: { ...rec().action, entityId: '999' } })] })),
    ).toEqual(['unknown_entity']);
    expect(codes(base({ recommendations: [rec({ relatedFindingIds: ['f-x'] })] }))).toEqual([
      'unknown_finding',
    ]);
    expect(codes(base({ summary: 'Desde el 2026-09-01 empeoró.' }))).toEqual([
      'unknown_identifier',
    ]);
    expect(
      codes(base({ summary: 'Del 2026-10-07 al 2026-10-13 el gasto subió un 23,5 %.' })),
    ).toEqual([]);
  });

  it('sin ninguna consulta no hay afirmaciones válidas', () => {
    expect(codes(base(), [])).toContain('no_evidence');
  });

  it('la suficiencia declarada no puede ser mejor que la de la evidencia citada', () => {
    const a = base({
      claims: [{ text: 'Hay un hallazgo abierto.', evidenceIds: ['E2'], figures: [] }],
    });
    expect(codes(a)).toEqual(['sufficiency_overstated']);
    expect(
      codes({ ...a, dataSufficiency: { status: 'insufficient', reasons: ['pocos datos'] } }),
    ).toEqual([]);
  });

  it('con datos insuficientes solo caben acciones de revisión', () => {
    const pause = rec({ action: { ...rec().action, type: 'pause' } });
    const a = base({
      dataSufficiency: { status: 'insufficient', reasons: ['x'] },
      recommendations: [pause],
    });
    expect(codes(a)).toContain('action_on_insufficient_data');
    expect(codes({ ...a, recommendations: [rec()] })).not.toContain('action_on_insufficient_data');
  });

  it('el importe propuesto en una acción de presupuesto no cuenta como cifra inventada', () => {
    const budget = rec({
      action: {
        ...rec().action,
        type: 'set_daily_budget',
        description: 'Subir el presupuesto diario a 50 USD.',
        amount: 50,
      },
    });
    expect(codes(base({ recommendations: [budget] }))).toEqual([]);
  });

  it('exige lenguaje probabilístico: sin garantías, causas como hecho ni impacto afirmado', () => {
    expect(codes(base({ summary: 'Esto garantiza más ventas.' }))).toEqual(['certainty_language']);
    const causal = base();
    causal.claims[0]!.text = 'El gasto subió un 23,5 % debido a la subasta.';
    expect(codes(causal)).toEqual(['causal_claim']);
    causal.claims[0]!.text = 'El gasto subió un 23,5 %, probablemente debido a la subasta.';
    expect(codes(causal)).toEqual([]);
    const firm = rec({
      expectedImpact: { ...rec().expectedImpact, hypothesis: 'Bajará el costo.' },
    });
    expect(codes(base({ recommendations: [firm] }))).toEqual(['impact_not_hypothesis']);
  });

  it('la prioridad combina confianza, magnitud del impacto y riesgo', () => {
    const top = rec({
      confidence: { level: 'high', rationale: '' },
      expectedImpact: { ...rec().expectedImpact, magnitude: 'high' },
    });
    expect(priorityOf(top)).toBe(1);
    expect(priorityOf(rec())).toBeCloseTo((0.7 * 2 * 1) / 2.7, 3);
    expect(priorityOf(rec({ risk: { level: 'high', description: '' } }))).toBeLessThan(
      priorityOf(rec()),
    );
  });
});

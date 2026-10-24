import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, runAudit } from '../src/modules/audit/engine.ts';
import { combine, normalize } from '../src/modules/audit/health.ts';
import {
  type AuditConfigPatch,
  DEFAULT_CONFIG,
  mergeConfig,
  profileOf,
} from '../src/modules/audit/model.ts';
import { RULES } from '../src/modules/audit/rules.ts';
import {
  AS_OF,
  auditInput,
  entity,
  inEvaluation,
  leadsDay,
  poissonSample,
  rng,
  series,
  stack,
} from './audit-fixtures.ts';

// Motor de auditoría con datos sintéticos de parámetros conocidos (sin BD).

const run = (
  entities: Parameters<typeof auditInput>[0],
  patch?: AuditConfigPatch,
  accountDays?: Parameters<typeof auditInput>[1],
) => runAudit(auditInput(entities, accountDays), mergeConfig(patch));
type Result = ReturnType<typeof run>;
const status = (r: Result, ruleId: string, level: string, id: string) =>
  r.evaluations.find((e) => e.ruleId === ruleId && e.level === level && e.entityId === id)?.status;
const finding = (r: Result, ruleId: string, level: string, id: string) =>
  r.findings.find((f) => f.ruleId === ruleId && f.level === level && f.entityId === id);

/** Leads: línea base a `base` (gasto, leads) por día y evaluación a `now`. */
const leads = (
  id: string,
  base: [number, number],
  now: [number, number],
  extra: Parameters<typeof stack>[2] = {},
) =>
  stack(
    id,
    series(35, (back) =>
      inEvaluation(back) ? leadsDay(now[0], now[1]) : leadsDay(base[0], base[1]),
    ),
    extra,
  );

const sales = (id: string, base: [number, number, number], now: [number, number, number]) =>
  stack(
    id,
    series(35, (back) => {
      const [spend, purchases, value] = inEvaluation(back) ? now : base;
      return {
        ...leadsDay(spend, 0),
        purchases,
        purchaseValue: value,
        results: purchases,
        resultIndicator: 'actions:omni_purchase',
        leads: 0,
      };
    }),
    { objective: 'OUTCOME_SALES', goal: 'OFFSITE_CONVERSIONS', event: 'PURCHASE' },
  );

const traffic = (
  id: string,
  fn: (back: number) => { impressions: number; reach: number; link: number },
) =>
  stack(
    id,
    series(35, (back) => {
      const v = fn(back);
      return {
        spend: 50,
        impressions: v.impressions,
        reach: v.reach,
        clicks: v.link * 2,
        inlineLinkClicks: v.link,
        results: v.link,
        resultIndicator: 'actions:link_click',
      };
    }),
    { objective: 'OUTCOME_TRAFFIC', goal: 'LINK_CLICKS' },
  );

describe('cada regla: dispara, no dispara y datos insuficientes (CA-F3-01)', () => {
  it('R-EFF-001 costo por evento por encima de la referencia', () => {
    const r = run([
      ...leads('1', [100, 10], [100, 4]),
      ...leads('2', [100, 10], [100, 10]),
      ...stack(
        '3',
        series(7, () => leadsDay(100, 4)),
      ),
    ]);
    expect(status(r, 'R-EFF-001', 'campaign', '10')).toBe('triggered');
    expect(status(r, 'R-EFF-001', 'campaign', '20')).toBe('not_triggered');
    expect(status(r, 'R-EFF-001', 'campaign', '30')).toBe('insufficient_data'); // sin historia ni objetivo
    const f = finding(r, 'R-EFF-001', 'campaign', '10');
    expect(f?.evidence.reference).toMatchObject({ value: 10, source: 'baseline', n: 280 });
    expect(f?.evidence.metrics.estimatedCost).toBeGreaterThan(20);
    expect(f?.impact).toMatchObject({ metric: 'excess_spend', value: 240 }); // 400 − 16 × 10
    expect(f?.explanation).toMatch(/costo por cliente potencial estimado es 21\.43 USD/);
  });

  it('R-EFF-002 gasto sin eventos clave', () => {
    const r = run([
      ...leads('1', [100, 10], [100, 0]),
      ...leads('2', [100, 10], [100, 5]),
      ...leads('3', [100, 10], [2, 0]),
    ]);
    expect(status(r, 'R-EFF-002', 'adset', '11')).toBe('triggered');
    expect(status(r, 'R-EFF-002', 'adset', '21')).toBe('not_triggered');
    expect(status(r, 'R-EFF-002', 'adset', '31')).toBe('insufficient_data');
    expect(finding(r, 'R-EFF-002', 'adset', '11')?.evidence.metrics).toMatchObject({
      spend: 400,
      events: 0,
      expectedEvents: 40,
    });
  });

  it('R-PERF-003 eventos por debajo de lo esperado', () => {
    const sparse = stack(
      '3',
      series(35, (back) =>
        inEvaluation(back) ? leadsDay(100, 10) : leadsDay(100, back % 4 === 0 ? 1 : 0),
      ),
    );
    const r = run([
      ...leads('1', [100, 10], [100, 3]),
      ...leads('2', [100, 10], [100, 10]),
      ...sparse,
    ]);
    expect(status(r, 'R-PERF-003', 'campaign', '10')).toBe('triggered');
    expect(status(r, 'R-PERF-003', 'campaign', '20')).toBe('not_triggered');
    expect(status(r, 'R-PERF-003', 'campaign', '30')).toBe('insufficient_data');
    expect(finding(r, 'R-PERF-003', 'campaign', '10')?.evidence.metrics).toMatchObject({
      observed: 12,
      expected: 40,
    });
  });

  it('R-EFF-004 ROAS por debajo de la referencia', () => {
    const r = run([
      ...sales('1', [100, 4, 400], [100, 2, 150]),
      ...sales('2', [100, 4, 400], [100, 4, 400]),
      ...sales('3', [100, 0, 0], [100, 2, 150]),
    ]);
    expect(status(r, 'R-EFF-004', 'campaign', '10')).toBe('triggered');
    expect(status(r, 'R-EFF-004', 'campaign', '20')).toBe('not_triggered');
    expect(status(r, 'R-EFF-004', 'campaign', '30')).toBe('insufficient_data');
    expect(finding(r, 'R-EFF-004', 'campaign', '10')?.evidence.reference).toMatchObject({
      metric: 'ROAS',
      value: 4,
    });
  });

  it('R-RATE-005 caída del CTR del enlace', () => {
    const r = run([
      ...traffic('1', (b) => ({ impressions: 2000, reach: 1500, link: inEvaluation(b) ? 20 : 40 })),
      ...traffic('2', () => ({ impressions: 2000, reach: 1500, link: 40 })),
      ...traffic('3', () => ({ impressions: 100, reach: 80, link: 2 })),
    ]);
    expect(status(r, 'R-RATE-005', 'ad', '12')).toBe('triggered');
    expect(status(r, 'R-RATE-005', 'ad', '22')).toBe('not_triggered');
    expect(status(r, 'R-RATE-005', 'ad', '32')).toBe('insufficient_data');
  });

  it('R-STAB-006 costo diario inestable (umbral relativo a la cuenta)', () => {
    const stable = (id: string) =>
      stack(
        id,
        series(35, () => leadsDay(200, 20)),
      );
    const volatile = stack(
      '4',
      series(35, (back) => leadsDay(back % 2 ? 40 : 360, 20)),
    );
    const r = run([...stable('1'), ...stable('2'), ...stable('3'), ...volatile]);
    expect(status(r, 'R-STAB-006', 'campaign', '40')).toBe('triggered');
    expect(status(r, 'R-STAB-006', 'campaign', '10')).toBe('not_triggered');
    expect(status(run(volatile), 'R-STAB-006', 'campaign', '40')).toBe('insufficient_data'); // sin comparables
  });

  it('R-FAT-007 fatiga creativa', () => {
    const r = run([
      ...traffic('1', (b) =>
        inEvaluation(b)
          ? { impressions: 5000, reach: 2500, link: 50 }
          : { impressions: 5000, reach: 4000, link: 100 },
      ),
      ...traffic('2', () => ({ impressions: 5000, reach: 4000, link: 100 })),
      ...traffic('3', () => ({ impressions: 100, reach: 90, link: 2 })),
    ]);
    expect(status(r, 'R-FAT-007', 'ad', '12')).toBe('triggered');
    expect(status(r, 'R-FAT-007', 'ad', '22')).toBe('not_triggered');
    expect(status(r, 'R-FAT-007', 'ad', '32')).toBe('insufficient_data');
    expect(finding(r, 'R-FAT-007', 'ad', '12')?.evidence.metrics).toMatchObject({
      frequencyBefore: 1.25,
      frequencyNow: 2,
    });
  });

  it('R-DEL-008 activo sin entrega (determinista: no aplica si está en pausa)', () => {
    const silent = series(35, (back) => (back < 2 ? null : leadsDay(100, 10)));
    const r = run([
      ...stack('1', silent),
      ...stack(
        '2',
        series(35, () => leadsDay(100, 10)),
      ),
      ...stack('3', silent, { ad: { status: 'PAUSED' } }),
    ]);
    expect(status(r, 'R-DEL-008', 'ad', '12')).toBe('triggered');
    expect(status(r, 'R-DEL-008', 'ad', '22')).toBe('not_triggered');
    expect(status(r, 'R-DEL-008', 'ad', '32')).toBe('not_triggered');
    expect(finding(r, 'R-DEL-008', 'ad', '12')).toMatchObject({ severity: 'high', confidence: 1 });
  });

  it('R-DEL-009 límite de puja por debajo del costo real', () => {
    const r = run([
      ...stack(
        '1',
        series(35, () => leadsDay(100, 10)),
        { adset: { bidStrategy: 'COST_CAP', bidAmount: 5 } },
      ),
      ...stack(
        '2',
        series(35, () => leadsDay(100, 10)),
        { adset: { bidStrategy: 'COST_CAP', bidAmount: 50 } },
      ),
      ...stack(
        '3',
        series(35, (b) => leadsDay(100, b === 3 ? 1 : 0)),
        { adset: { bidStrategy: 'COST_CAP', bidAmount: 5 } },
      ),
    ]);
    expect(status(r, 'R-DEL-009', 'adset', '11')).toBe('triggered');
    expect(status(r, 'R-DEL-009', 'adset', '21')).toBe('not_triggered');
    expect(status(r, 'R-DEL-009', 'adset', '31')).toBe('insufficient_data');
  });

  it('R-DEL-010 aprendizaje limitado (informado por Meta o proyectado)', () => {
    const days = series(35, () => leadsDay(100, 10));
    const r = run([
      ...stack('1', days, { adset: { learning: 'FAIL' } }),
      ...stack('2', days, { adset: { learning: 'SUCCESS', dailyBudget: 1000 } }),
      ...stack('3', days, { adset: { dailyBudget: 20 } }), // 20 × 7 ÷ 10 = 14 leads por semana < 50
    ]);
    expect(status(r, 'R-DEL-010', 'adset', '11')).toBe('triggered');
    expect(status(r, 'R-DEL-010', 'adset', '21')).toBe('not_triggered');
    expect(finding(r, 'R-DEL-010', 'adset', '31')?.evidence.metrics.projectedWeeklyEvents).toBe(14);
  });

  it('R-STR-011 estructura fragmentada', () => {
    const adsets = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) =>
        entity('adset', `${prefix}${i}`, {
          parentId: `${prefix}c`,
          campaignId: `${prefix}c`,
          optimizationGoal: 'LEAD_GENERATION',
          days: series(35, () => leadsDay(20, 2)),
        }),
      );
    const campaign = (prefix: string, n: number) =>
      entity('campaign', `${prefix}c`, {
        objective: 'OUTCOME_LEADS',
        days: series(35, () => leadsDay(20 * n, 2 * n)),
      });
    const r = run([campaign('a', 3), ...adsets(3, 'a'), campaign('b', 2), ...adsets(2, 'b')]);
    expect(status(r, 'R-STR-011', 'campaign', 'ac')).toBe('triggered');
    expect(status(r, 'R-STR-011', 'campaign', 'bc')).toBe('not_triggered');
  });

  it('R-ATT-012 ventanas de atribución distintas', () => {
    const mk = (prefix: string, attributions: string[]) => [
      entity('campaign', `${prefix}c`, {
        objective: 'OUTCOME_LEADS',
        days: series(35, () => leadsDay(100, 10)),
      }),
      ...attributions.map((a, i) =>
        entity('adset', `${prefix}${i}`, {
          parentId: `${prefix}c`,
          campaignId: `${prefix}c`,
          days: series(35, () => leadsDay(50, 5, { attribution: a })),
        }),
      ),
    ];
    const r = run([
      ...mk('a', ['7d_click_1d_view', '1d_click']),
      ...mk('b', ['7d_click_1d_view', '7d_click_1d_view']),
    ]);
    expect(status(r, 'R-ATT-012', 'campaign', 'ac')).toBe('triggered');
    expect(status(r, 'R-ATT-012', 'campaign', 'bc')).toBe('not_triggered');
  });

  it('R-TRK-013 posible fallo de seguimiento', () => {
    const r = run([
      ...leads('1', [100, 10], [100, 0]),
      ...leads('2', [100, 10], [100, 10]),
      ...leads('3', [100, 10], [10, 0]),
    ]);
    expect(status(r, 'R-TRK-013', 'campaign', '10')).toBe('triggered');
    expect(status(r, 'R-TRK-013', 'campaign', '20')).toBe('not_triggered');
    expect(status(r, 'R-TRK-013', 'campaign', '30')).toBe('insufficient_data');
    expect(finding(r, 'R-TRK-013', 'campaign', '10')?.severity).toBe('critical'); // todo el gasto, sin medir
  });

  it('R-CHG-014 cambio brusco (z robusta)', () => {
    const acc = (last: number, n = 30) =>
      series(n, (back) =>
        back === 0
          ? {
              spend: last,
              impressions: last * 100,
              reach: last * 80,
              inlineLinkClicks: last,
              clicks: last * 2,
            }
          : {
              spend: 100 + (back % 5),
              impressions: 10_000 + (back % 3) * 50,
              reach: 8000,
              inlineLinkClicks: 100,
              clicks: 200,
            },
      );
    expect(status(run([], undefined, acc(400)), 'R-CHG-014', 'account', 'act_1')).toBe('triggered');
    expect(status(run([], undefined, acc(102)), 'R-CHG-014', 'account', 'act_1')).toBe(
      'not_triggered',
    );
    expect(status(run([], undefined, acc(400, 6)), 'R-CHG-014', 'account', 'act_1')).toBe(
      'insufficient_data',
    );
    const f = finding(run([], undefined, acc(400)), 'R-CHG-014', 'account', 'act_1');
    expect(f?.evidence.metrics).toMatchObject({ metric: 'spend', value: 400 });
  });

  it('R-CHG-014 no marca una campaña en pausa ni cuenta días anteriores a la primera entrega', () => {
    // Pausada hace 10 días: gastar 0 ayer es lo esperado (falso positivo visto con datos demo).
    const paused = stack(
      '5',
      series(30, (b) => (b < 10 ? null : leadsDay(100, 10))),
      {
        campaign: { status: 'PAUSED' },
      },
    );
    // Nueva hace 9 días: su historia son 8 días, no 28 con ceros.
    const fresh = stack(
      '6',
      series(30, (b) => (b > 8 ? null : leadsDay(100, 10))),
    );
    const r = run([...paused, ...fresh]);
    expect(status(r, 'R-CHG-014', 'campaign', '50')).toBe('not_triggered');
    expect(status(r, 'R-CHG-014', 'campaign', '60')).toBe('insufficient_data');
  });

  it('R-DATA-015 calidad de los datos', () => {
    const clean = series(35, () => leadsDay(100, 10));
    const broken = clean.map((d) => (d.date === AS_OF ? { ...d, reach: d.impressions + 1 } : d));
    const gaps = clean.filter((d) => d.date !== AS_OF && d.date !== '2026-10-19');
    expect(status(run([], undefined, broken), 'R-DATA-015', 'account', 'act_1')).toBe('triggered');
    expect(status(run([], undefined, clean), 'R-DATA-015', 'account', 'act_1')).toBe(
      'not_triggered',
    );
    expect(
      finding(run([], undefined, gaps), 'R-DATA-015', 'account', 'act_1')?.evidence.metrics
        .missingDays,
    ).toBe(2);
  });

  it('todas las reglas del catálogo tienen un caso en este archivo', () => {
    const covered = [
      'R-EFF-001',
      'R-EFF-002',
      'R-PERF-003',
      'R-EFF-004',
      'R-RATE-005',
      'R-STAB-006',
      'R-FAT-007',
      'R-DEL-008',
      'R-DEL-009',
      'R-DEL-010',
      'R-STR-011',
      'R-ATT-012',
      'R-TRK-013',
      'R-CHG-014',
      'R-DATA-015',
    ];
    expect(RULES.map((r) => r.id).sort()).toEqual([...covered].sort());
    for (const r of RULES) {
      expect(r.description.length, r.id).toBeGreaterThan(20);
      expect(r.method.length, r.id).toBeGreaterThan(20);
      expect(r.minSample, r.id).toBeTruthy();
    }
  });
});

describe('perfiles por objetivo', () => {
  it('detecta el perfil por objetivo de optimización, evento, tipo de resultado y objetivo', () => {
    expect(profileOf({ optimizationGoal: 'REACH' })).toBe('awareness');
    expect(profileOf({ optimizationGoal: 'LANDING_PAGE_VIEWS' })).toBe('traffic');
    expect(profileOf({ optimizationGoal: 'THRUPLAY' })).toBe('engagement');
    expect(profileOf({ optimizationGoal: 'CONVERSATIONS' })).toBe('messages');
    expect(profileOf({ optimizationGoal: 'OFFSITE_CONVERSIONS', promotedEvent: 'LEAD' })).toBe(
      'leads',
    );
    expect(profileOf({ optimizationGoal: 'OFFSITE_CONVERSIONS', promotedEvent: 'PURCHASE' })).toBe(
      'sales',
    );
    expect(profileOf({ optimizationGoal: 'APP_INSTALLS' })).toBe('app');
    expect(
      profileOf({
        objective: 'OUTCOME_ENGAGEMENT',
        resultTypes: ['actions:onsite_conversion.messaging_conversation_started_7d'],
      }),
    ).toBe('messages');
    expect(profileOf({ objective: 'ALGO_NUEVO' })).toBe('other');
  });

  it('el reconocimiento se evalúa por CPM, no por resultados', () => {
    const awareness = (id: string, cpm: number) =>
      stack(
        id,
        series(35, (b) => ({
          spend: 100,
          impressions: Math.round((100 / (inEvaluation(b) ? cpm : 5)) * 1000),
          reach: 15_000,
        })),
        { objective: 'OUTCOME_AWARENESS', goal: 'REACH' },
      );
    const r = run([...awareness('1', 9), ...awareness('2', 5)]);
    const f = finding(r, 'R-EFF-001', 'campaign', '10');
    expect(f?.profile).toBe('awareness');
    expect(f?.evidence.reference).toMatchObject({ metric: 'CPM', value: 5 });
    expect(status(r, 'R-EFF-001', 'campaign', '20')).toBe('not_triggered');
    expect(status(r, 'R-EFF-002', 'campaign', '10')).toBeUndefined(); // no aplica al reconocimiento
  });
});

describe('salud health-v1 (CA-F3-03)', () => {
  it('en la referencia, la eficiencia vale el centro de la escala (80)', () => {
    const r = run(leads('1', [100, 10], [100, 10]));
    const h = r.health.find((x) => x.level === 'campaign' && x.entityId === '10');
    const eff = h?.components.find((c) => c.id === 'efficiency');
    expect(eff).toMatchObject({ status: 'ok', referenceSource: 'baseline' });
    expect(eff?.s).toBeCloseTo(80, 6);
    expect(normalize(2, DEFAULT_CONFIG.health)).toBe(100); // q = 2 → 120, recortado a 100
    expect(normalize(0.5, DEFAULT_CONFIG.health)).toBe(40);
    expect(normalize(0.25, DEFAULT_CONFIG.health)).toBe(0);
  });

  it('con datos insuficientes da "Datos insuficientes", nunca una puntuación baja', () => {
    const r = run(
      stack(
        '1',
        series(3, () => leadsDay(2, 0)),
      ),
    );
    for (const h of r.health) {
      expect(h.score).toBeNull();
      expect(h.grade).toBe('insufficient');
    }
  });

  it('la puntuación se recalcula igual desde los componentes guardados', () => {
    const r = run([
      ...leads('1', [100, 10], [100, 6]),
      ...leads('2', [100, 10], [100, 10]),
      ...leads('3', [100, 10], [100, 12]),
    ]);
    const stored = JSON.parse(JSON.stringify(r.health)) as typeof r.health;
    for (const h of stored.filter((x) => x.level !== 'account')) {
      expect(combine(h.components, DEFAULT_CONFIG.health.minCoverage).score).toBe(h.score);
    }
    const worse = r.health.find((x) => x.level === 'campaign' && x.entityId === '10');
    const better = r.health.find((x) => x.level === 'campaign' && x.entityId === '30');
    expect(worse?.score).toBeLessThan(better?.score as number);
  });

  it('la cuenta es la media de sus campañas ponderada por gasto', () => {
    const r = run([...leads('1', [100, 10], [300, 30]), ...leads('2', [100, 10], [100, 4])]);
    const camp = (id: string) =>
      r.health.find((x) => x.level === 'campaign' && x.entityId === id)?.score as number;
    const account = r.health.find((x) => x.level === 'account');
    expect(account?.score).toBeCloseTo((camp('10') * 1200 + camp('20') * 400) / 1600, 1);
  });

  it('la estabilidad no se hunde cuando la cuenta es casi perfectamente estable (piso del CV)', () => {
    const stable = (id: string) =>
      stack(
        id,
        series(35, () => leadsDay(200, 20)),
      );
    // Costo diario que alterna 8 y 12 (CV ≈ 0,2): variación moderada, no un caos.
    const moderate = stack(
      '4',
      series(35, (b) => leadsDay(b % 2 ? 160 : 240, 20)),
    );
    const r = run([...stable('1'), ...stable('2'), ...stable('3'), ...moderate]);
    const comp = r.health
      .find((h) => h.level === 'campaign' && h.entityId === '40')
      ?.components.find((c) => c.id === 'stability');
    expect(comp).toMatchObject({ status: 'ok', reference: 0.3, referenceSource: 'parameter' });
    expect(comp?.s).toBeGreaterThan(80); // mejor que el piso
  });

  it('los pesos son configurables por perfil', () => {
    const custom = mergeConfig({
      health: {
        weights: {
          leads: { efficiency: 1, stability: 0, delivery: 0, measurement: 0, fatigue: 0 },
        },
      },
    });
    const r = runAudit(auditInput(leads('1', [100, 10], [100, 10])), custom);
    const h = r.health.find((x) => x.level === 'campaign');
    expect(h?.score).toBeCloseTo(h?.components.find((c) => c.id === 'efficiency')?.s as number, 1);
  });
});

describe('motor', () => {
  it('es determinista: mismas entradas, mismos hallazgos y puntuaciones', () => {
    const entities = [
      ...leads('1', [100, 10], [100, 3]),
      ...sales('2', [100, 4, 400], [100, 2, 150]),
    ];
    const a = run(entities);
    const b = run(structuredClone(entities));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.engineVersion).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toMatch(/^audit-1\.0\.0\+[0-9a-f]{8}$/);
  });

  it('cada hallazgo guarda métricas, explicación, confianza, regla, versión y método', () => {
    const r = run(leads('1', [100, 10], [100, 3]));
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) {
      expect(f.explanation.length).toBeGreaterThan(30);
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.ruleVersion).toBe(1);
      expect(f.evidence.method).toBeTruthy();
      expect(f.evidence.window.since <= f.evidence.window.until).toBe(true);
      expect(Object.keys(f.evidence.metrics).length).toBeGreaterThan(0);
      expect(f.fingerprint).toBe(`${f.ruleId}:${f.level}:${f.entityId}`);
    }
  });

  it('el control de falsos descubrimientos baja a media una severidad alta que no lo supera', () => {
    // Costo de referencia 2,5; 4 días maduros a 2,1875 = 8,75 de gasto → 3,5 leads esperados y 0 logrados:
    // p = e^−3,5 ≈ 0,03 < α = 0,05, pero no supera Benjamini-Hochberg con q = 0,01.
    const entities = stack(
      '1',
      series(35, (b) => (inEvaluation(b) ? leadsDay(2.1875, 0) : leadsDay(100, 40))),
    );
    const strict = run(entities, { fdrQ: 0.01 });
    const f = finding(strict, 'R-EFF-002', 'campaign', '10');
    expect(f?.evidence.fdr).toEqual({ q: 0.01, passed: false });
    expect(f?.severity).toBe('medium');
    expect(strict.stats.downgradedByFdr).toBeGreaterThan(0);
    expect(finding(run(entities, { fdrQ: 0.5 }), 'R-EFF-002', 'campaign', '10')?.severity).toBe(
      'critical',
    );
  });

  it('las reglas se desactivan y sus parámetros se validan por esquema', () => {
    const entities = leads('1', [100, 10], [100, 4]);
    expect(
      run(entities, { rules: { 'R-EFF-001': { enabled: false } } }).evaluations.some(
        (e) => e.ruleId === 'R-EFF-001',
      ),
    ).toBe(false);
    expect(
      status(
        run(entities, { rules: { 'R-EFF-001': { params: { tolerance: 2 } } } }),
        'R-EFF-001',
        'campaign',
        '10',
      ),
    ).toBe('not_triggered');
    expect(() =>
      run(entities, { rules: { 'R-EFF-001': { params: { tolerance: -1 } } } }),
    ).toThrow();
    expect(() => mergeConfig({ windows: { evaluationDays: 1 } })).toThrow();
  });

  it('el objetivo del cliente es la referencia preferida', () => {
    const r = run(leads('1', [100, 10], [100, 10]), {
      targets: [{ profile: 'leads', currency: 'USD', costPerEvent: 5 }],
    });
    expect(finding(r, 'R-EFF-001', 'campaign', '10')?.evidence.reference).toMatchObject({
      value: 5,
      source: 'target',
    });
  });

  it('con datos sin efecto real, R-PERF-003 no supera la tasa nominal de falsos positivos', () => {
    const rand = rng(3);
    const entities = Array.from({ length: 150 }, (_, i) =>
      stack(
        `9${i}`,
        series(35, () => leadsDay(100, poissonSample(10, rand))),
      ),
    ).flat();
    const r = run(entities);
    const evaluated = r.evaluations.filter(
      (e) =>
        e.ruleId === 'R-PERF-003' && e.level === 'campaign' && e.status !== 'insufficient_data',
    );
    const positives = evaluated.filter((e) => e.status === 'triggered').length;
    expect(evaluated.length).toBe(150);
    expect(positives / evaluated.length).toBeLessThanOrEqual(0.05);
  });

  it('una cuenta vacía no rompe nada', () => {
    const r = run([], undefined, []);
    expect(r.findings).toEqual([]);
    expect(r.health[0]).toMatchObject({ level: 'account', score: null, grade: 'insufficient' });
  });
});

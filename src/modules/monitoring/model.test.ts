import { describe, expect, it } from 'vitest';
import { defaultMonitorPolicy } from '../../monitoring-contracts.ts';
import { addDays } from '../insights/catalog.ts';
import {
  buildPlan,
  type Day,
  type Entity,
  evaluatePlan,
  hash,
  inQuietHours,
  metricSignals,
  summarize,
} from './model.ts';

const days = (since: string, n: number, spend = 100, results = 10): Day[] =>
  Array.from({ length: n }, (_, i) => ({
    date: addDays(since, i),
    spend,
    results,
    leads: results,
    purchases: 0,
    attribution: '7d_click',
    indicator: 'lead',
    flags: [],
  }));
const entity = (id: string, history: Day[], family = 'OUTCOME_LEADS'): Entity => ({
  id,
  level: 'campaign',
  name: id,
  family,
  parent: null,
  campaignId: id,
  days: history,
});
describe('monitoreo: condiciones descriptivas y comparabilidad', () => {
  it('conserva la huella al persistir fechas y campos ausentes en JSONB', () => {
    const x = {
      at: new Date('2026-10-01T12:00:00Z'),
      missing: undefined,
      nested: { z: 1, a: [undefined, null] },
    };
    expect(hash(x)).toBe(hash(JSON.parse(JSON.stringify(x))));
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  });
  it('no imputa días ausentes, null, KPI o atribución desconocidos ni promedia CPR diarios', () => {
    expect(summarize(days('2026-10-01', 6), '2026-10-01', '2026-10-07').spend).toBeNull();
    const d = days('2026-10-01', 7);
    d[0]!.spend = null;
    expect(summarize(d, '2026-10-01', '2026-10-07').spend).toBeNull();
    d[0]!.spend = 100;
    d[0]!.results = 1;
    const s = summarize(d, '2026-10-01', '2026-10-07');
    expect(s.cpr).toBe(700 / 61);
    d[0]!.attribution = null;
    expect(summarize(d, '2026-10-01', '2026-10-07').signature).toBeNull();
  });
  it('compara tasas por día, se abstiene si cambia atribución y conserva un cero explícito', () => {
    const p = defaultMonitorPolicy(),
      history = [...days('2026-09-01', 28), ...days('2026-09-29', 7, 100, 1)];
    const signals = metricSignals([entity('a', history)], p, '2026-10-05');
    expect(signals.find((s) => s.ruleId === 'cpr')?.hit).toBeNull(); // insuficientes resultados recientes
    expect(signals.find((s) => s.ruleId === 'results')?.hit).toBe(true);
    history[0]!.attribution = '1d_click';
    expect(
      metricSignals([entity('a', history)], p, '2026-10-05').find((s) => s.ruleId === 'results')
        ?.hit,
    ).toBeNull();
    const zero = days('2026-09-29', 7, 100, 0);
    expect(
      metricSignals([entity('a', zero)], p, '2026-10-05').find((s) => s.ruleId === 'no_results')
        ?.hit,
    ).toBe(true);
    zero[0]!.results = null;
    expect(
      metricSignals([entity('a', zero)], p, '2026-10-05').find((s) => s.ruleId === 'no_results')
        ?.hit,
    ).toBeNull();
  });
  it('fija baseline y comparadores con datos previos y alinea días de semana sin sustitución posterior', () => {
    const p = defaultMonitorPolicy(),
      history = days('2026-08-01', 100),
      a = entity('a', history),
      b = entity('b', structuredClone(history)),
      different = entity('c', history, 'OUTCOME_SALES');
    const action = { id: 'action', entityLevel: 'campaign', entityMetaId: 'a', dispatchAt: null },
      plan = buildPlan(
        action,
        [a, b, different],
        p,
        new Date('2026-10-01T12:00:00Z'),
        '2026-10-01',
      );
    expect(plan.comparators.map((e) => e.id)).toEqual(['b']);
    expect(plan.retrospective).toBe(false);
    expect(new Date(plan.beforeSince).getUTCDay()).toBe(new Date(plan.afterSince).getUTCDay());
    expect(plan.target.days.every((d) => d.date < plan.actionDate)).toBe(true);
    a.days.find((d) => d.date === plan.beforeSince)!.results = 999;
    expect(plan.target.days[0]?.results).toBe(10);
    const post = days(plan.afterSince, plan.days, 100, 20),
      changed = days(plan.afterSince, plan.days, 100, 30);
    changed[0]!.attribution = '1d_click';
    const result = evaluatePlan(
      plan,
      [entity('a', post), entity('b', changed), different],
      '2026-10-20',
      ['other-action'],
      [{ since: '2026-10-01', until: '2026-10-07', label: 'Promoción' }],
    );
    expect(result.target.delta?.results).toBe(140);
    expect(result.comparators[0]?.comparable).toBe(false);
    expect(result.causal).toBe(false);
    expect(result.flags.join(' ')).toMatch(/simultáneas.*Promoción/);
    const waiting = evaluatePlan(plan, [entity('a', post)], '2026-10-03', [], []);
    expect(waiting.status).toBe('waiting');
    expect(waiting.target.delta).toBeNull();
  });
  it('una captura retrospectiva no produce una comparación admisible aunque tenga datos', () => {
    const p = defaultMonitorPolicy(),
      e = entity('a', days('2026-08-01', 100)),
      plan = buildPlan(
        {
          id: 'old',
          entityLevel: 'campaign',
          entityMetaId: 'a',
          dispatchAt: new Date('2026-10-01'),
        },
        [e],
        p,
        new Date('2026-10-25'),
        '2026-10-01',
      );
    expect(evaluatePlan(plan, [e], '2026-10-22', [], []).status).toBe('insufficient');
  });
  it('maneja silencio nocturno, diurno e igualdad sin bloqueos permanentes', () => {
    expect(inQuietHours(23, 22, 8)).toBe(true);
    expect(inQuietHours(8, 22, 8)).toBe(false);
    expect(inQuietHours(12, 9, 17)).toBe(true);
    expect(inQuietHours(9, 9, 9)).toBe(false);
  });
});

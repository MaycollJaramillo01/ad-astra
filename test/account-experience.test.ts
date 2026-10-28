import { describe, expect, it } from 'vitest';
import type { Signal, Summary } from '../src/modules/monitoring/model.ts';
import type { WorkspaceAccount } from '../src/workspace-contracts.ts';
import { accountPath, attention, dataState } from '../web/src/account-context.ts';
import { presentSignal } from '../web/src/incident-presentation.ts';

const now = Date.parse('2026-10-28T12:00:00Z');
const account: WorkspaceAccount = {
  id: 'account',
  name: 'Cuenta',
  metaAccountId: 'act_1',
  clientId: 'client',
  clientName: 'Cliente',
  currency: 'USD',
  timezoneName: 'UTC',
  accountStatus: 1,
  userTasks: [],
  syncEnabled: true,
  lastDiscoveredAt: null,
  lastEntitiesSyncAt: null,
  lastInsightsSyncAt: '2026-10-28T11:00:00Z',
  connectionStatus: 'active',
  connectionExpired: false,
  readConsentActive: true,
  monitoringEnabled: true,
  staleHours: 24,
  lastEvaluationAt: null,
  health: { score: 85, grade: 'good', date: '2026-10-27' },
  incidents: 0,
  criticalIncidents: 0,
  findings: 0,
  criticalFindings: 0,
  pendingActions: 0,
  failedActions: 0,
};
const summary = (spend: number | null, results: number | null, expected: number): Summary => ({
  since: '2026-10-01',
  until: '2026-10-07',
  expected,
  observed: expected,
  coverage: 1,
  spend,
  results,
  leads: results,
  purchases: null,
  cpr: spend !== null && results !== null && results > 0 ? spend / results : null,
  signature: 'lead|7d_click',
});
const signal = (detail: unknown, hit: boolean | null = true): Signal => ({
  ruleId: 'cpr',
  group: 'performance',
  level: 'campaign',
  entityId: '1',
  category: 'performance',
  severity: 'high',
  observation: '2026-10-07',
  hit,
  detail,
});

describe('interpretación y contexto de cuentas', () => {
  it('separa falta de datos del rendimiento, incluso si la salud histórica es buena', () => {
    expect(dataState({ ...account, lastInsightsSyncAt: null }, now).kind).toBe('waiting');
    expect(attention({ ...account, lastInsightsSyncAt: null }, now).label).toBe('Revisar datos');
    expect(dataState({ ...account, connectionExpired: true }, now).kind).toBe('blocked');
    expect(dataState({ ...account, readConsentActive: false }, now).kind).toBe('blocked');
    expect(dataState({ ...account, lastInsightsSyncAt: '2026-10-20T00:00:00Z' }, now).kind).toBe(
      'stale',
    );
    expect(attention({ ...account, health: null }, now).label).toBe('Evaluación pendiente');
    expect(attention({ ...account, failedActions: 1 }, now).rank).toBeGreaterThan(
      attention(account, now).rank,
    );
  });
  it('conserva el período al cambiar de vista y elimina filtros de otra entidad', () => {
    const url = accountPath(
      'a/b',
      'acciones',
      new URLSearchParams('periodo=last_30d&entidad=anterior&seccion=history'),
      { entidad: 'nueva' },
    );
    expect(url).toBe('/cuentas/a%2Fb?periodo=last_30d&vista=acciones&entidad=nueva');
  });
  it('normaliza resultados diarios al comparar ventanas de distinta longitud', () => {
    const copy = presentSignal(
      signal({
        kind: 'results_drop',
        recent: summary(100, 35, 7),
        baseline: summary(400, 280, 28),
      }),
      'USD',
    );
    expect(copy.title).toContain('50 %');
    expect(copy.description).toContain('5 por día frente a 10');
  });
  it('describe el costo ponderado, cero resultados explícitos y datos insuficientes', () => {
    expect(
      presentSignal(
        signal({
          kind: 'cpr_increase',
          recent: summary(138, 10, 7),
          baseline: summary(100, 10, 7),
        }),
        'USD',
      ).title,
    ).toContain('38 %');
    expect(
      presentSignal(
        signal({
          kind: 'spend_without_results',
          recent: summary(138, 0, 7),
          baseline: summary(100, 10, 7),
        }),
        'USD',
      ).title,
    ).toContain('138 USD invertidos sin resultados');
    expect(presentSignal(signal({}, null), 'USD').title).toContain('evidencia suficiente');
    expect(presentSignal(signal({}, false), 'USD').title).toContain('ya no detecta');
  });
});

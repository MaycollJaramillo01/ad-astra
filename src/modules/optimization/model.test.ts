import { describe, expect, it } from 'vitest';
import { ActionPolicy, type Snapshot } from '../../action-contracts.ts';
import { checkPolicy, configuration, hash, previewOf } from './model.ts';

const snapshot: Snapshot = {
  id: '123',
  accountId: 'act_1',
  status: 'ACTIVE',
  effectiveStatus: 'ACTIVE',
  dailyBudget: '10000',
  lifetimeBudget: '0',
  scheduleEnabled: false,
  campaignId: null,
  adsetId: null,
  parentDailyBudget: '0',
  parentLifetimeBudget: '0',
  adsetDailyBudget: '0',
  adsetLifetimeBudget: '0',
  parentStatus: null,
  adsetStatus: null,
  endTime: new Date(Date.now() + 86400000).toISOString(),
  currency: 'EUR',
  timezone: 'Europe/Madrid',
};
const policy = ActionPolicy.parse({
  enabled: true,
  allowedOperations: ['pause', 'activate', 'set_daily_budget', 'set_lifetime_budget'],
  maxBudgetMinor: '50000',
  maxDailyIncreaseMinor: '5000',
});

describe('guardrails del Action Center', () => {
  it('la huella sobrevive al orden de claves de jsonb y detecta cambios relevantes', () => {
    const reversed = Object.fromEntries(Object.entries(snapshot).reverse()) as Snapshot;
    expect(hash(configuration(reversed))).toBe(hash(configuration(snapshot)));
    expect(hash(configuration({ ...snapshot, effectiveStatus: 'IN_PROCESS' }))).toBe(
      hash(configuration(snapshot)),
    );
    expect(hash(configuration({ ...snapshot, dailyBudget: '11000' }))).not.toBe(
      hash(configuration(snapshot)),
    );
  });
  it('rechaza cambiar modo de presupuesto, anuncios, CBO y presupuestos programados', () => {
    for (const [s, level, op] of [
      [snapshot, 'ad', 'set_daily_budget'],
      [snapshot, 'campaign', 'set_lifetime_budget'],
      [{ ...snapshot, parentDailyBudget: '20000' }, 'adset', 'set_daily_budget'],
      [{ ...snapshot, scheduleEnabled: true }, 'campaign', 'set_daily_budget'],
      [{ ...snapshot, status: 'DELETED' }, 'campaign', 'pause'],
    ] as const)
      expect(() => previewOf(s, op, op === 'pause' ? 'PAUSED' : '11000', level, policy)).toThrow();
  });
  it('valida importes absolutos, límites y presupuestos totales con fin futuro', () => {
    expect(() => previewOf(snapshot, 'set_daily_budget', '0', 'campaign', policy)).toThrow();
    expect(() => previewOf(snapshot, 'set_daily_budget', '50001', 'campaign', policy)).toThrow();
    expect(() => previewOf(snapshot, 'set_daily_budget', '13000', 'campaign', policy)).toThrow();
    expect(previewOf(snapshot, 'set_daily_budget', '11000', 'campaign', policy)).toMatchObject({
      before: '10000',
      after: '11000',
      changePct: 10,
      increaseMinor: '1000',
      requiredApprovals: 2,
    });
    const total = { ...snapshot, dailyBudget: '0', lifetimeBudget: '10000' };
    expect(previewOf(total, 'set_lifetime_budget', '11000', 'campaign', policy).field).toBe(
      'lifetime_budget',
    );
    expect(() =>
      previewOf({ ...total, endTime: null }, 'set_lifetime_budget', '11000', 'campaign', policy),
    ).toThrow();
  });
  it('activar requiere presupuesto de entrega conocido y dos aprobadores; no activa a padres', () => {
    expect(
      previewOf(
        { ...snapshot, status: 'PAUSED', parentStatus: 'PAUSED' },
        'activate',
        'ACTIVE',
        'adset',
        policy,
      ),
    ).toMatchObject({ requiredApprovals: 2 });
    expect(() =>
      previewOf({ ...snapshot, status: 'PAUSED' }, 'activate', 'ACTIVE', 'campaign', {
        ...policy,
        maxBudgetMinor: '5000',
      }),
    ).toThrow();
    expect(() =>
      previewOf(
        { ...snapshot, status: 'PAUSED', dailyBudget: '0' },
        'activate',
        'ACTIVE',
        'campaign',
        policy,
      ),
    ).toThrow();
  });
  it('deniega por defecto y respeta la ventana local de la cuenta', () => {
    expect(() => checkPolicy(ActionPolicy.parse({}), 'pause', 'UTC')).toThrow();
    expect(() =>
      checkPolicy({ ...policy, allowedOperations: ['pause'] }, 'activate', 'UTC'),
    ).toThrow();
    expect(() =>
      checkPolicy(
        { ...policy, startHour: 9, endHour: 17 },
        'pause',
        'UTC',
        new Date('2026-10-26T08:00:00Z'),
      ),
    ).toThrow();
    expect(() =>
      checkPolicy(
        { ...policy, startHour: 9, endHour: 17 },
        'pause',
        'UTC',
        new Date('2026-10-26T10:00:00Z'),
      ),
    ).not.toThrow();
  });
});

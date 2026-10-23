import { expect, it } from 'vitest';
import { classifyMetaError } from './errors.ts';

// Tabla de docs/API_INTEGRATIONS.md §1.13: [código, subcódigo, acción esperada]
const CASES: Array<[number | undefined, number | undefined, unknown]> = [
  [1, undefined, { kind: 'retry' }],
  [2, undefined, { kind: 'retry' }],
  [4, 1504022, { kind: 'throttle', scope: 'app:insights' }],
  [4, 1504039, { kind: 'throttle', scope: 'app:insights' }],
  [4, undefined, { kind: 'throttle', scope: 'app:global' }],
  [17, 2446079, { kind: 'throttle', scope: 'account' }],
  [17, 1885172, { kind: 'stop', reason: 'spend_cap_changes_per_day' }],
  [32, undefined, { kind: 'throttle', scope: 'account' }],
  [613, 1487742, { kind: 'throttle', scope: 'account' }],
  [613, 5044001, { kind: 'reschedule', minSeconds: 5 }],
  [613, 4841018, { kind: 'reschedule', minSeconds: 30 }],
  [613, 1487632, { kind: 'reschedule', minSeconds: 3600 }],
  [613, 1487225, { kind: 'stop', reason: 'creation_limited_by_daily_spend' }],
  [613, undefined, { kind: 'stop', reason: 'abuse_prevention' }],
  [80000, undefined, { kind: 'throttle', scope: 'account' }],
  [80004, undefined, { kind: 'throttle', scope: 'account' }],
  [80014, undefined, { kind: 'throttle', scope: 'account' }],
  [100, 1487534, { kind: 'split' }],
  [100, 33, { kind: 'stop', reason: 'invalid_parameter' }],
  [102, undefined, { kind: 'auth' }],
  [190, 463, { kind: 'auth' }],
  [10, undefined, { kind: 'permission' }],
  [200, undefined, { kind: 'permission' }],
  [299, undefined, { kind: 'permission' }],
  [368, undefined, { kind: 'stop', reason: 'policy_block' }],
  [999999, undefined, { kind: 'stop', reason: 'unknown' }],
  [undefined, undefined, { kind: 'stop', reason: 'unknown' }],
];

it.each(CASES)('código %s / subcódigo %s', (code, subcode, expected) => {
  expect(classifyMetaError(code, subcode)).toEqual(expected);
});

it('respeta is_transient en errores no catalogados', () => {
  expect(classifyMetaError(999999, undefined, true)).toEqual({ kind: 'retry' });
});

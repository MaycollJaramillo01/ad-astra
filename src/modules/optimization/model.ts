import { createHash } from 'node:crypto';
import type { Policy, Preview, Snapshot } from '../../action-contracts.ts';
import { badRequest, conflict } from '../../platform/errors.ts';
import { canonical } from '../audit/service.ts';

export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const fieldOf = (operation: string) =>
  operation === 'set_daily_budget'
    ? ('daily_budget' as const)
    : operation === 'set_lifetime_budget'
      ? ('lifetime_budget' as const)
      : ('status' as const);
export const snapshotValue = (s: Snapshot, field: string) =>
  field === 'daily_budget'
    ? s.dailyBudget
    : field === 'lifetime_budget'
      ? s.lifetimeBudget
      : s.status;

/** Identidad y configuración que debe permanecer estable entre revisión y envío. El estado
 * efectivo puede cambiar asíncronamente por revisión de Meta; se verifica por separado. */
export const configuration = (s: Snapshot) => ({ ...s, effectiveStatus: undefined });
export function matches(s: Snapshot, preview: Preview): boolean {
  return snapshotValue(s, preview.field) === preview.after;
}

export function previewOf(
  s: Snapshot,
  operation: string,
  desired: string,
  level: string,
  p: Policy,
): Omit<Preview, 'hash' | 'policyHash' | 'expiresAt'> {
  const field = fieldOf(operation);
  const before = snapshotValue(s, field);
  if (!['ACTIVE', 'PAUSED'].includes(s.status))
    throw badRequest(
      'Solo se editan entidades ACTIVE o PAUSED; no se restauran borradas o archivadas.',
    );
  if (desired === before) throw conflict('La entidad ya tiene el valor solicitado.');
  const warnings = [
    'Restaurar configuración no recupera gasto, entrega perdida, aprendizaje ni resultados anteriores.',
  ];
  let changePct = 0,
    increaseMinor = '0';
  if (field !== 'status') {
    if (level === 'ad') throw badRequest('Los anuncios no tienen presupuesto propio.');
    if (s.scheduleEnabled)
      throw badRequest('Los presupuestos programados requieren revisión manual.');
    if (s.dailyBudget === '0' && s.lifetimeBudget === '0')
      throw badRequest('No hay presupuesto propio que se pueda ajustar.');
    if (s.dailyBudget !== '0' && s.lifetimeBudget !== '0')
      throw badRequest('Modo de presupuesto ambiguo.');
    if (before === '0') throw badRequest('No se cambia entre presupuesto diario y total.');
    if (level === 'adset' && (s.parentDailyBudget !== '0' || s.parentLifetimeBudget !== '0'))
      throw badRequest('El presupuesto lo controla la campaña; no se modifica el conjunto.');
    const amount = BigInt(desired),
      old = BigInt(before);
    if (amount <= 0n) throw badRequest('El presupuesto debe ser mayor que cero.');
    if (amount > BigInt(p.maxBudgetMinor))
      throw badRequest('Supera el presupuesto máximo autorizado en la política.');
    const delta = amount - old;
    increaseMinor = delta > 0n ? String(delta) : '0';
    changePct = (Number(delta < 0n ? -delta : delta) / Number(old)) * 100;
    if (changePct > p.maxChangePct + 1e-9)
      throw badRequest('Supera el porcentaje máximo de cambio por acción.');
    if (field === 'lifetime_budget' && (!s.endTime || Date.parse(s.endTime) <= Date.now()))
      throw badRequest('El presupuesto total requiere una fecha de fin futura.');
    warnings.push(
      'El presupuesto puede reiniciar el aprendizaje. Los mínimos, gasto ya consumido y restricciones dinámicas los valida Meta; la aprobación no garantiza aceptación.',
    );
  } else if (desired === 'ACTIVE') {
    const budgets = [
      s.dailyBudget,
      s.lifetimeBudget,
      s.parentDailyBudget,
      s.parentLifetimeBudget,
      s.adsetDailyBudget,
      s.adsetLifetimeBudget,
    ].map(BigInt);
    // biome-ignore lint/complexity/useMathMinMax: Math.max no admite bigint.
    const controlling = budgets.reduce((a, b) => (a > b ? a : b), 0n);
    if (controlling === 0n || controlling > BigInt(p.maxBudgetMinor))
      throw badRequest(
        'Activar requiere un presupuesto de entrega conocido dentro del máximo autorizado.',
      );
    if (
      (s.parentStatus && s.parentStatus !== 'ACTIVE') ||
      (s.adsetStatus && s.adsetStatus !== 'ACTIVE')
    )
      warnings.push(
        'Un padre está pausado: activar esta entidad no activa sus padres ni garantiza entrega.',
      );
    warnings.push(
      'Activar puede generar gasto inmediatamente. No se promete un impacto incremental.',
    );
  }
  return {
    snapshot: s,
    field,
    before,
    after: desired,
    changePct,
    increaseMinor,
    requiredApprovals:
      operation === 'activate' || (field !== 'status' && changePct >= p.doubleApprovalPct) ? 2 : 1,
    warnings,
  };
}

export function checkPolicy(p: Policy, operation: string, timezone: string, now = new Date()) {
  if (!p.enabled) throw conflict('Kill switch de la cuenta activo: escrituras deshabilitadas.');
  if (!p.allowedOperations.includes(operation as Policy['allowedOperations'][number]))
    throw badRequest('Operación no autorizada por la política de esta cuenta.');
  const hour = Number(
    new Intl.DateTimeFormat('en', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(
      now,
    ),
  );
  if (hour < p.startHour || hour >= p.endHour)
    throw conflict('Fuera de la ventana horaria autorizada de la cuenta.');
}

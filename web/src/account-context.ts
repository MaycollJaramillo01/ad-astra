import type { WorkspaceAccount } from '../../src/workspace-contracts.ts';

export const ACCOUNT_VIEWS = [
  'resumen',
  'problemas',
  'campanas',
  'acciones',
  'seguimiento',
  'historial',
  'ajustes',
] as const;
export type AccountView = (typeof ACCOUNT_VIEWS)[number];
export function accountPath(
  id: string,
  view: AccountView = 'resumen',
  search?: URLSearchParams,
  extra: Record<string, string> = {},
) {
  const sp = new URLSearchParams();
  for (const key of ['periodo', 'desde', 'hasta', 'comparar', 'metrica']) {
    const value = search?.get(key);
    if (value) sp.set(key, value);
  }
  sp.set('vista', view);
  for (const [key, value] of Object.entries(extra)) sp.set(key, value);
  return `/cuentas/${encodeURIComponent(id)}?${sp}`;
}
export function dataState(a: WorkspaceAccount, now = Date.now()) {
  if (a.connectionStatus !== 'active' || a.connectionExpired)
    return {
      kind: 'blocked',
      label: 'Revisar conexión',
      detail: 'La conexión con Meta necesita atención antes de actualizar los datos.',
    };
  if (!a.readConsentActive)
    return {
      kind: 'blocked',
      label: 'Falta autorización',
      detail: 'Se necesita un cliente activo con consentimiento de lectura vigente.',
    };
  if (!a.syncEnabled)
    return {
      kind: 'waiting',
      label: 'Sincronización desactivada',
      detail: 'Activa la sincronización para recibir nuevos datos de esta cuenta.',
    };
  if (!a.lastInsightsSyncAt)
    return {
      kind: 'waiting',
      label: 'Esperando primeros datos',
      detail: 'La primera sincronización todavía no ha terminado.',
    };
  if (now - Date.parse(a.lastInsightsSyncAt) > a.staleHours * 3_600_000)
    return {
      kind: 'stale',
      label: 'Datos atrasados',
      detail: `La última sincronización supera el plazo de ${a.staleHours} horas. Revisa su historial antes de interpretar el rendimiento.`,
    };
  return {
    kind: 'ready',
    label: 'Datos actualizados',
    detail:
      'La última sincronización está dentro del plazo de la cuenta; la cobertura se comprueba por período.',
  };
}
export function attention(a: WorkspaceAccount, now = Date.now()) {
  const state = dataState(a, now);
  if (state.kind === 'blocked')
    return { rank: 5, label: 'Requiere atención', reason: state.detail };
  if (
    a.criticalIncidents ||
    a.criticalFindings ||
    a.failedActions ||
    a.health?.grade === 'critical'
  )
    return {
      rank: 4,
      label: 'Prioridad alta',
      reason: a.failedActions
        ? `${a.failedActions} acciones necesitan revisión.`
        : 'Hay señales de rendimiento que requieren revisión prioritaria.',
    };
  if (state.kind !== 'ready') return { rank: 3, label: 'Revisar datos', reason: state.detail };
  if (a.incidents || a.findings || a.health?.grade === 'attention')
    return {
      rank: 2,
      label: 'En revisión',
      reason: `${a.incidents} incidentes y ${a.findings} hallazgos por revisar.`,
    };
  if (a.pendingActions)
    return {
      rank: 1,
      label: 'Acciones pendientes',
      reason: `${a.pendingActions} acciones en curso.`,
    };
  if (!a.monitoringEnabled || !a.lastEvaluationAt || !a.health || a.health.score === null)
    return {
      rank: 1,
      label: 'Evaluación pendiente',
      reason: !a.monitoringEnabled
        ? 'El monitoreo automático está deshabilitado.'
        : !a.lastEvaluationAt
          ? 'Todavía no se ha ejecutado el monitoreo de esta cuenta.'
          : 'Todavía no hay una evaluación de salud con datos suficientes.',
    };
  return {
    rank: 0,
    label: 'Sin alertas abiertas',
    reason: 'Consulta el detalle para revisar la cobertura y el período evaluado.',
  };
}

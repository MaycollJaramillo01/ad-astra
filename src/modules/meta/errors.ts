// Taxonomía de errores de Graph / Marketing API (docs/API_INTEGRATIONS.md §1.13).
// Se clasifica por error.code / error_subcode del cuerpo, nunca por el estado HTTP.

export type ErrorAction =
  | { kind: 'retry' } // transitorio: backoff exponencial con jitter
  | { kind: 'throttle'; scope: 'app:insights' | 'app:global' | 'account' } // esperar según cabeceras
  | { kind: 'reschedule'; minSeconds: number } // límite por objeto: reintentar más tarde
  | { kind: 'split' } // demasiados datos: dividir la consulta
  | { kind: 'auth' } // token inválido: conexión 'invalid'
  | { kind: 'permission' } // sin acceso a la cuenta u objeto
  | { kind: 'stop'; reason: string }; // no reintentar

const BUC_CODES = new Set([80000, 80001, 80003, 80004, 80005, 80006, 80014]);

export function classifyMetaError(
  code: number | undefined,
  subcode?: number,
  isTransient?: boolean,
): ErrorAction {
  if (code === 4) {
    return subcode === 1504022 || subcode === 1504039
      ? { kind: 'throttle', scope: 'app:insights' }
      : { kind: 'throttle', scope: 'app:global' };
  }
  if (code === 17) {
    if (subcode === 1885172) return { kind: 'stop', reason: 'spend_cap_changes_per_day' };
    return { kind: 'throttle', scope: 'account' };
  }
  if (code === 613) {
    switch (subcode) {
      case 1487742:
        return { kind: 'throttle', scope: 'account' };
      case 5044001:
        return { kind: 'reschedule', minSeconds: 5 };
      case 4841018:
        return { kind: 'reschedule', minSeconds: 30 };
      case 1487632:
        return { kind: 'reschedule', minSeconds: 3600 };
      case 1487225:
        return { kind: 'stop', reason: 'creation_limited_by_daily_spend' };
      default:
        return { kind: 'stop', reason: 'abuse_prevention' };
    }
  }
  if (code !== undefined && BUC_CODES.has(code)) return { kind: 'throttle', scope: 'account' };
  if (code === 32) return { kind: 'throttle', scope: 'account' };
  if (code === 100) {
    return subcode === 1487534 ? { kind: 'split' } : { kind: 'stop', reason: 'invalid_parameter' };
  }
  if (code === 102 || code === 190) return { kind: 'auth' };
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return { kind: 'permission' };
  }
  if (code === 368) return { kind: 'stop', reason: 'policy_block' };
  if (code === 1 || code === 2 || isTransient) return { kind: 'retry' };
  return { kind: 'stop', reason: 'unknown' };
}

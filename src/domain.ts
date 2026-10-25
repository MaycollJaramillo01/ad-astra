// Valores de dominio compartidos por el esquema de BD, el contrato de la API y la web.
// Sin dependencias: la web los importa sin arrastrar el ORM.

export const ROLES = ['owner', 'admin', 'manager', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const CONSENT_SCOPES = [
  'read_insights',
  'ai_processing',
  'write_status',
  'write_budget',
] as const;

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const FINDING_STATUSES = [
  'open',
  'acknowledged',
  'snoozed',
  'dismissed',
  'resolved',
] as const;

export const RECOMMENDATION_ACTIONS = [
  'pause',
  'activate',
  'set_daily_budget',
  'set_lifetime_budget',
  'review',
] as const;
export const RECOMMENDATION_STATUSES = [
  'open',
  'accepted',
  'dismissed',
  'applied',
  'expired',
] as const;

/** Resultado de un turno del asistente de IA (F4). */
export const AI_TURN_STATUSES = [
  'answered', // respuesta verificada
  'unverified', // respuesta mostrada con cifras o citas sin verificar
  'refused', // el modelo (y su respaldo) rechazó la petición
  'budget_exhausted',
  'incomplete', // límite de llamadas o herramientas sin respuesta final
  'failed', // error del proveedor
] as const;

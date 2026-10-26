import type { Role } from '../domain.ts';

// Matriz de permisos (docs/SECURITY.md §4.2). Denegar por defecto: un permiso no listado no
// lo tiene nadie. Cada ruta declara el suyo y un test comprueba que ninguna queda sin declarar.

const ALL: readonly Role[] = ['owner', 'admin', 'manager', 'analyst', 'viewer'];
const ADMINS: readonly Role[] = ['owner', 'admin'];

export const PERMISSIONS = {
  'members:read': ADMINS,
  'members:manage': ADMINS,
  'clients:read': ALL,
  'clients:manage': ADMINS,
  'consents:manage': ADMINS,
  'connections:read': ADMINS,
  'connections:manage': ADMINS,
  'accounts:read': ALL,
  'accounts:manage': ADMINS,
  /** Analítica y su exportación (auditada): ver datos es de todos, con el alcance por cliente. */
  'insights:read': ALL,
  'findings:read': ALL,
  /** Lanzar el motor de auditoría a mano (también se ejecuta solo tras cada sincronización). */
  'audit:run': ['owner', 'admin', 'manager', 'analyst'],
  /** Reglas, umbrales, pesos y objetivos: owner y admin en toda la organización; manager en sus clientes. */
  'audit:configure': ['owner', 'admin', 'manager'],
  'findings:decide': ['owner', 'admin', 'manager', 'analyst'],
  'recommendations:read': ALL,
  'recommendations:decide': ['owner', 'admin', 'manager'],
  'actions:read': ALL,
  'actions:propose': ['owner', 'admin', 'manager', 'analyst'],
  'actions:approve': ['owner', 'admin', 'manager'],
  'actions:configure': ADMINS,
  /** Diseñar y cancelar experimentos de presupuesto (no tocan Meta: el plan se aplica a mano). */
  'experiments:manage': ['owner', 'admin', 'manager'],
  /** Asistente de IA: preguntar (gasta presupuesto) y proponer sus recomendaciones a la cola. */
  'ai:use': ['owner', 'admin', 'manager', 'analyst'],
  'audit_log:read': ADMINS,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, permission: Permission): boolean =>
  (PERMISSIONS[permission] as readonly Role[]).includes(role);

/** owner y admin ven todos los clientes; el resto, solo los asignados. */
export const seesAllClients = (role: Role): boolean => ADMINS.includes(role);

/** Solo owner puede conceder o retirar los roles owner y admin. */
export const canGrantRole = (actor: Role, target: Role): boolean =>
  actor === 'owner' || (actor === 'admin' && !ADMINS.includes(target));

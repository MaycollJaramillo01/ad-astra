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
  'findings:read': ALL,
  'findings:decide': ['owner', 'admin', 'manager', 'analyst'],
  'recommendations:read': ALL,
  'recommendations:decide': ['owner', 'admin', 'manager'],
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

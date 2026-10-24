import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import type { Role } from '../domain.ts';
import { listMemberships } from './access.ts';
import type { Authenticate, Identity } from './auth.ts';
import { AppError, badRequest, forbidden, unauthorized } from './errors.ts';
import { can, type Permission } from './rbac.ts';

// Control de acceso de cada petición (docs/SECURITY.md §4.2–4.3).
//   public         → sin sesión (salud, OpenAPI, rutas de Better Auth)
//   authenticated  → con sesión, sin tenant (p. ej. /v1/me)
//   permission     → con sesión, tenant activo verificado y permiso del rol
// Una ruta sin `access` declarado no se sirve (fallo cerrado).

export type Access = { public: true } | { authenticated: true } | { permission: Permission };

export interface TenantContext {
  tenantId: string;
  role: Role;
  userId: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    identity?: Identity;
    tenant?: TenantContext;
  }
}

const TENANT_HEADER = 'x-tenant-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Identidad de una ruta con sesión (siempre presente si el hook dejó pasar). */
export function identityOf(request: FastifyRequest): Identity {
  if (!request.identity) throw new AppError(500, 'internal', 'Ruta sin identidad');
  return request.identity;
}

/** Contexto de tenant de una ruta con `permission` (siempre presente si el hook dejó pasar). */
export function tenantOf(request: FastifyRequest): TenantContext {
  if (!request.tenant) throw new AppError(500, 'internal', 'Ruta sin contexto de tenant');
  return request.tenant;
}

export function registerAccessControl(
  app: FastifyInstance,
  db: Db,
  authenticate: Authenticate,
  origin: string,
) {
  app.addHook('onRequest', async (request) => {
    if (request.is404) return;

    // CSRF: las cookies de sesión son SameSite=Lax; además, toda petición que modifica debe
    // venir de la propia SPA (Origin = APP_ORIGIN).
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== origin) {
      throw forbidden('Origen de la petición no permitido');
    }

    const access = request.routeOptions.config.access;
    if (!access) throw new AppError(500, 'internal', 'Ruta sin control de acceso declarado');
    if ('public' in access) return;

    const identity = await authenticate(request);
    if (!identity) throw unauthorized();
    request.identity = identity;
    if ('authenticated' in access) return;

    // El cliente puede indicar el tenant activo, pero solo se fija tras verificar la membresía.
    const requested = request.headers[TENANT_HEADER];
    if (requested !== undefined && (typeof requested !== 'string' || !UUID.test(requested))) {
      throw badRequest(`Cabecera ${TENANT_HEADER} no válida`);
    }
    const memberships = await listMemberships(db, identity.userId);
    const membership = requested
      ? memberships.find((m) => m.tenantId === requested.toLowerCase())
      : memberships.length === 1
        ? memberships[0]
        : undefined;
    if (!membership) {
      if (requested) throw forbidden('No perteneces a esa organización');
      throw memberships.length === 0
        ? forbidden('No perteneces a ninguna organización')
        : badRequest(`Indica la organización activa con la cabecera ${TENANT_HEADER}`);
    }
    if (membership.tenantStatus !== 'active') throw forbidden('La organización está suspendida');
    if (!can(membership.role, access.permission)) throw forbidden();
    request.tenant = {
      tenantId: membership.tenantId,
      role: membership.role,
      userId: identity.userId,
    };
  });

  // Log de acceso propio: la plantilla de la ruta, nunca la URL con su query string.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'not-found',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        tenant: request.tenant?.tenantId,
        user: request.identity?.userId,
      },
      'petición',
    );
  });
}

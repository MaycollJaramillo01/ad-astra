import { createAuthClient } from 'better-auth/react';

// Cliente HTTP de la SPA. Misma origen que la API: la cookie de sesión viaja sola (httpOnly) y
// la SPA nunca ve tokens. El tenant activo es una preferencia local; el servidor la verifica.

export const authClient = createAuthClient({ basePath: '/v1/auth' });

const TENANT_KEY = 'ad-astra.tenant';

export function getActiveTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null; // almacenamiento bloqueado: se usa la única organización, si la hay
  }
}

export function setActiveTenant(id: string): void {
  try {
    localStorage.setItem(TENANT_KEY, id);
  } catch {
    // sin persistencia: la elección dura lo que la pestaña
  }
}

/** Error RFC 9457 devuelto por la API. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  constructor(status: number, title: string, detail?: string) {
    super(title);
    this.status = status;
    this.detail = detail;
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const tenant = getActiveTenant();
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(tenant && { 'x-tenant-id': tenant }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.title ?? `Error ${res.status}`, data?.detail);
  }
  return data as T;
}

/** Descarga un archivo de la API (p. ej. un CSV) con la misma sesión y organización activa. */
export async function download(path: string): Promise<void> {
  const tenant = getActiveTenant();
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: tenant ? { 'x-tenant-id': tenant } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.title ?? `Error ${res.status}`, data?.detail);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

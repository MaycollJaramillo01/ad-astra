import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

// Errores uniformes en formato application/problem+json (RFC 9457, ARCHITECTURE §7).
// Nunca se devuelven trazas, SQL ni secretos: el detalle técnico va al log con el request_id.

export class AppError extends Error {
  readonly status: number;
  readonly type: string;
  readonly detail: string | undefined;

  constructor(status: number, type: string, title: string, detail?: string) {
    super(title);
    this.name = 'AppError';
    this.status = status;
    this.type = type;
    this.detail = detail;
  }
}

export const unauthorized = () => new AppError(401, 'unauthorized', 'Sesión no válida o expirada');
export const forbidden = (detail?: string) =>
  new AppError(403, 'forbidden', 'No tienes permiso para esta acción', detail);
// Un recurso de otro tenant responde 404, igual que uno inexistente: no se confirma que exista.
export const notFound = (what = 'Recurso') =>
  new AppError(404, 'not-found', `${what} no encontrado`);
export const conflict = (detail: string) =>
  new AppError(409, 'conflict', 'Conflicto con el estado actual', detail);
export const badRequest = (detail: string) =>
  new AppError(400, 'bad-request', 'Petición no válida', detail);

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

// Errores de Postgres que son culpa de la petición, no del servidor.
const PG_CODES: Record<string, (msg: string) => Problem> = {
  '23505': () => ({ type: 'conflict', title: 'Ya existe un registro con esos datos', status: 409 }),
  '23503': () => ({ type: 'conflict', title: 'Referencia a un recurso inexistente', status: 409 }),
  '23514': () => ({
    type: 'bad-request',
    title: 'Datos fuera de los valores permitidos',
    status: 400,
  }),
  '22P02': () => ({
    type: 'bad-request',
    title: 'Identificador o valor con formato no válido',
    status: 400,
  }),
  // Violación de RLS: con el tenant fijado por el servidor solo ocurre ante un intento de
  // escribir datos ajenos. Se responde como prohibido sin dar detalles.
  '42501': () => ({ type: 'forbidden', title: 'No tienes permiso para esta acción', status: 403 }),
};

function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = (cause ?? error) as { code?: unknown };
  return typeof code.code === 'string' && /^[0-9A-Z]{5}$/.test(code.code) ? code.code : undefined;
}

export function toProblem(error: unknown): Problem {
  if (error instanceof AppError) {
    return { type: error.type, title: error.message, status: error.status, detail: error.detail };
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      type: 'validation',
      title: 'La petición no supera la validación',
      status: 400,
      errors: error.validation.map((v) => ({
        path: [
          error.validationContext,
          ...String(v.instancePath ?? '')
            .split('/')
            .filter(Boolean),
        ].join('.'),
        message: v.message ?? 'valor no válido',
      })),
    };
  }
  const code = pgCode(error);
  if (code && PG_CODES[code]) return PG_CODES[code](String((error as Error).message));
  const status = (error as FastifyError).statusCode;
  if (status === 429) return { type: 'rate-limited', title: 'Demasiadas peticiones', status };
  if (status && status >= 400 && status < 500) {
    return { type: 'bad-request', title: 'Petición no válida', status };
  }
  return { type: 'internal', title: 'Error interno', status: 500 };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error);
    if (problem.status >= 500) request.log.error({ err: error }, 'error no controlado');
    else request.log.info({ problem: problem.type, status: problem.status }, 'petición rechazada');
    void reply
      .status(problem.status)
      .type('application/problem+json')
      .send({ ...problem, type: `about:blank#${problem.type}`, request_id: request.id });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).type('application/problem+json').send({
      type: 'about:blank#not-found',
      title: 'Ruta no encontrada',
      status: 404,
      request_id: request.id,
    });
  });
}

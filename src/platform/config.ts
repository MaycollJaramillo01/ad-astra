import { z } from 'zod';

// Variables de entorno del servidor, validadas al arrancar (docs/ARCHITECTURE.md §9).
// Un valor ausente o inválido detiene el proceso con un mensaje que nombra la variable,
// nunca su contenido.

const keyRing = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    // "1:<base64 32 bytes>,2:<base64 32 bytes>" — varias versiones para poder rotar (ADR-008)
    const keys = new Map<number, Buffer>();
    for (const entry of value.split(',')) {
      const [version, b64] = entry.trim().split(':');
      const key = Buffer.from(b64 ?? '', 'base64');
      const n = Number(version);
      if (!Number.isInteger(n) || n <= 0 || key.length !== 32) {
        ctx.addIssue({
          code: 'custom',
          message: 'formato esperado "versión:clave_base64_de_32_bytes"',
        });
        return z.NEVER;
      }
      keys.set(n, key);
    }
    return keys;
  });

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Origen público de la SPA y la API (mismo origen). */
    APP_ORIGIN: z.url(),
    /** Conexión con el rol app_rw (sin DDL, con RLS). */
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'debe ser una URL postgres://'),
    BETTER_AUTH_SECRET: z.string().min(32, 'mínimo 32 caracteres'),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    /** Dominio del Google Workspace de la agencia (ADR-019). */
    GOOGLE_WORKSPACE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'dominio en minúsculas, p. ej. agencia.com'),
    TOKEN_ENCRYPTION_KEYS: keyRing,
    TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive(),
  })
  .refine((c) => c.TOKEN_ENCRYPTION_KEYS.has(c.TOKEN_ENCRYPTION_KEY_VERSION), {
    path: ['TOKEN_ENCRYPTION_KEY_VERSION'],
    message: 'la versión activa no está en TOKEN_ENCRYPTION_KEYS',
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuración inválida:\n- ${problems.join('\n- ')}`);
  }
  return result.data;
}

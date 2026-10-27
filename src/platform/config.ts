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

// En .env una variable vacía ("META_APP_ID=") cuenta como ausente.
const optional = <T extends z.ZodType>(type: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), type.optional());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    WRITE_TENANT_ALLOWLIST: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.uuid())),
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
    /** App de Meta de la agencia. Sin ellas no se sincroniza nada (el tick responde 503). */
    META_APP_ID: optional(z.string().regex(/^\d+$/, 'id numérico de la app')),
    META_APP_SECRET: optional(z.string().min(16)),
    /** Secreto con el que Vercel Cron llama al tick (Authorization: Bearer …). Sin él, no hay tick HTTP. */
    CRON_SECRET: optional(z.string().min(32, 'mínimo 32 caracteres')),
    OPS_MONITOR_SECRET: optional(z.string().min(32)),
    /** Plazo de cada tick: menor que la duración máxima de la función en Vercel. */
    TICK_BUDGET_SECONDS: z.coerce.number().int().positive().default(240),
    TICK_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
    ANALYTICS_CACHE_MS: z.coerce.number().int().min(0).max(30000).default(0),
    FORECASTING_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Interruptor global de escritura: debe habilitarse explícitamente, también en el worker. */
    META_WRITES_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    NOTIFICATIONS_EMAIL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    RESEND_API_KEY: optional(z.string().min(20)),
    NOTIFICATIONS_FROM: optional(z.email()),
    /** Asistente de IA (F4). Sin clave, sus rutas responden 503: nunca se simula una respuesta. */
    ANTHROPIC_API_KEY: optional(z.string().min(20)),
    AI_PROVIDER: z.enum(['anthropic']).default('anthropic'),
    AI_MODEL: z.enum(['claude-opus-5-5', 'claude-sonnet-5-5']).default('claude-opus-5-5'),
    AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    /** Límites de costo en USD: por organización y mes, por usuario y día, y por pregunta. */
    AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(100),
    AI_USER_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(10),
    AI_QUESTION_BUDGET_USD: z.coerce.number().positive().default(1),
    /** Preguntas por usuario y minuto. */
    AI_ASK_PER_MINUTE: z.coerce.number().int().positive().default(10),
  })
  .refine((c) => c.TOKEN_ENCRYPTION_KEYS.has(c.TOKEN_ENCRYPTION_KEY_VERSION), {
    path: ['TOKEN_ENCRYPTION_KEY_VERSION'],
    message: 'la versión activa no está en TOKEN_ENCRYPTION_KEYS',
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && !['staging', 'production'].includes(c.APP_ENV))
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENV'],
        message: 'El runtime de producción requiere staging o production explícito.',
      });
    if (c.NODE_ENV === 'production' && !c.APP_ORIGIN.startsWith('https://'))
      ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'HTTPS obligatorio.' });
    if (c.APP_ENV === 'staging' && (c.META_WRITES_ENABLED || c.NOTIFICATIONS_EMAIL_ENABLED))
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENV'],
        message:
          'Staging permanece sin efectos externos; usar pruebas simuladas y una promoción controlada.',
      });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse({
    ...env,
    APP_ENV: env.APP_ENV ?? (env.NODE_ENV === 'test' ? 'test' : undefined),
    ANALYTICS_CACHE_MS: env.ANALYTICS_CACHE_MS ?? (env.NODE_ENV === 'production' ? '15000' : '0'),
    FORECASTING_ENABLED:
      env.FORECASTING_ENABLED ?? (env.APP_ENV === 'production' ? 'false' : 'true'),
  });
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuración inválida:\n- ${problems.join('\n- ')}`);
  }
  return result.data;
}

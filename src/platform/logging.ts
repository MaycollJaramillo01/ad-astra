import { type DestinationStream, type Logger, pino, stdSerializers } from 'pino';

// Parámetros de URL que contienen credenciales (docs/SECURITY.md §4.11).
const SECRET_PARAM =
  /\b(access_token|appsecret_proof|client_secret|fb_exchange_token|input_token)=[^&\s'")]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g;
// Defensa en profundidad: los tokens de Meta empiezan por "EAA".
const META_TOKEN = /\bEAA[A-Za-z0-9]{20,}/g;

export function redact(text: string): string {
  return text
    .replace(SECRET_PARAM, '$1=[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(META_TOKEN, '[REDACTED]')
    .replace(/\bpostgres(?:ql)?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, 'postgres://[REDACTED]@')
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\nparams:[\s\S]*/gi, '\nparams: [REDACTED]');
}

const SENSITIVE =
  /(?:token|secret|password|authorization|cookie|api.?key|private.?key|encryption.?key|credential|^params$|prompt|transcript|question|payload|^body$|^raw$)/i;
export function safeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error)
    return { type: value.name, message: redact(value.message), stack: redact(value.stack ?? '') };
  if (!value || typeof value !== 'object') return value;
  if (depth > 6 || seen.has(value)) return '[OMITTED]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => safeLogValue(v, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SENSITIVE.test(k) && typeof v !== 'number' ? '[REDACTED]' : safeLogValue(v, depth + 1, seen),
    ]),
  );
}

const REDACT_PATHS = [
  'access_token',
  'token',
  'appsecret_proof',
  'client_secret',
  'app_secret',
  '*.access_token',
  '*.token',
  '*.appsecret_proof',
  '*.client_secret',
  '*.app_secret',
  '*.headers.authorization',
  '*.headers.cookie',
];

export function createLogger(destination?: DestinationStream, level = 'info'): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err(e: Error) {
        const s = stdSerializers.err(e);
        s.message = redact(s.message);
        s.stack = redact(s.stack ?? '');
        return s;
      },
    },
    hooks: {
      // Los textos libres (mensajes, URLs) no pasan por `redact.paths`: se limpian aquí.
      logMethod(args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(
          this,
          args.map((a) => safeLogValue(a)),
        );
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

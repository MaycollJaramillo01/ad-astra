import { type DestinationStream, type Logger, pino, stdSerializers } from 'pino';

// Parámetros de URL que contienen credenciales (docs/SECURITY.md §4.11).
const SECRET_PARAM =
  /\b(access_token|appsecret_proof|client_secret|fb_exchange_token|input_token)=[^&\s'")]+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g;
// Defensa en profundidad: los tokens de Meta empiezan por "EAA".
const META_TOKEN = /\bEAA[A-Za-z0-9]{20,}/g;

export function redact(text: string): string {
  return text
    .replace(SECRET_PARAM, '$1=[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(META_TOKEN, '[REDACTED]');
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
          args.map((a) => (typeof a === 'string' ? redact(a) : a)),
        );
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

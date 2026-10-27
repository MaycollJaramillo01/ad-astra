import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createLogger, redact } from './logging.ts';

// Test canario (docs/SECURITY.md §4.11): un token con patrón reconocible no debe salir nunca.
const CANARY = 'EAACANARY0123456789abcdefghijklmnop';

it('el token canario no aparece en ningún log', () => {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  const log = createLogger(sink);
  const url = `https://graph.facebook.com/v26.0/me?access_token=${CANARY}&appsecret_proof=abc123`;

  log.info(`llamando a ${url}`);
  log.info({ access_token: CANARY, connection: { token: CANARY } }, 'objeto con secretos');
  log.info({ request: { headers: { authorization: `Bearer ${CANARY}` } } }, 'cabeceras');
  log.error({ err: new Error(`fetch failed ${url}`) }, 'error de red');
  log.warn(`texto suelto con el token ${CANARY}`);

  expect(out).not.toContain(CANARY);
  expect(out).not.toContain('abc123');
  expect(out).toContain('[REDACTED]');
});

it('redact limpia parámetros de credenciales y cabeceras Bearer', () => {
  expect(redact(`fallo nvapi-${'x'.repeat(50)}`)).toBe('fallo [REDACTED]');
  expect(redact('a?client_secret=s3cr3t&x=1')).toBe('a?client_secret=[REDACTED]&x=1');
  expect(redact('input_token=EAAzzz&fb_exchange_token=q')).toBe(
    'input_token=[REDACTED]&fb_exchange_token=[REDACTED]',
  );
  expect(redact('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [REDACTED]');
});

it('redacta secretos anidados, prompts y credenciales Postgres sin perder métricas', () => {
  let out = '';
  const log = createLogger(
    new Writable({
      write(chunk, _enc, done) {
        out += chunk.toString();
        done();
      },
    }),
  );
  log.info(
    {
      deep: {
        more: {
          apiKey: 'private-key-canary',
          password: 'password-canary',
          body: { question: 'prompt-canary' },
        },
      },
      headers: { Authorization: 'Bearer header-canary' },
      url: 'postgres://user:password-canary@localhost/db',
      inputTokens: 123,
    },
    'operación',
  );
  for (const secret of ['private-key-canary', 'password-canary', 'prompt-canary', 'header-canary'])
    expect(out).not.toContain(secret);
  expect(out).toContain('123');
});

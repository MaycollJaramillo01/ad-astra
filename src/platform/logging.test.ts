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
  expect(redact('a?client_secret=s3cr3t&x=1')).toBe('a?client_secret=[REDACTED]&x=1');
  expect(redact('input_token=EAAzzz&fb_exchange_token=q')).toBe(
    'input_token=[REDACTED]&fb_exchange_token=[REDACTED]',
  );
  expect(redact('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [REDACTED]');
});

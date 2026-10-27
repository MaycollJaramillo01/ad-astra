import { expect, it } from 'vitest';
import { loadConfig } from '../../platform/config.ts';
import { createEmailTransport } from './worker.ts';

it('envía únicamente al endpoint fijo, con clave idempotente y sin seguir redirecciones', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const config = {
    ...loadConfig(),
    NOTIFICATIONS_EMAIL_ENABLED: true,
    RESEND_API_KEY: 'synthetic-key-not-real',
    NOTIFICATIONS_FROM: 'avisos@agencia.test',
  };
  const transport = createEmailTransport(config, async (url, init) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ id: 'message' }), { status: 200 });
  });
  expect(
    await transport(
      { to: 'user@agencia.test', subject: 'Aviso', text: 'Revisar en la aplicación' },
      'ad-astra/synthetic-id',
    ),
  ).toBe('message');
  expect(captured?.url).toBe('https://api.resend.com/emails');
  expect(captured?.init.redirect).toBe('error');
  expect(captured?.init.headers).toMatchObject({ 'Idempotency-Key': 'ad-astra/synthetic-id' });
  expect(JSON.parse(String(captured?.init.body))).toMatchObject({
    to: 'user@agencia.test',
    from: 'avisos@agencia.test',
  });
});

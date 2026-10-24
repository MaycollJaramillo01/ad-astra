import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const key = randomBytes(32).toString('base64');
const valid = {
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://app_rw:x@localhost:5432/db',
  BETTER_AUTH_SECRET: 'b'.repeat(40),
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'super-secreto-google',
  GOOGLE_WORKSPACE_DOMAIN: 'agencia.com',
  TOKEN_ENCRYPTION_KEYS: `1:${key}`,
  TOKEN_ENCRYPTION_KEY_VERSION: '1',
};

it('acepta un entorno válido y aplica valores por defecto', () => {
  const c = loadConfig(valid);
  expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 3000, TOKEN_ENCRYPTION_KEY_VERSION: 1 });
  expect(c.TOKEN_ENCRYPTION_KEYS.get(1)?.length).toBe(32);
});

it('nombra las variables inválidas sin mostrar sus valores', () => {
  const run = () =>
    loadConfig({
      ...valid,
      GOOGLE_WORKSPACE_DOMAIN: 'Agencia',
      BETTER_AUTH_SECRET: 'corto',
      GOOGLE_CLIENT_ID: undefined,
    });
  expect(run).toThrow(/GOOGLE_WORKSPACE_DOMAIN/);
  expect(run).toThrow(/BETTER_AUTH_SECRET/);
  expect(run).toThrow(/GOOGLE_CLIENT_ID/);
  try {
    run();
  } catch (e) {
    expect(String(e)).not.toContain('super-secreto-google');
  }
});

it('rechaza claves de cifrado mal formadas o una versión activa inexistente', () => {
  expect(() => loadConfig({ ...valid, TOKEN_ENCRYPTION_KEYS: '1:abc' })).toThrow(
    /TOKEN_ENCRYPTION_KEYS/,
  );
  expect(() => loadConfig({ ...valid, TOKEN_ENCRYPTION_KEY_VERSION: '2' })).toThrow(
    /TOKEN_ENCRYPTION_KEY_VERSION/,
  );
});

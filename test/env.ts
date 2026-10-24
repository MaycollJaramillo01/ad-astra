import { randomBytes } from 'node:crypto';

// Entorno de los tests: BD propia (ad_astra_test, se vacía en cada ejecución) y secretos
// generados al vuelo. Nada de esto sirve fuera de los tests ni se guarda en el repositorio.
const host = 'localhost:55432/ad_astra_test';

export const testEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgres://app_rw:app_rw_local@${host}`,
  DATABASE_URL_OWNER:
    process.env.TEST_DATABASE_URL_OWNER ?? `postgres://app_owner:app_owner_local@${host}`,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_WORKSPACE_DOMAIN: 'agencia.test',
  TOKEN_ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')},2:${randomBytes(32).toString('base64')}`,
  TOKEN_ENCRYPTION_KEY_VERSION: '2',
};

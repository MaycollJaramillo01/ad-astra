import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { authAccounts, authSessions, authUsers, authVerifications } from '../db/schema.ts';
import { activateMemberships, canSignUp } from './access.ts';
import type { Config } from './config.ts';

// Autenticación del personal: Workspace o credenciales provisionadas por operador (sin alta pública).
//   - `hd`: Better Auth pide a Google el dominio y rechaza tokens sin ese claim `hd`.
//   - Hooks: alta solo con invitación y dominio correcto; sesión solo con membresía.

export function createAuth(config: Config, db: Db) {
  return betterAuth({
    appName: 'Ad Astra',
    baseURL: config.APP_ORIGIN,
    basePath: '/v1/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_ORIGIN],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: config.AUTH_MODE === 'password',
      disableSignUp: true,
      minPasswordLength: 14,
      maxPasswordLength: 128,
    },
    socialProviders:
      config.AUTH_MODE === 'workspace'
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
              hd: config.GOOGLE_WORKSPACE_DOMAIN,
            },
          }
        : {},
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    account: { encryptOAuthTokens: true }, // los tokens OAuth de Google no quedan en claro en la BD
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: {
      cookiePrefix: 'ad-astra',
      useSecureCookies: config.NODE_ENV === 'production',
      database: { generateId: 'uuid' },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) =>
            user.emailVerified && (await canSignUp(db, config.GOOGLE_WORKSPACE_DOMAIN, user.email))
              ? undefined
              : false,
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [user] = await db
              .select({ verified: authUsers.emailVerified })
              .from(authUsers)
              .where(eq(authUsers.id, session.userId));
            return (config.AUTH_MODE === 'password' || user?.verified) &&
              (await activateMemberships(db, session.userId))
              ? undefined
              : false;
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface Identity {
  userId: string;
  email: string;
}

/** Resuelve la identidad de una petición. En producción, la sesión de Better Auth. */
export type Authenticate = (request: FastifyRequest) => Promise<Identity | null>;

export const sessionAuthenticator =
  (auth: Auth, mode: Config['AUTH_MODE'] = 'workspace'): Authenticate =>
  async (request) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    return session && (mode === 'password' || session.user.emailVerified)
      ? { userId: session.user.id, email: session.user.email }
      : null;
  };

/** Monta las rutas de Better Auth (/v1/auth/*) sobre Fastify. */
export function registerAuthRoutes(app: FastifyInstance, auth: Auth, origin: string): void {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/auth/*',
    config: { access: { public: true } },
    schema: { hide: true },
    async handler(request, reply) {
      const response = await auth.handler(
        new Request(new URL(request.url, origin), {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          body: request.method === 'GET' ? undefined : JSON.stringify(request.body ?? {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      // Varias cookies: cada una en su cabecera (unirlas con comas rompe las que llevan Expires).
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });
}

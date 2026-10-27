import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import { authSessions, authUsers, invitations, memberships } from '../src/db/schema.ts';
import { activateMemberships, canSignUp, emailInDomain } from '../src/platform/access.ts';
import { createAuth } from '../src/platform/auth.ts';
import { config, testApp } from './app.ts';
import { type SeededTenant, seedTenant, seedUser, testDb } from './seed.ts';

// Autenticación con Google Workspace (ADR-019). El inicio de sesión completo con Google es una
// prueba manual (necesita una cuenta real); aquí se prueba todo lo demás con Better Auth real.

const db = testDb();
const domain = config.GOOGLE_WORKSPACE_DOMAIN;
let a: SeededTenant;

beforeAll(async () => {
  a = await seedTenant(db);
});

describe('acceso solo por invitación', () => {
  it('el dominio debe ser exactamente el del Workspace', () => {
    expect(emailInDomain('ana@agencia.test', 'agencia.test')).toBe(true);
    expect(emailInDomain('ANA@Agencia.Test', 'agencia.test')).toBe(true);
    expect(emailInDomain('ana@agencia.test.evil.com', 'agencia.test')).toBe(false);
    expect(emailInDomain('ana@evilagencia.test', 'agencia.test')).toBe(false);
  });

  it('sin invitación pendiente, o con otro dominio, no se crea el usuario', async () => {
    const email = `nueva-${randomBytes(4).toString('hex')}@${domain}`;
    expect(await canSignUp(db, domain, email)).toBe(false);
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.insert(invitations).values({ tenantId: a.tenantId, email, role: 'analyst' }),
    );
    expect(await canSignUp(db, domain, email)).toBe(true);
    expect(await canSignUp(db, 'otro-dominio.test', email)).toBe(false);
  });

  it('al iniciar sesión, la invitación se convierte en membresía y queda registrada', async () => {
    const user = await seedUser(db);
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.insert(invitations).values({ tenantId: a.tenantId, email: user.email, role: 'manager' }),
    );
    expect(await activateMemberships(db, user.id)).toBe(true);
    const [m] = await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, user.id)),
    );
    expect(m?.role).toBe('manager');
    const pending = await withContext(db, { userEmail: user.email }, (tx) =>
      tx.select().from(invitations),
    );
    expect(pending).toEqual([]); // ya aceptada: deja de estar pendiente
  });

  it('un usuario sin membresías ni invitaciones no obtiene sesión', async () => {
    const orphan = await seedUser(db);
    expect(await activateMemberships(db, orphan.id)).toBe(false);
  });
});

describe('Better Auth real', () => {
  it('los hooks configurados aplican las reglas de acceso (alta y sesión)', async () => {
    const hooks = createAuth(config, db).options.databaseHooks;
    const outsider = {
      id: 'x',
      name: 'x',
      email: `x@${domain}`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(await hooks?.user?.create?.before?.(outsider)).toBe(false);
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx
        .insert(invitations)
        .values({ tenantId: a.tenantId, email: outsider.email, role: 'analyst' }),
    );
    expect(await hooks?.user?.create?.before?.(outsider)).toBeUndefined();
    expect(await hooks?.user?.create?.before?.({ ...outsider, emailVerified: false })).toBe(false);
    const orphan = await seedUser(db);
    const session = {
      id: 'x',
      token: 'x',
      userId: orphan.id,
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(await hooks?.session?.create?.before?.(session)).toBe(false);
    expect(
      await hooks?.session?.create?.before?.({ ...session, userId: a.owner.id }),
    ).toBeUndefined();
  });

  it('genera la URL de Google con el dominio del Workspace (hd) y el callback propio', async () => {
    const { app } = await testApp({ realAuth: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/social',
      headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json' },
      payload: { provider: 'google', callbackURL: `${config.APP_ORIGIN}/` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const url = new URL(res.json().url);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('hd')).toBe(domain);
    expect(url.searchParams.get('client_id')).toBe(config.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${config.APP_ORIGIN}/v1/auth/callback/google`,
    );
    await app.close();
  });

  it('una sesión válida autentica la API; sin cookie, falsificada o caducada → 401', async () => {
    const { app } = await testApp({ realAuth: true });
    const token = randomBytes(24).toString('hex');
    await db
      .insert(authSessions)
      .values({ token, userId: a.owner.id, expiresAt: new Date(Date.now() + 3600_000) });
    const sign = (value: string, secret = config.BETTER_AUTH_SECRET) =>
      encodeURIComponent(`${value}.${createHmac('sha256', secret).update(value).digest('base64')}`);
    const get = (cookie?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/clients',
        headers: cookie ? { cookie: `ad-astra.session_token=${cookie}` } : {},
      });

    const ok = await get(sign(token));
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as Array<{ id: string }>).map((c) => c.id)).toContain(a.client.id);

    expect((await get()).statusCode).toBe(401);
    expect((await get(sign(token, 'otro-secreto-de-al-menos-32-caracteres!!'))).statusCode).toBe(
      401,
    );

    const expired = randomBytes(24).toString('hex');
    await db
      .insert(authSessions)
      .values({ token: expired, userId: a.owner.id, expiresAt: new Date(Date.now() - 1000) });
    expect((await get(sign(expired))).statusCode).toBe(401);
    await db.update(authUsers).set({ emailVerified: false }).where(eq(authUsers.id, a.owner.id));
    try {
      expect((await get(sign(token))).statusCode).toBe(401);
    } finally {
      await db.update(authUsers).set({ emailVerified: true }).where(eq(authUsers.id, a.owner.id));
    }
    await app.close();
  });
});

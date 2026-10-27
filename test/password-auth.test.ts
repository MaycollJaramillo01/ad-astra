import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { withContext } from '../src/db/client.ts';
import { authAccounts, invitations, memberships } from '../src/db/schema.ts';
import { provisionInvitedAccount } from '../src/platform/provision-account.ts';
import { testApp } from './app.ts';
import { seedTenant, testDb } from './seed.ts';

const db = testDb();
it('el acceso sin Workspace exige cuenta provisionada e invitación; no permite registro público y revocar membresía retira el acceso', {
  timeout: 15000,
}, async () => {
  const a = await seedTenant(db),
    email = `persona-${randomBytes(5).toString('hex')}@correo.test`,
    password = randomBytes(24).toString('base64url');
  const t = await testApp({
    realAuth: true,
    config: {
      AUTH_MODE: 'password',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_WORKSPACE_DOMAIN: '',
    },
  });
  try {
    const input = {
      tenantId: a.tenantId,
      email,
      password,
      name: 'Persona',
      reason: 'Alta manual autorizada de prueba',
    };
    await expect(provisionInvitedAccount(db, input)).rejects.toThrow('invitación');
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.insert(invitations).values({ tenantId: a.tenantId, email, role: 'analyst' }),
    );
    const id = await provisionInvitedAccount(db, input);
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.userId, id));
    expect(account?.password).not.toBe(password);
    expect(account?.password).toBeTruthy();
    expect((await t.app.inject({ method: 'GET', url: '/v1/access-options' })).json()).toEqual({
      mode: 'password',
    });
    const post = (url: string, body: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: { origin: 'http://localhost:5173' },
      });
    expect(
      (
        await post('/v1/auth/sign-up/email', {
          email: 'intruso@correo.test',
          password,
          name: 'Intruso',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post('/v1/auth/sign-in/email', { email, password: 'incorrecta-123456789' }))
        .statusCode,
    ).toBe(401);
    const login = await post('/v1/auth/sign-in/email', { email, password });
    expect(login.statusCode, login.body).toBe(200);
    let cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    expect(cookie).toContain('session_token');
    const me = () => t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect((await me()).json().memberships[0].tenantId).toBe(a.tenantId);
    const changedPassword = randomBytes(24).toString('base64url');
    const changed = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { cookie, origin: 'http://localhost:5173' },
      payload: {
        currentPassword: password,
        newPassword: changedPassword,
        revokeOtherSessions: true,
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await post('/v1/auth/sign-in/email', { email, password })).statusCode).toBe(401);
    const refreshed = await post('/v1/auth/sign-in/email', { email, password: changedPassword });
    expect(refreshed.statusCode).toBe(200);
    cookie = refreshed.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.delete(memberships).where(eq(memberships.userId, id)),
    );
    expect((await me()).json().memberships).toEqual([]);
    const again = await post('/v1/auth/sign-in/email', { email, password: changedPassword });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
  } finally {
    await t.app.close();
  }
});

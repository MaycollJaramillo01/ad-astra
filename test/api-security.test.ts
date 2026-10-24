import { beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './app.ts';
import { addClientWithAccount, addMember, type SeededTenant, seedTenant, testDb } from './seed.ts';

// Seguridad de la API: aislamiento entre tenants, RBAC, alcance por cliente, CSRF y errores.
// App y BD reales; solo la identidad viene de una cabecera de test (test/app.ts).

const db = testDb();
let t: Awaited<ReturnType<typeof testApp>>;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  t = await testApp();
  a = await seedTenant(db);
  b = await seedTenant(db);
});

describe('aislamiento entre tenants', () => {
  it('los listados solo devuelven datos del tenant propio', async () => {
    const api = t.as(a.owner);
    for (const [url, key] of [
      ['/v1/clients', 'id'],
      ['/v1/ad-accounts', 'id'],
      ['/v1/meta/connections', 'id'],
      ['/v1/findings', 'id'],
      ['/v1/recommendations', 'id'],
      ['/v1/members', 'userId'],
    ] as const) {
      const res = await api.get(url);
      expect(res.statusCode, url).toBe(200);
      const ids = (res.json() as Array<Record<string, string>>).map((r) => r[key]);
      expect(ids.length, url).toBeGreaterThan(0);
      for (const foreign of [
        b.client.id,
        b.account.id,
        b.connection.id,
        b.finding.id,
        b.recommendation.id,
        b.owner.id,
      ]) {
        expect(ids, url).not.toContain(foreign);
      }
    }
  });

  it('acceder por id a un recurso de otro tenant responde 404 (no se confirma que exista)', async () => {
    // Las mismas operaciones contra el tenant propio funcionan (control positivo: la ruta existe
    // y el 404 de abajo es del recurso, no de la ruta).
    const attempts = (target: SeededTenant, viewer: { id: string }) => {
      const api = t.as(a.owner);
      return [
        api.get(`/v1/clients/${target.client.id}`),
        api.patch(`/v1/clients/${target.client.id}`, { status: 'active' }),
        api.put(`/v1/clients/${target.client.id}/assignments`, { userIds: [] }),
        api.get(`/v1/clients/${target.client.id}/consents`),
        api.post(`/v1/clients/${target.client.id}/consents`, {
          scope: ['read_insights'],
          grantedByName: 'Cliente',
          grantedByEmail: 'firma@cliente.test',
          grantedAt: new Date().toISOString(),
        }),
        api.patch(`/v1/ad-accounts/${target.account.id}`, { syncEnabled: false }),
        api.get(`/v1/ad-accounts/${target.account.id}/campaigns`),
        api.post(`/v1/findings/${target.finding.id}/decision`, {
          status: 'acknowledged',
          reason: 'revisado',
        }),
        api.patch(`/v1/members/${viewer.id}`, { role: 'analyst' }),
        api.post(`/v1/recommendations/${target.recommendation.id}/decision`, {
          status: 'dismissed',
          reason: 'no aplica',
        }),
        api.post(`/v1/meta/connections/${target.connection.id}/revoke`),
        api.delete(`/v1/members/${viewer.id}`),
      ];
    };
    const ownViewer = await addMember(db, a.tenantId, 'viewer');
    const foreignViewer = await addMember(db, b.tenantId, 'viewer');

    for (const res of await Promise.all(attempts(b, foreignViewer))) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().title, res.body).not.toBe('Ruta no encontrada');
    }
    for (const res of await Promise.all(attempts(a, ownViewer))) {
      expect(res.statusCode, res.body).toBeLessThan(300);
    }
  });

  it('un recurso propio no se puede enlazar con un id de otro tenant', async () => {
    const res = await t
      .as(a.owner)
      .patch(`/v1/ad-accounts/${a.account.id}`, { clientId: b.client.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/no existe en esta organización/);
  });

  it('indicar un tenant ajeno en la cabecera da 403, y uno mal formado 400', async () => {
    expect((await t.as(a.owner, b.tenantId).get('/v1/clients')).statusCode).toBe(403);
    expect((await t.as(a.owner, 'no-es-un-uuid').get('/v1/clients')).statusCode).toBe(400);
  });

  it('con varias organizaciones hay que elegir la activa, y solo se ven sus datos', async () => {
    const both = await addMember(db, a.tenantId, 'viewer');
    await addMember(db, b.tenantId, 'viewer').then(() => undefined);
    const { withContext } = await import('../src/db/client.ts');
    const s = await import('../src/db/schema.ts');
    await withContext(db, { tenantId: b.tenantId }, (tx) =>
      tx.insert(s.memberships).values({ tenantId: b.tenantId, userId: both.id, role: 'admin' }),
    );
    expect((await t.as(both).get('/v1/clients')).statusCode).toBe(400);
    const inB = await t.as(both, b.tenantId).get('/v1/clients');
    expect((inB.json() as Array<{ id: string }>).map((c) => c.id)).toContain(b.client.id);
    expect((inB.json() as Array<{ id: string }>).map((c) => c.id)).not.toContain(a.client.id);
    const me = await t.as(both).get('/v1/me');
    expect(
      (me.json().memberships as Array<{ tenantId: string }>).map((m) => m.tenantId).sort(),
    ).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('el registro de eventos solo muestra eventos del tenant propio', async () => {
    await t.as(b.owner).post('/v1/clients', { name: 'Evento de B' });
    const events = (await t.as(a.owner).get('/v1/audit-log')).json() as Array<{
      action: string;
      after: unknown;
    }>;
    expect(events.some((e) => JSON.stringify(e.after).includes('Evento de B'))).toBe(false);
  });
});

describe('RBAC', () => {
  it('cada rol solo puede lo que la matriz permite', async () => {
    const viewer = await addMember(db, a.tenantId, 'viewer', [a.client.id]);
    const analyst = await addMember(db, a.tenantId, 'analyst', [a.client.id]);
    const manager = await addMember(db, a.tenantId, 'manager', [a.client.id]);

    expect((await t.as(viewer).post('/v1/clients', { name: 'No' })).statusCode).toBe(403);
    expect((await t.as(viewer).get('/v1/clients')).statusCode).toBe(200);
    expect(
      (
        await t.as(viewer).post(`/v1/findings/${a.finding.id}/decision`, {
          status: 'acknowledged',
          reason: 'visto',
        })
      ).statusCode,
    ).toBe(403);
    expect((await t.as(analyst).get('/v1/meta/connections')).statusCode).toBe(403);
    expect((await t.as(analyst).get('/v1/audit-log')).statusCode).toBe(403);
    expect(
      (
        await t.as(analyst).post(`/v1/recommendations/${a.recommendation.id}/decision`, {
          status: 'accepted',
          reason: 'ok',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await t.as(manager).post('/v1/invitations', { email: 'nuevo@agencia.test', role: 'viewer' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await t.as(analyst).post(`/v1/findings/${a.finding.id}/decision`, {
          status: 'acknowledged',
          reason: 'revisado',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('un admin no concede owner/admin ni toca a un owner, y nadie cambia su propio rol', async () => {
    const admin = await addMember(db, a.tenantId, 'admin');
    const target = await addMember(db, a.tenantId, 'viewer');
    expect(
      (await t.as(admin).patch(`/v1/members/${target.id}`, { role: 'owner' })).statusCode,
    ).toBe(403);
    expect(
      (await t.as(admin).patch(`/v1/members/${target.id}`, { role: 'analyst' })).statusCode,
    ).toBe(200);
    expect((await t.as(admin).patch(`/v1/members/${admin.id}`, { role: 'owner' })).statusCode).toBe(
      403,
    );
    expect(
      (await t.as(admin).post('/v1/invitations', { email: 'jefe@agencia.test', role: 'admin' }))
        .statusCode,
    ).toBe(403);
    expect((await t.as(admin).delete(`/v1/members/${a.owner.id}`)).statusCode).toBe(403);

    const lonelyOwner = await seedTenant(db);
    const coOwner = await addMember(db, lonelyOwner.tenantId, 'owner');
    expect(
      (await t.as(coOwner).patch(`/v1/members/${lonelyOwner.owner.id}`, { role: 'admin' }))
        .statusCode,
    ).toBe(200);
    const lastDemotion = await t
      .as(lonelyOwner.owner)
      .patch(`/v1/members/${coOwner.id}`, { role: 'admin' });
    expect(lastDemotion.statusCode).toBe(403); // ya no es owner: no puede tocar a otro owner
    const self = await t.as(coOwner).delete(`/v1/members/${coOwner.id}`);
    expect(self.statusCode).toBe(403); // ni retirarse a sí mismo dejando la organización sin owner
  });
});

describe('alcance por cliente', () => {
  it('manager, analyst y viewer solo ven los clientes asignados y sus datos', async () => {
    const other = await addClientWithAccount(db, a);
    const manager = await addMember(db, a.tenantId, 'manager', [a.client.id]);
    const api = t.as(manager);

    const clients = (await api.get('/v1/clients')).json() as Array<{ id: string }>;
    expect(clients.map((c) => c.id)).toEqual([a.client.id]);
    expect((await api.get(`/v1/clients/${other.client.id}`)).statusCode).toBe(404);

    const accounts = (await api.get('/v1/ad-accounts')).json() as Array<{ id: string }>;
    expect(accounts.map((x) => x.id)).toEqual([a.account.id]);
    expect((await api.get(`/v1/ad-accounts/${other.account.id}/campaigns`)).statusCode).toBe(404);

    const admin = (await t.as(a.owner).get('/v1/clients')).json() as Array<{ id: string }>;
    expect(admin.map((c) => c.id)).toEqual(expect.arrayContaining([a.client.id, other.client.id]));
  });
});

describe('protección de endpoints', () => {
  it('una petición que modifica sin el Origin de la app se rechaza (CSRF)', async () => {
    for (const origin of [undefined, 'https://atacante.example']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/clients',
        headers: { 'x-test-user': a.owner.id, ...(origin && { origin }) },
        payload: { name: 'csrf' },
      });
      expect(res.statusCode, String(origin)).toBe(403);
    }
  });

  it('la validación responde 400 con los campos, sin repetir los valores enviados', async () => {
    const res = await t.as(a.owner).post('/v1/clients', { name: '', extra: 'valor-secreto-xyz' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'about:blank#validation',
      errors: [expect.objectContaining({ path: 'body.name' })],
    });
    expect(res.body).not.toContain('valor-secreto-xyz');
  });

  it('los errores de integridad se traducen a 409 sin exponer SQL', async () => {
    const res = await t.as(a.owner).post('/v1/clients', { name: a.client.name });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toMatch(/insert into|duplicate key|clients_tenant_name/i);
  });

  it('cada cambio deja un evento con actor, request_id y antes/después', async () => {
    const created = await t.as(a.owner).post('/v1/clients', { name: 'Cliente con traza' });
    const events = (await t.as(a.owner).get('/v1/audit-log?limit=5')).json() as Array<
      Record<string, unknown>
    >;
    expect(events[0]).toMatchObject({
      action: 'client.created',
      actorType: 'user',
      actorId: a.owner.id,
      targetId: created.json().id,
      requestId: created.headers['x-request-id'],
      after: { name: 'Cliente con traza' },
    });
  });
});

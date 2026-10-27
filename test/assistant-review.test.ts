import { beforeAll, describe, expect, it } from 'vitest';
import type { Finding } from '../src/contracts.ts';
import { withContext } from '../src/db/client.ts';
import { findings } from '../src/db/schema.ts';
import { reviewTopics } from '../web/src/assistant-review.ts';
import { testApp } from './app.ts';
import { addMember, seedTenant, testDb } from './seed.ts';

const finding = (id: string, patch: Partial<Finding> = {}): Finding => ({
  id,
  adAccountId: 'account-a',
  kind: 'audit',
  ruleId: 'R-EFF-002',
  ruleVersion: 1,
  entityLevel: 'campaign',
  entityMetaId: id,
  severity: 'high',
  confidence: '0.9',
  priority: '0.7',
  impact: null,
  evidence: null,
  recommendationKey: 'review',
  status: 'open',
  firstSeenAt: '2026-10-25T00:00:00Z',
  lastSeenAt: '2026-10-26T00:00:00Z',
  decisionReason: null,
  category: 'efficiency',
  profile: null,
  explanation: null,
  recommendationText: null,
  engineVersion: null,
  windowStart: null,
  windowEnd: null,
  resolvedAt: null,
  ...patch,
});

describe('prioridades de revisión', () => {
  it('conserva el orden del motor, agrupa repeticiones por regla y cuenta y excluye cerrados', () => {
    const topics = reviewTopics([
      finding('low', { priority: '0.2' }),
      finding('top', { priority: '0.95' }),
      finding('other-rule', { ruleId: 'R-DATA-001', priority: '0.8' }),
      finding('other-account', { adAccountId: 'account-b', priority: '0.75' }),
      finding('closed', { status: 'resolved', priority: '1' }),
      finding('dismissed', { status: 'dismissed', priority: '1' }),
    ]);
    expect(topics.map((t) => [t.finding.id, t.count])).toEqual([
      ['top', 2],
      ['other-rule', 1],
      ['other-account', 1],
    ]);
  });
  it('resuelve empates de forma estable, limita temas y no inventa prioridad para valores inválidos', () => {
    const rows = [
      finding('b', { ruleId: 'b' }),
      finding('a', { ruleId: 'a' }),
      finding('bad', { ruleId: 'bad', priority: 'NaN' }),
    ];
    expect(reviewTopics(rows, 2).map((t) => t.finding.id)).toEqual(['a', 'b']);
    expect(rows.map((f) => f.id)).toEqual(['b', 'a', 'bad']);
    expect(reviewTopics([])).toEqual([]);
  });
});

describe('selección acotada y autorizada de hallazgos', () => {
  const db = testDb();
  let t: Awaited<ReturnType<typeof testApp>>;
  let a: Awaited<ReturnType<typeof seedTenant>>;
  let b: Awaited<ReturnType<typeof seedTenant>>;
  beforeAll(async () => {
    t = await testApp();
    a = await seedTenant(db);
    b = await seedTenant(db);
    await withContext(db, { tenantId: a.tenantId }, (tx) =>
      tx.insert(findings).values({
        ...a.finding,
        id: undefined,
        fingerprint: `${a.finding.fingerprint}:extra`,
        priority: '0.1',
      }),
    );
  });
  it('limita después de aplicar alcance y conserva la lista anterior cuando no se pide límite', async () => {
    const api = t.as(a.owner, a.tenantId);
    const res = await api.get('/v1/findings?status=open&limit=1');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().map((f: Finding) => f.id)).toEqual([a.finding.id]);
    expect((await api.get('/v1/findings?status=open')).json()).toHaveLength(2);
    expect(
      (await api.get(`/v1/findings?status=open&limit=1&adAccountId=${b.account.id}`)).json(),
    ).toEqual([]);
  });
  it('no amplía los clientes asignados y rechaza límites fuera de rango', async () => {
    const outsider = await addMember(db, a.tenantId, 'analyst');
    expect((await t.as(outsider, a.tenantId).get('/v1/findings?limit=50')).json()).toEqual([]);
    for (const limit of ['0', '101', '-1', 'NaN'])
      expect((await t.as(a.owner, a.tenantId).get(`/v1/findings?limit=${limit}`)).statusCode).toBe(
        400,
      );
  });
  it('agrupa antes de limitar y cuenta solo hallazgos del alcance y estado solicitados', async () => {
    const c = await seedTenant(db);
    await withContext(db, { tenantId: c.tenantId }, async (tx) => {
      await tx.insert(findings).values([
        ...Array.from({ length: 7 }, (_, i) => ({
          ...c.finding,
          id: undefined,
          fingerprint: `grouped:${i}`,
          priority: '0.95',
        })),
        {
          ...c.finding,
          id: undefined,
          fingerprint: 'next-topic',
          ruleId: 'R-DATA-001',
          priority: '0.8',
        },
        {
          ...c.finding,
          id: undefined,
          fingerprint: 'closed-topic',
          priority: '1',
          status: 'resolved' as const,
        },
      ]);
    });
    const res = await t
      .as(c.owner, c.tenantId)
      .get('/v1/findings?status=open&groupBy=account_rule&limit=2');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().map((f: Finding) => [f.ruleId, f.groupedCount])).toEqual([
      [c.finding.ruleId, 8],
      ['R-DATA-001', 1],
    ]);
    const outsider = await addMember(db, c.tenantId, 'analyst');
    expect(
      (
        await t
          .as(outsider, c.tenantId)
          .get('/v1/findings?status=open&groupBy=account_rule&limit=2')
      ).json(),
    ).toEqual([]);
  });
});

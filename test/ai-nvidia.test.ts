import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AiStatus, AiTurn } from '../src/contracts.ts';
import { withContext } from '../src/db/client.ts';
import { clientConsents, llmUsage } from '../src/db/schema.ts';
import { NVIDIA_MODEL, nvidiaProvider } from '../src/modules/ai/nvidia.ts';
import { testApp } from './app.ts';
import { seedTenant, testDb } from './seed.ts';

const key = `nvapi-${'fake'.repeat(12)}`;

describe('asistente con adaptador NVIDIA y app reales, transporte simulado', () => {
  it('consulta herramientas con RLS, verifica la respuesta y continúa la conversación', async () => {
    const db = testDb();
    const tenant = await seedTenant(db, `nvidia-${crypto.randomUUID().slice(0, 8)}`);
    await withContext(db, { tenantId: tenant.tenantId }, (tx) =>
      tx.insert(clientConsents).values({
        tenantId: tenant.tenantId,
        clientId: tenant.client.id,
        scope: ['read_insights', 'ai_processing'],
        grantedByName: 'Prueba',
        grantedByEmail: 'prueba@example.test',
        grantedAt: new Date(),
        recordedBy: tenant.owner.id,
      }),
    );
    const bodies: Array<{
      messages: Array<{
        role: string;
        content?: string;
        tool_call_id?: string;
        tool_calls?: unknown[];
      }>;
    }> = [];
    const llm = nvidiaProvider({
      apiKey: key,
      inputBudgetRate: 4,
      outputBudgetRate: 20,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        const answer = bodies.length % 2 === 0;
        const args = answer
          ? {
              summary: 'Consulta de alcance completada.',
              dataSufficiency: { status: 'limited', reasons: ['No se consultaron métricas.'] },
              claims: [],
              hypotheses: [],
              recommendations: [],
              followUpQuestions: [],
            }
          : {};
        return new Response(
          JSON.stringify({
            model: NVIDIA_MODEL,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `c_${bodies.length}`,
                      type: 'function',
                      function: {
                        name: answer ? 'submit_answer' : 'get_scope',
                        arguments: JSON.stringify(args),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
          }),
        );
      }) as typeof fetch,
    });
    const t = await testApp({ llm, config: { AI_PROVIDER: 'nvidia', AI_MODEL: NVIDIA_MODEL } });
    try {
      const status = (
        await t.as(tenant.owner, tenant.tenantId).get('/v1/ai/status')
      ).json() as AiStatus;
      expect(status).toMatchObject({
        enabled: true,
        provider: 'nvidia',
        model: NVIDIA_MODEL,
        costBasis: 'budget_estimate',
        unavailableReason: null,
      });
      const ask = (conversationId: string | null) =>
        t
          .as(tenant.owner, tenant.tenantId)
          .post('/v1/ai/ask', { question: 'Consulta el alcance autorizado.', conversationId });
      const res = await ask(null);
      expect(res.statusCode, res.body).toBe(200);
      const first = res.json() as AiTurn;
      expect(first.message.status).toBe('answered');
      expect(first.message.evidence[0]?.tool).toBe('get_scope');
      expect(first.message.costUsd).toBeGreaterThan(0);
      const next = await ask(first.conversationId);
      expect(next.statusCode, next.body).toBe(200);
      expect((next.json() as AiTurn).message.status).toBe('answered');
      expect(bodies).toHaveLength(4);
      // El submit_answer del turno anterior recibe su resultado antes de la nueva pregunta.
      const messages = bodies[2]?.messages ?? [];
      const pending = messages.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'c_2');
      expect(pending).toBeGreaterThan(0);
      expect(messages[pending + 1]?.role).toBe('user');
      expect(JSON.stringify(bodies)).not.toMatch(/cifrado-de-prueba|deadbeef|token_ciphertext/);
      expect(t.logs()).not.toContain(key);
      const usage = await withContext(db, { tenantId: tenant.tenantId }, (tx) =>
        tx.select().from(llmUsage).where(eq(llmUsage.conversationId, first.conversationId)),
      );
      expect(usage).toHaveLength(4);
      expect(usage.every((u) => u.provider === 'nvidia' && u.status === 'ok')).toBe(true);
    } finally {
      await t.app.close();
    }
  });

  it('informa el bloqueo operativo y no llama a NVIDIA cuando el entorno no está vinculado', async () => {
    const tenant = await seedTenant(testDb());
    let calls = 0;
    const llm = nvidiaProvider({
      apiKey: key,
      inputBudgetRate: 4,
      outputBudgetRate: 20,
      fetch: (async () => {
        calls++;
        throw new Error('No debe llamar');
      }) as typeof fetch,
    });
    const t = await testApp({
      llm,
      config: { AI_PROVIDER: 'nvidia', AI_MODEL: NVIDIA_MODEL, APP_ENV: 'production' },
    });
    try {
      const status = await t.as(tenant.owner, tenant.tenantId).get('/v1/ai/status');
      expect(status.statusCode, status.body).toBe(503);
      const res = await t
        .as(tenant.owner, tenant.tenantId)
        .post('/v1/ai/ask', { question: 'Consulta el alcance.' });
      expect(res.statusCode, res.body).toBe(503);
      expect(calls).toBe(0);
    } finally {
      await t.app.close();
    }
  });
});

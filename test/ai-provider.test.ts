import { describe, expect, it } from 'vitest';
import { anthropicProvider, strictSchema } from '../src/modules/ai/anthropic.ts';
import { TOOL_DEFS } from '../src/modules/ai/assistant.ts';
import { costOf, LlmError, type LlmRequest } from '../src/modules/ai/provider.ts';
import { TOOLS } from '../src/modules/ai/tools.ts';

// Proveedor Anthropic contra un fetch falso: se comprueba la petición que saldría hacia la API
// y la normalización de la respuesta. Sin red ni clave real (la clave es de mentira).

const FAKE_KEY = 'clave-de-prueba-no-real-000000';

function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_test_1' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'firma-opaca' },
    { type: 'text', text: 'Consulto el alcance.' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_scope', input: {} },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 0,
  },
  ...over,
});

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  system: 'Sistema',
  tools: TOOL_DEFS,
  messages: [{ role: 'user', content: [{ type: 'text', text: '¿Qué tal la cuenta?' }] }],
  maxTokens: 16000,
  effort: 'medium',
  ...over,
});

describe('petición a la API', () => {
  it('usa pensamiento adaptativo, esfuerzo explícito, herramientas estrictas, caché y respaldo', async () => {
    const f = fakeFetch({ body: message() });
    await anthropicProvider({
      apiKey: FAKE_KEY,
      model: 'claude-opus-5-5',
      fetch: f.fetch,
    }).generate(request());
    const [call] = f.calls;
    expect(call?.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(call?.headers.get('anthropic-beta')).toBe('thinking-binding-controls-2026-08-01');
    const body = call?.body ?? {};
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'Sistema',
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    });
    // Sin parámetros de muestreo (400 en los modelos actuales) ni uso forzado de herramientas.
    for (const k of ['temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(k);
    const tools = body.tools as Array<{ name: string; strict: boolean; input_schema: unknown }>;
    expect(tools.map((t) => t.name)).toEqual([...TOOLS.map((t) => t.name), 'submit_answer']);
    for (const t of tools) {
      expect(t.strict, t.name).toBe(true);
      const text = JSON.stringify(t.input_schema);
      // El modo estricto no admite estas palabras clave; zod sigue validándolas al recibir.
      expect(text, t.name).not.toMatch(
        /"(minimum|maximum|minLength|maxLength|maxItems|minItems|pattern|\$schema)"/,
      );
    }
  });

  it('todo objeto del esquema estricto exige todas sus propiedades y no admite otras', () => {
    const walk = (s: unknown, path: string) => {
      if (!s || typeof s !== 'object') return;
      const o = s as Record<string, unknown>;
      if (o.type === 'object') {
        expect(o.additionalProperties, path).toBe(false);
        expect(o.required, path).toEqual(Object.keys((o.properties as object) ?? {}));
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    for (const t of TOOL_DEFS) walk(strictSchema(t.inputSchema), t.name);
  });

  it('reenvía sin tocar el contenido nativo del asistente y los mensajes de sistema intermedios', async () => {
    const f = fakeFetch({ body: message() });
    const native = message().content;
    await anthropicProvider({
      apiKey: FAKE_KEY,
      model: 'claude-opus-5-5',
      fetch: f.fetch,
    }).generate(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Pregunta' }] },
          { role: 'system', content: [{ type: 'text', text: 'Contexto del operador' }] },
          { role: 'assistant', content: [], native },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'toolu_1', content: '{"x":1}', isError: false },
            ],
          },
        ],
      }),
    );
    expect(f.calls[0]?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Pregunta' }] },
      { role: 'system', content: 'Contexto del operador' },
      { role: 'assistant', content: native },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"x":1}', is_error: false },
        ],
      },
    ]);
  });
});

describe('respuesta', () => {
  it('normaliza bloques, uso y costo, y conserva el contenido nativo', async () => {
    const f = fakeFetch({ body: message() });
    const r = await anthropicProvider({
      apiKey: FAKE_KEY,
      model: 'claude-opus-5-5',
      fetch: f.fetch,
    }).generate(request());
    expect(r).toMatchObject({
      stopReason: 'tool_use',
      model: 'claude-opus-5-5',
      fallback: false,
      requestId: 'req_test_1',
      usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 },
    });
    expect(r.message.content).toEqual([
      { type: 'text', text: 'Consulto el alcance.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_scope', input: {} },
    ]);
    expect(r.message.native).toEqual(message().content);
    // 1000 × 4 $ + 200 × 20 $ + 5000 × 0,20 $ por millón
    expect(r.costUsd).toBeCloseTo(0.009, 9);
  });

  it('rechaza un modelo de respaldo no autorizado en lugar de subestimar su costo', async () => {
    const usage = { ...message().usage, iterations: [{ type: 'fallback_message' }] };
    const f = fakeFetch({ body: message({ model: 'claude-opus-5', usage }) });
    await expect(
      anthropicProvider({
        apiKey: FAKE_KEY,
        model: 'claude-opus-5-5',
        fetch: f.fetch,
      }).generate(request()),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(f.calls).toHaveLength(1);
    expect(() =>
      costOf('modelo-desconocido', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    ).toThrow('Modelo sin tarifa verificada');
  });

  it('un rechazo llega como stop_reason refusal', async () => {
    const f = fakeFetch({ body: message({ stop_reason: 'refusal', content: [] }) });
    const r = await anthropicProvider({
      apiKey: FAKE_KEY,
      model: 'claude-opus-5-5',
      fetch: f.fetch,
    }).generate(request());
    expect(r.stopReason).toBe('refusal');
  });

  it('clasifica los errores sin exponer la clave', async () => {
    const error = (status: number) =>
      fakeFetch({ status, body: { type: 'error', error: { type: 'x', message: 'detalle' } } });
    for (const [status, kind] of [
      [400, 'rejected'],
      [401, 'auth'],
    ] as const) {
      const f = error(status);
      const p = anthropicProvider({
        apiKey: FAKE_KEY,
        model: 'claude-opus-5-5',
        fetch: f.fetch,
      }).generate(request());
      await expect(p).rejects.toBeInstanceOf(LlmError);
      await expect(p).rejects.toMatchObject({ kind });
      await p.catch((e: Error) => expect(e.message).not.toContain(FAKE_KEY));
    }
  });
});

import { describe, expect, it } from 'vitest';
import { NVIDIA_MODEL, nvidiaProvider } from '../src/modules/ai/nvidia.ts';
import { createProvider, type LlmRequest, reserveOf } from '../src/modules/ai/provider.ts';
import { loadConfig } from '../src/platform/config.ts';

const KEY = `nvapi-${'canary'.repeat(8)}`;
const request: LlmRequest = {
  system: 'Sistema de prueba',
  tools: [
    {
      name: 'get_scope',
      description: 'Consulta sintética',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Pregunta de prueba' }] }],
  maxTokens: 512,
  effort: 'low',
};
const call = {
  id: 'call_test',
  type: 'function',
  function: { name: 'get_scope', arguments: '{}' },
};
const reply = (over: Record<string, unknown> = {}) => ({
  model: 'private/nvidia/nemotron-3.5-super-120b-a12b',
  choices: [
    {
      message: { role: 'assistant', content: null, tool_calls: [call] },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 500 },
  },
  ...over,
});
function mock(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  const fetch = (async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'x-request-id': 'request-test' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const provider = (fetch: typeof globalThis.fetch) =>
  nvidiaProvider({ apiKey: KEY, inputBudgetRate: 4, outputBudgetRate: 20, fetch });

describe('NVIDIA NIM: contrato y seguridad', () => {
  it('selecciona NVIDIA por configuración sin reutilizar una clave o un modelo de Anthropic', async () => {
    const config = loadConfig({
      ...process.env,
      AI_PROVIDER: 'nvidia',
      AI_MODEL: '',
      NVIDIA_API_KEY: KEY,
    });
    expect(config.AI_MODEL).toBe(NVIDIA_MODEL);
    expect((await createProvider(config))?.id).toBe('nvidia');
    expect(await createProvider({ ...config, NVIDIA_API_KEY: undefined })).toBeNull();
    expect(() =>
      loadConfig({ ...process.env, AI_PROVIDER: 'nvidia', AI_MODEL: 'claude-opus-5-5' }),
    ).toThrow('Modelo incompatible');
    expect(() =>
      loadConfig({
        ...process.env,
        AI_PROVIDER: 'nvidia',
        NVIDIA_BUDGET_INPUT_USD_PER_MILLION: '0',
      }),
    ).toThrow('NVIDIA_BUDGET_INPUT');
  });

  it('envía credenciales solo a HTTPS fijo, sin redirecciones, streaming ni reintentos', async () => {
    const f = mock(reply());
    const r = await provider(f.fetch).generate(request);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(new Headers(f.calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(f.calls[0]?.init?.redirect).toBe('error');
    expect(f.calls[0]?.body).toMatchObject({
      model: NVIDIA_MODEL,
      stream: false,
      reasoning_effort: 'low',
      max_tokens: 512,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
    expect(r).toMatchObject({
      stopReason: 'tool_use',
      model: reply().model,
      fallback: false,
      requestId: 'request-test',
      usage: { input: 500, output: 200, cacheRead: 500, cacheWrite: 0 },
    });
    expect(r.costUsd).toBeCloseTo(0.008, 9);
    const p = provider(f.fetch);
    expect(p.costBasis).toBe('budget_estimate');
    expect(reserveOf(p.model, request, p.pricing)).toBeGreaterThan(0.01);
  });

  it('preserva el sistema y reenvía resultados pendientes antes de la pregunta siguiente', async () => {
    const f = mock(reply());
    await provider(f.fetch).generate({
      ...request,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Contexto del operador' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'prior', name: 'get_scope', input: {} }],
          native: 'no reenviar contenido de otro proveedor',
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'prior', content: 'Denegado', isError: true },
            { type: 'text', text: 'Siguiente pregunta' },
          ],
        },
      ],
    });
    expect(f.calls[0]?.body.messages).toEqual([
      { role: 'system', content: request.system },
      { role: 'system', content: 'Contexto del operador' },
      { role: 'assistant', content: null, tool_calls: [{ ...call, id: 'prior' }] },
      { role: 'tool', tool_call_id: 'prior', content: '{"error":true,"message":"Denegado"}' },
      { role: 'user', content: 'Siguiente pregunta' },
    ]);
  });

  it.each([
    [400, 'rejected'],
    [404, 'rejected'],
    [422, 'rejected'],
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [202, 'unavailable'],
  ] as const)(
    'clasifica HTTP %s sin exponer el cuerpo ni repetir inferencias',
    async (status, kind) => {
      const f = mock({ error: { message: `${KEY} prompt-privado` } }, status);
      const error = await provider(f.fetch)
        .generate(request)
        .catch((e: Error) => e);
      expect(error).toMatchObject({ kind });
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(String(error)).not.toContain('prompt-privado');
      expect(f.calls).toHaveLength(1);
    },
  );

  it.each([
    reply({ model: 'modelo-no-autorizado' }),
    reply({ usage: { prompt_tokens: -1, completion_tokens: 200, total_tokens: 199 } }),
    reply({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 999 } }),
    reply({
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    }),
    reply({ usage: undefined }),
    reply({ usage: { prompt_tokens: 1000, completion_tokens: 513, total_tokens: 1513 } }),
    reply({
      choices: [
        { message: { role: 'assistant', tool_calls: [call, call] }, finish_reason: 'tool_calls' },
      ],
    }),
    reply({
      choices: [{ message: { role: 'assistant', tool_calls: [call] }, finish_reason: 'length' }],
    }),
    reply({
      choices: [{ message: { role: 'assistant', tool_calls: [] }, finish_reason: 'tool_calls' }],
    }),
    reply({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ ...call, function: { name: 'get_scope', arguments: '{' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    reply({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ ...call, function: { name: 'write_budget', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  ])('retiene como incierto un resultado inválido (%#)', async (body) => {
    const f = mock(body);
    await expect(provider(f.fetch).generate(request)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(f.calls).toHaveLength(1);
  });

  it('normaliza texto, límite de tokens y rechazo', async () => {
    for (const [finish, expected] of [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
    ]) {
      const f = mock(
        reply({
          choices: [{ message: { role: 'assistant', content: 'Texto' }, finish_reason: finish }],
        }),
      );
      expect((await provider(f.fetch).generate(request)).stopReason).toBe(expected);
    }
  });

  it('no propaga errores de red con secretos ni un JSON ilegible', async () => {
    for (const fetch of [
      (async () => {
        throw new Error(KEY);
      }) as typeof globalThis.fetch,
      (async () => new Response('{')) as typeof globalThis.fetch,
    ])
      await expect(provider(fetch).generate(request)).rejects.toMatchObject({
        kind: 'unavailable',
        message: expect.not.stringContaining(KEY),
      });
  });
});

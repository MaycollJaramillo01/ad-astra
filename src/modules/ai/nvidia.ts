import { z } from 'zod';
import {
  costOf,
  type LlmBlock,
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type Price,
  type StopReason,
} from './provider.ts';

export const NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
// Alias observado en las pruebas reales del 2026-10-27. No se permiten respaldos arbitrarios.
const MODEL_IDS = new Set([NVIDIA_MODEL, 'private/nvidia/nemotron-3.5-super-120b-a12b']);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const toolCall = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string() }),
});
const assistantMessage = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  refusal: z.string().nullable().optional(),
  tool_calls: z.array(toolCall).max(32).optional(),
});
const completion = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: assistantMessage,
        finish_reason: z.string(),
      }),
    )
    .length(1),
  usage: z.object({
    prompt_tokens: tokens,
    completion_tokens: tokens,
    total_tokens: tokens,
    prompt_tokens_details: z
      .object({ cached_tokens: tokens.nullable().optional() })
      .nullable()
      .optional(),
  }),
});

type NativeMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: z.infer<typeof toolCall>[];
};

/** Conserva el canal de sistema y ordena resultados de herramientas antes del nuevo texto. */
function toNative(message: LlmMessage): NativeMessage[] {
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (message.role === 'assistant') {
    const calls = message.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    return [
      { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
    ];
  }
  const results: NativeMessage[] = message.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({
      role: 'tool',
      tool_call_id: b.toolUseId,
      content: b.isError ? JSON.stringify({ error: true, message: b.content }) : b.content,
    }));
  if (text) results.push({ role: message.role, content: text });
  return results;
}

const STOP: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/** NIM compatible con Chat Completions. Sin reintentos de inferencias de resultado incierto. */
export function nvidiaProvider(opts: {
  apiKey: string;
  inputBudgetRate: number;
  outputBudgetRate: number;
  /** Sustitución de red exclusivamente para pruebas. El endpoint no depende de entradas del LLM. */
  fetch?: typeof fetch;
}): LlmProvider {
  const pricing: Price = {
    input: opts.inputBudgetRate,
    output: opts.outputBudgetRate,
    // No se asumen descuentos de caché: se valora toda la entrada a la misma tasa.
    cacheRead: opts.inputBudgetRate,
    cacheWrite: opts.inputBudgetRate,
  };
  return {
    id: 'nvidia',
    model: NVIDIA_MODEL,
    pricing,
    costBasis: 'budget_estimate',
    async generate(req) {
      const started = performance.now();
      let response: Response;
      try {
        response = await (opts.fetch ?? fetch)(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify({
            model: NVIDIA_MODEL,
            stream: false,
            max_tokens: req.maxTokens,
            reasoning_effort: req.effort === 'low' ? 'low' : 'high',
            messages: [{ role: 'system', content: req.system }, ...req.messages.flatMap(toNative)],
            ...(req.tools.length
              ? {
                  tools: req.tools.map((t) => ({
                    type: 'function',
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.inputSchema,
                    },
                  })),
                  tool_choice: 'auto',
                  parallel_tool_calls: false,
                }
              : {}),
          }),
        });
      } catch {
        throw new LlmError(
          'unavailable',
          'NVIDIA no disponible o inferencia de resultado incierto',
        );
      }
      // Nunca se incluyen cuerpos de error, cabeceras de autorización ni prompts en los errores.
      if (response.status === 401 || response.status === 403)
        throw new LlmError('auth', 'Credencial de NVIDIA no válida o sin permiso');
      if (response.status === 429)
        throw new LlmError('rate_limited', 'Límite de peticiones de NVIDIA');
      if ([400, 404, 422].includes(response.status))
        throw new LlmError('rejected', 'Petición rechazada por NVIDIA');
      if (response.status !== 200)
        throw new LlmError(
          'unavailable',
          'NVIDIA no entregó un resultado de inferencia definitivo',
        );

      try {
        const parsed = completion.safeParse(await response.json());
        if (!parsed.success) throw new Error('schema');
        const result = parsed.data;
        if (!MODEL_IDS.has(result.model)) throw new Error('model');
        const choice = result.choices[0];
        if (!choice) throw new Error('choice');
        const u = result.usage;
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        if (
          cached > u.prompt_tokens ||
          u.completion_tokens > req.maxTokens ||
          u.total_tokens !== u.prompt_tokens + u.completion_tokens
        )
          throw new Error('usage');
        const calls = choice.message.tool_calls ?? [];
        if (new Set(calls.map((c) => c.id)).size !== calls.length) throw new Error('duplicate');
        if (calls.length && choice.finish_reason !== 'tool_calls') throw new Error('partial-tools');
        if (choice.finish_reason === 'tool_calls' && !calls.length)
          throw new Error('missing-tools');
        const content: LlmBlock[] = [];
        if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
        for (const call of calls) {
          if (!req.tools.some((t) => t.name === call.function.name)) throw new Error('tool');
          const input: unknown = JSON.parse(call.function.arguments);
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error('arguments');
          content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
        const usage = {
          input: u.prompt_tokens - cached,
          output: u.completion_tokens,
          cacheRead: cached,
          cacheWrite: 0,
        };
        return {
          stopReason: choice.message.refusal
            ? ('refusal' as const)
            : (STOP[choice.finish_reason] ?? 'other'),
          message: { role: 'assistant' as const, content },
          usage,
          costUsd: costOf(NVIDIA_MODEL, usage, pricing),
          model: result.model,
          fallback: false,
          latencyMs: Math.round(performance.now() - started),
          requestId: response.headers.get('x-request-id') ?? response.headers.get('nvcf-reqid'),
        };
      } catch {
        throw new LlmError(
          'unavailable',
          'Respuesta de NVIDIA inválida; conciliar antes de reintentar',
        );
      }
    },
  };
}

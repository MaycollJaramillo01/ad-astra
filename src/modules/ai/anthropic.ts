import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  costOf,
  type LlmBlock,
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type StopReason,
} from './provider.ts';

// Proveedor Anthropic (docs/API_INTEGRATIONS.md §2.2). Decisiones de la petición:
// - pensamiento adaptativo (en Opus 5.5 no se puede desactivar) y `effort` explícito;
// - herramientas `strict` con `tool_choice: auto` (el uso forzado devuelve 400 en Opus 5.5);
// - caché de prompts automática: herramientas y sistema son estables, lo volátil va en mensajes;
// - sin reintentos ni cambios automáticos de modelo: cada llamada tiene reserva de costo;
// - los bloques de pensamiento se reenvían tal cual; si un cambio de prompt invalida uno antiguo,
//   se descarta (`drop_block`) en lugar de fallar la conversación.

const BETAS = ['thinking-binding-controls-2026-08-01'];

// El modo estricto no admite restricciones numéricas, de longitud ni de tamaño de array: se
// quitan del esquema enviado y se siguen validando con zod al recibir la llamada.
const UNSUPPORTED = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
]);
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED.has(k)) continue;
    out[k] =
      k === 'properties'
        ? Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, strictSchema(s)]))
        : strictSchema(v);
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys((out.properties as object | undefined) ?? {});
  }
  return out;
}

function toNative(m: LlmMessage): BetaMessageParam {
  if (m.role === 'system') {
    return {
      role: 'system',
      content: m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    };
  }
  if (m.role === 'assistant' && m.native)
    return { role: 'assistant', content: m.native as BetaContentBlockParam[] };
  const content: BetaContentBlockParam[] = m.content.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        };
      default:
        return {
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content,
          is_error: b.isError,
        };
    }
  });
  return { role: m.role, content };
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

export function anthropicProvider(opts: {
  apiKey: string;
  model: string;
  /** Solo los tests lo sustituyen (sin red ni clave real). */
  fetch?: typeof fetch;
}): LlmProvider {
  // El SDK reintenta 408, 409, 429 y 5xx con espera exponencial.
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: 0,
    timeout: 180_000,
    fetch: opts.fetch,
  });

  return {
    id: 'anthropic',
    model: opts.model,
    async generate(req: LlmRequest) {
      const body: MessageCreateParamsNonStreaming & { betas: string[] } = {
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: strictSchema(t.inputSchema) as { type: 'object' },
          strict: true,
        })),
        tool_choice: { type: 'auto' },
        messages: req.messages.map(toNative),
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        output_config: { effort: req.effort },
        cache_control: { type: 'ephemeral' },
        betas: BETAS,
      };
      const started = performance.now();
      let response: Awaited<ReturnType<typeof client.beta.messages.create>>;
      let requestId: string | null;
      try {
        const { data, request_id } = await client.beta.messages.create(body).withResponse();
        response = data as typeof response;
        requestId = request_id ?? null;
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError)
          throw new LlmError('rate_limited', 'Límite de peticiones del proveedor');
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError
        )
          throw new LlmError('auth', 'Credencial del proveedor no válida');
        if (error instanceof Anthropic.BadRequestError)
          throw new LlmError('rejected', 'Petición rechazada por el proveedor');
        if (error instanceof Anthropic.APIError || error instanceof Anthropic.APIConnectionError)
          throw new LlmError('unavailable', 'Proveedor no disponible');
        throw error;
      }
      if (!('content' in response))
        throw new LlmError('unavailable', 'Respuesta inesperada del proveedor');
      if (response.model !== opts.model)
        throw new LlmError(
          'unavailable',
          'Modelo de respuesta distinto al autorizado; conciliar costo antes de reintentar.',
        );

      const content: LlmBlock[] = [];
      for (const b of response.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use')
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
      const u = response.usage;
      const usage = {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      };
      return {
        stopReason: STOP[response.stop_reason ?? ''] ?? 'other',
        message: { role: 'assistant', content, native: response.content },
        usage,
        costUsd: costOf(response.model, usage),
        model: response.model,
        fallback: (u.iterations ?? []).some((i) => i.type === 'fallback_message'),
        latencyMs: Math.round(performance.now() - started),
        requestId,
      };
    },
  };
}

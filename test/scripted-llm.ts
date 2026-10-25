import {
  costOf,
  type LlmBlock,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from '../src/modules/ai/provider.ts';

// Proveedor guionizado para los tests y las evaluaciones deterministas: cada llamada ejecuta el
// paso siguiente del guion (el último se repite). Solo existe en test/: la aplicación real nunca
// lo usa, y sin clave el asistente responde 503 en lugar de simular.

export type Reply = LlmBlock[] | { refusal: true } | { text: string };
export type Step = (req: LlmRequest) => Reply;

let seq = 0;
export const use = (name: string, input: unknown): LlmBlock => ({
  type: 'tool_use',
  id: `toolu_${++seq}`,
  name,
  input,
});

/** Resultados de herramientas del último mensaje del usuario (JSON si no son error). */
export function results(req: LlmRequest) {
  const last = req.messages.at(-1);
  return (last?.content ?? [])
    .filter((b): b is Extract<LlmBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => ({
      isError: b.isError,
      content: b.content,
      // biome-ignore lint/suspicious/noExplicitAny: salida de herramienta, se inspecciona en el test.
      json: (b.isError ? null : JSON.parse(b.content)) as any,
    }));
}

export function scripted(steps: Step[], model = 'claude-opus-5-5') {
  const requests: LlmRequest[] = [];
  const responses: LlmResult[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    model,
    async generate(req) {
      requests.push(structuredClone(req));
      const step = steps[Math.min(requests.length, steps.length) - 1] as Step;
      const reply = step(req);
      const content: LlmBlock[] = Array.isArray(reply)
        ? reply
        : 'text' in reply
          ? [{ type: 'text', text: reply.text }]
          : [];
      const usage = { input: 2000, output: 300, cacheRead: 0, cacheWrite: 0 };
      const result: LlmResult = {
        stopReason:
          !Array.isArray(reply) && 'refusal' in reply
            ? 'refusal'
            : content.some((b) => b.type === 'tool_use')
              ? 'tool_use'
              : 'end_turn',
        // El "nativo" de un proveedor real llevaría los bloques de pensamiento con su firma.
        message: {
          role: 'assistant',
          content,
          native: [
            { type: 'thinking', thinking: '', signature: `sig-${requests.length}` },
            ...content,
          ],
        },
        usage,
        costUsd: costOf(model, usage),
        model,
        fallback: false,
        latencyMs: 5,
        requestId: null,
      };
      responses.push(structuredClone(result));
      return result;
    },
  };
  return { provider, requests, responses };
}

/** Proveedor intercambiable: una sola app de test y un guion distinto por caso. */
export function switchable() {
  let current = scripted([() => ({ text: 'sin guion' })]);
  const provider: LlmProvider = {
    id: 'anthropic',
    model: 'claude-opus-5-5',
    generate: (req) => current.provider.generate(req),
  };
  return {
    provider,
    play(steps: Step[]) {
      current = scripted(steps);
      return current;
    },
  };
}

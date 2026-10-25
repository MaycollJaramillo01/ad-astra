import type { Config } from '../../platform/config.ts';

// Interfaz neutral de proveedores LLM (docs/API_INTEGRATIONS.md §2.1). El resto del sistema solo
// ve LlmProvider: mensajes, herramientas con esquema JSON y un resultado normalizado con uso y
// costo. No hay parámetros de muestreo: los modelos actuales los rechazan.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface LlmMessage {
  /** `system` intermedio: canal del operador, con más autoridad que los datos de las herramientas. */
  role: 'user' | 'assistant' | 'system';
  content: LlmBlock[];
  /** Contenido nativo del proveedor (con los bloques de pensamiento), que se reenvía sin tocar. */
  native?: unknown;
}

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  tools: LlmTool[];
  messages: LlmMessage[];
  maxTokens: number;
  effort: Effort;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface LlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LlmResult {
  stopReason: StopReason;
  message: LlmMessage;
  usage: LlmUsage;
  costUsd: number;
  /** El modelo que respondió: puede ser el de respaldo si el pedido rechazó la petición. */
  model: string;
  fallback: boolean;
  latencyMs: number;
  requestId: string | null;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResult>;
}

/** Fallo del proveedor ya clasificado; el mensaje nunca incluye la clave ni el contenido. */
export class LlmError extends Error {
  readonly kind: 'rate_limited' | 'unavailable' | 'rejected' | 'auth';
  constructor(kind: LlmError['kind'], message: string) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

// USD por millón de tokens (referencia del SDK, 2026-10). Incluye los modelos a los que el
// servidor deriva una petición rechazada (`fallbacks: "default"`).
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const PRICING: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
// Un modelo sin precio conocido se cobra al más caro: el presupuesto nunca se queda corto.
const PRICIEST = PRICING['claude-opus-5'] as Price;

export function costOf(model: string, u: LlmUsage): number {
  const p = PRICING[model] ?? PRICIEST;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite) /
    1e6
  );
}

/**
 * Reserva antes de enviar: entrada estimada (≈3 caracteres por token, sin contar la caché) más
 * un cuarto de `maxTokens` de salida. Es una cota para no empezar una llamada sin saldo, no el costo.
 */
export function reserveOf(model: string, req: LlmRequest): number {
  const chars =
    req.system.length + JSON.stringify(req.tools).length + JSON.stringify(req.messages).length;
  return costOf(model, {
    input: chars / 3,
    output: req.maxTokens / 4,
    cacheRead: 0,
    cacheWrite: 0,
  });
}

/** Proveedor configurado, o null si falta su clave (la IA queda desactivada, sin simulación). */
export async function createProvider(config: Config): Promise<LlmProvider | null> {
  switch (config.AI_PROVIDER) {
    case 'anthropic': {
      if (!config.ANTHROPIC_API_KEY) return null;
      const { anthropicProvider } = await import('./anthropic.ts');
      return anthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.AI_MODEL });
    }
  }
}

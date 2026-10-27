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
  /** Valoración interna para límites de presupuesto; no implica una tarifa del proveedor. */
  readonly pricing?: Price;
  readonly costBasis?: 'published_tariff' | 'budget_estimate';
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
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const PRICING: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export function costOf(model: string, u: LlmUsage, p = PRICING[model]): number {
  if (!p) throw new LlmError('rejected', 'Modelo sin tarifa verificada');
  if (Object.values(p).some((v) => !Number.isFinite(v) || v < 0))
    throw new LlmError('rejected', 'Valoración de presupuesto inválida');
  if (Object.values(u).some((v) => !Number.isFinite(v) || v < 0))
    throw new LlmError('unavailable', 'Uso de tokens inválido');
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite) /
    1e6
  );
}

/**
 * Reserva conservadora: bytes UTF-8 más margen de protocolo y salida máxima completa.
 * La entrada se reserva como escritura de caché de 5 min (la tarifa mayor habilitada).
 */
export function reserveOf(model: string, req: LlmRequest, pricing?: Price): number {
  const bytes = Buffer.byteLength(JSON.stringify(req), 'utf8') + 1024;
  return costOf(
    model,
    {
      input: 0,
      output: req.maxTokens,
      cacheRead: 0,
      cacheWrite: bytes,
    },
    pricing,
  );
}

/** Proveedor configurado, o null si falta su clave (la IA queda desactivada, sin simulación). */
export async function createProvider(config: Config): Promise<LlmProvider | null> {
  switch (config.AI_PROVIDER) {
    case 'nvidia': {
      if (!config.NVIDIA_API_KEY) return null;
      const { nvidiaProvider } = await import('./nvidia.ts');
      return nvidiaProvider({
        apiKey: config.NVIDIA_API_KEY,
        inputBudgetRate: config.NVIDIA_BUDGET_INPUT_USD_PER_MILLION,
        outputBudgetRate: config.NVIDIA_BUDGET_OUTPUT_USD_PER_MILLION,
      });
    }
    case 'anthropic': {
      if (!config.ANTHROPIC_API_KEY) return null;
      const { anthropicProvider } = await import('./anthropic.ts');
      return anthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.AI_MODEL });
    }
  }
}

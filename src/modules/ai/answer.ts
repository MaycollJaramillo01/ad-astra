import { z } from 'zod';
import { RECOMMENDATION_ACTIONS } from '../../domain.ts';

// Respuesta estructurada del asistente y su verificación (docs/ARCHITECTURE.md §6.8). El modelo
// entrega la respuesta con la herramienta submit_answer; antes de mostrarla se comprueba de forma
// determinista que cada evidencia, cifra, fecha, entidad y hallazgo citado existe en los
// resultados de las herramientas, que la suficiencia declarada no es mejor que la de los datos y
// que el lenguaje no afirma causalidad ni garantiza resultados.

export const SUFFICIENCY = ['sufficient', 'limited', 'insufficient'] as const;
export type SufficiencyStatus = (typeof SUFFICIENCY)[number];

/** Peor estado de suficiencia de una lista. */
export function worst(list: SufficiencyStatus[]): SufficiencyStatus {
  return list.includes('insufficient')
    ? 'insufficient'
    : list.includes('limited')
      ? 'limited'
      : 'sufficient';
}

const Confidence = z.enum(['low', 'medium', 'high']);
const Figure = z.object({
  label: z.string().max(120),
  value: z.number(),
  unit: z.enum(['currency', 'percent', 'count', 'decimal']),
  evidenceId: z.string().max(8),
});
const Cited = { evidenceIds: z.array(z.string().max(8)).max(12) };

export const Answer = z.object({
  summary: z.string().max(1500).describe('Respuesta directa a la pregunta, en 1–4 frases'),
  dataSufficiency: z.object({
    status: z.enum(SUFFICIENCY),
    reasons: z.array(z.string().max(300)).max(8),
  }),
  claims: z
    .array(z.object({ text: z.string().max(600), ...Cited, figures: z.array(Figure).max(8) }))
    .max(12)
    .describe('Hechos observados en los datos, cada uno con su evidencia'),
  hypotheses: z
    .array(
      z.object({
        text: z.string().max(600),
        ...Cited,
        confidence: Confidence,
        howToVerify: z.string().max(400),
      }),
    )
    .max(6),
  recommendations: z
    .array(
      z.object({
        title: z.string().max(160),
        rationale: z.string().max(800),
        ...Cited,
        figures: z.array(Figure).max(8),
        expectedImpact: z.object({
          hypothesis: z.string().max(400).describe('Impacto esperado, redactado como hipótesis'),
          metric: z.string().max(60),
          direction: z.enum(['increase', 'decrease', 'stabilize']),
          magnitude: z.enum(['low', 'medium', 'high']),
        }),
        confidence: z.object({ level: Confidence, rationale: z.string().max(400) }),
        dependencies: z.array(z.string().max(300)).max(6),
        risk: z.object({ level: Confidence, description: z.string().max(400) }),
        action: z.object({
          type: z.enum(RECOMMENDATION_ACTIONS),
          entityLevel: z.enum(['account', 'campaign', 'adset', 'ad']),
          entityId: z
            .string()
            .max(64)
            .describe('Id de la entidad tal como aparece en la evidencia'),
          description: z.string().max(400),
          amount: z
            .number()
            .nullable()
            .describe('Nuevo presupuesto en la moneda de la cuenta (solo acciones de presupuesto)'),
        }),
        relatedFindingIds: z.array(z.string().max(64)).max(6),
      }),
    )
    .max(6),
  followUpQuestions: z.array(z.string().max(200)).max(4),
});
export type Answer = z.infer<typeof Answer>;

export const SUBMIT_ANSWER = {
  name: 'submit_answer',
  description:
    'Entrega la respuesta final al usuario. Es la única forma de responder. Cada afirmación, hipótesis y recomendación cita sus evidenceId; cada cifra relevante va en figures con el evidenceId del que sale. Si la verificación devuelve errores, corrígelos y vuelve a llamarla.',
  input: Answer,
} as const;

// --- Priorización (determinista, documentada en ARCHITECTURE §6.8)

const CONF = { low: 0.4, medium: 0.7, high: 0.9 } as const;
const IMPACT = { low: 1, medium: 2, high: 3 } as const;
const RISK = { low: 1, medium: 0.75, high: 0.5 } as const;
const MAX_PRIORITY = CONF.high * IMPACT.high * RISK.low;

/** Prioridad 0–1 = confianza × magnitud del impacto × factor de riesgo, normalizada. */
export const priorityOf = (r: Answer['recommendations'][number]) =>
  Number(
    (
      (CONF[r.confidence.level] * IMPACT[r.expectedImpact.magnitude] * RISK[r.risk.level]) /
      MAX_PRIORITY
    ).toFixed(3),
  );

// --- Verificación

export interface EvidenceRecord {
  id: string;
  tool: string;
  sufficiency: SufficiencyStatus;
  output: unknown;
}

export interface Issue {
  path: string;
  code:
    | 'unknown_evidence'
    | 'missing_evidence'
    | 'untraceable_number'
    | 'untraceable_figure'
    | 'unknown_identifier'
    | 'unknown_entity'
    | 'unknown_finding'
    | 'sufficiency_overstated'
    | 'action_on_insufficient_data'
    | 'certainty_language'
    | 'causal_claim'
    | 'impact_not_hypothesis'
    | 'no_evidence';
  message: string;
}

export interface Verification {
  status: 'verified' | 'unverified';
  issues: Issue[];
  figures: { checked: number; verified: number };
}

interface Pool {
  numbers: number[];
  strings: string[];
}

function collect(value: unknown, pool: Pool, depth = 0) {
  if (depth > 10) return;
  if (typeof value === 'number' && Number.isFinite(value)) pool.numbers.push(value);
  else if (typeof value === 'string') {
    pool.strings.push(value);
    for (const n of parseNumbers(value)) pool.numbers.push(n.value * n.scale);
  } else if (Array.isArray(value)) for (const v of value) collect(v, pool, depth + 1);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collect(v, pool, depth + 1);
}

function poolOf(records: EvidenceRecord[]): Pool {
  const pool: Pool = { numbers: [], strings: [] };
  for (const r of records) collect(r.output, pool);
  return pool;
}

interface Parsed {
  /** Interpretaciones posibles (p. ej. "1.234" puede ser 1234 o 1,234). */
  candidates: Array<{ value: number; decimals: number }>;
  value: number;
  scale: number;
  percent: boolean;
  exempt: boolean;
  raw: string;
}

const SUFFIX = /^\s?(%|pp\b|p\.\s?p\.|puntos porcentuales|k\b|mil\b|millones\b|millón\b|M\b)/i;

/** Números de un texto en formato español o inglés, con sufijos de escala y porcentaje. */
export function parseNumbers(text: string): Parsed[] {
  const out: Parsed[] = [];
  for (const m of text.matchAll(/\d(?:[\d.,]*\d)?/g)) {
    const raw = m[0];
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 2), at);
    if (/[A-Za-z_]$/.test(before)) continue; // parte de un identificador (E3, v1, act_123…)
    const after = text.slice(at + raw.length);
    const suffix = SUFFIX.exec(after)?.[1]?.toLowerCase() ?? '';
    const percent = suffix === '%' || suffix.startsWith('p') || suffix.startsWith('puntos');
    const scale =
      suffix === 'k' || suffix === 'mil' ? 1e3 : /^(m|millones|millón)$/.test(suffix) ? 1e6 : 1;
    const seps = raw.match(/[.,]/g) ?? [];
    const candidates: Parsed['candidates'] = [];
    const plain = (s: string) => Number(s.replace(/[.,]/g, ''));
    if (seps.length === 0) candidates.push({ value: Number(raw), decimals: 0 });
    else if (new Set(seps).size === 2) {
      const dec = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
      candidates.push({
        value: Number(`${plain(raw.slice(0, dec))}.${raw.slice(dec + 1)}`),
        decimals: raw.length - dec - 1,
      });
    } else if (seps.length > 1) candidates.push({ value: plain(raw), decimals: 0 });
    else {
      const [int = '', frac = ''] = raw.split(/[.,]/);
      candidates.push({ value: Number(`${int}.${frac}`), decimals: frac.length });
      if (frac.length === 3) candidates.push({ value: plain(raw), decimals: 0 });
    }
    const first = candidates[0] as { value: number };
    // Enteros pequeños sin unidad son conteos y ordinales ("3 campañas", "paso 2").
    const currency = /[$€£]\s?$/.test(before) || /^\s?(USD|EUR|HNL|MXN|GTQ|COP|L\b)/.test(after);
    const exempt = seps.length === 0 && first.value <= 10 && !percent && !currency && scale === 1;
    out.push({ candidates, value: first.value, scale, percent, exempt, raw });
  }
  return out;
}

const closeTo = (x: number, decimals: number, scale: number, v: number) =>
  Math.abs(x * scale - Math.abs(v)) <= 0.5 * 10 ** -decimals * scale + 1e-9;

function traceable(p: Parsed, pool: Pool): boolean {
  return p.candidates.some((c) =>
    pool.numbers.some(
      (v) =>
        closeTo(c.value, c.decimals, p.scale, v) ||
        (p.percent && closeTo(c.value, c.decimals, 1, v * 100)),
    ),
  );
}

const IDENTIFIER =
  /\b\d{4}-\d{2}-\d{2}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{9,}\b|\bR-[A-Z]+-\d{3}\b/gi;

/** Cifras e identificadores de un texto que no salen de la evidencia. */
function untraceable(text: string, pool: Pool): { numbers: string[]; identifiers: string[] } {
  // Lo que ya es un texto literal de la evidencia (fechas, ids, versiones, etiquetas) no se trocea.
  let rest = text;
  for (const s of pool.strings)
    if (s.length >= 4 && /\d/.test(s) && rest.includes(s)) rest = rest.replaceAll(s, ' ');
  const identifiers = [...rest.matchAll(IDENTIFIER)].map((m) => m[0]);
  rest = rest.replace(IDENTIFIER, ' ').replace(/\bE\d+\b/g, ' ');
  const numbers = parseNumbers(rest)
    .filter((p) => !p.exempt && !traceable(p, pool))
    .map((p) => p.raw);
  return { numbers, identifiers };
}

const CERTAINTY =
  /\b(garantiz\w*|te aseguro|aseguramos|sin (ninguna )?duda|con (total )?(certeza|seguridad)|definitivamente|100\s?% (seguro|garantizado)|siempre funciona|nunca falla)\b/i;
const CAUSAL = /\b(caus[óo]|provoc[óo]|se debe a|debido a|es culpa de|ocasion[óo])\b/i;
const HEDGE =
  /\b(podr[íi]an?|probable(mente)?|posible(mente)?|se espera|esperamos|hip[óo]tesis|estim\w*|tender[íi]a|puede[n]?|cabe esperar|sugiere[n]?|parece|coincide|indicar[íi]a)\b/i;

const RANK: Record<SufficiencyStatus, number> = { sufficient: 0, limited: 1, insufficient: 2 };

export function verifyAnswer(answer: Answer, evidence: EvidenceRecord[]): Verification {
  const issues: Issue[] = [];
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const all = poolOf(evidence);
  const figures = { checked: 0, verified: 0 };

  const cited = (path: string, ids: string[], required: boolean): EvidenceRecord[] => {
    if (required && ids.length === 0)
      issues.push({ path, code: 'missing_evidence', message: 'Sin evidenceId que la respalde' });
    const found: EvidenceRecord[] = [];
    for (const id of ids) {
      const e = byId.get(id);
      if (e) found.push(e);
      else issues.push({ path, code: 'unknown_evidence', message: `La evidencia ${id} no existe` });
    }
    return found;
  };
  const checkText = (path: string, text: string, pool: Pool, allowed: number[] = []) => {
    const { numbers, identifiers } = untraceable(text, {
      numbers: [...pool.numbers, ...allowed],
      strings: pool.strings,
    });
    for (const n of numbers)
      issues.push({
        path,
        code: 'untraceable_number',
        message: `La cifra "${n}" no aparece en la evidencia citada`,
      });
    for (const i of identifiers)
      issues.push({
        path,
        code: 'unknown_identifier',
        message: `"${i}" no aparece en la evidencia`,
      });
    if (CERTAINTY.test(text))
      issues.push({
        path,
        code: 'certainty_language',
        message: 'Afirma certeza o garantiza resultados',
      });
  };
  const checkFigures = (path: string, list: z.infer<typeof Figure>[]) => {
    list.forEach((f, i) => {
      figures.checked++;
      const e = byId.get(f.evidenceId);
      const decimals = (String(f.value).split('.')[1] ?? '').length;
      const pool = e ? poolOf([e]) : null;
      const ok =
        pool?.numbers.some(
          (v) =>
            closeTo(Math.abs(f.value), decimals, 1, v) ||
            (f.unit === 'percent' && closeTo(Math.abs(f.value), decimals, 1, v * 100)),
        ) ?? false;
      if (ok) figures.verified++;
      else
        issues.push({
          path: `${path}.figures.${i}`,
          code: e ? 'untraceable_figure' : 'unknown_evidence',
          message: e
            ? `${f.label}: ${f.value} no aparece en ${f.evidenceId}`
            : `La evidencia ${f.evidenceId} no existe`,
        });
    });
  };
  const statuses: SufficiencyStatus[] = [];

  if (evidence.length === 0 && (answer.claims.length || answer.recommendations.length))
    issues.push({
      path: 'claims',
      code: 'no_evidence',
      message: 'Hay afirmaciones sin ninguna consulta a las herramientas',
    });

  checkText('summary', answer.summary, all);
  answer.claims.forEach((c, i) => {
    const path = `claims.${i}`;
    const es = cited(path, c.evidenceIds, true);
    statuses.push(...es.map((e) => e.sufficiency));
    const pool = poolOf(es);
    checkText(
      path,
      c.text,
      pool,
      c.figures.map((f) => f.value),
    );
    checkFigures(path, c.figures);
    if (CAUSAL.test(c.text) && !HEDGE.test(c.text))
      issues.push({
        path,
        code: 'causal_claim',
        message: 'Afirma una causa como hecho: exprésala como hipótesis',
      });
  });
  answer.hypotheses.forEach((h, i) => {
    const path = `hypotheses.${i}`;
    const es = cited(path, h.evidenceIds, true);
    statuses.push(...es.map((e) => e.sufficiency));
    const pool = poolOf(es);
    checkText(path, h.text, pool);
    checkText(`${path}.howToVerify`, h.howToVerify, all);
  });
  answer.recommendations.forEach((r, i) => {
    const path = `recommendations.${i}`;
    const es = cited(path, r.evidenceIds, true);
    statuses.push(...es.map((e) => e.sufficiency));
    const pool = poolOf(es);
    const own = r.figures.map((f) => f.value);
    for (const [k, text] of [
      ['title', r.title],
      ['rationale', r.rationale],
      ['expectedImpact', r.expectedImpact.hypothesis],
      ['risk', r.risk.description],
      ['confidence', r.confidence.rationale],
    ] as const)
      checkText(`${path}.${k}`, text, pool, own);
    // El importe propuesto es una propuesta, no un dato: puede aparecer en la descripción de la acción.
    checkText(
      `${path}.action`,
      r.action.description,
      pool,
      r.action.amount === null ? own : [...own, r.action.amount],
    );
    for (const [j, d] of r.dependencies.entries()) checkText(`${path}.dependencies.${j}`, d, all);
    checkFigures(path, r.figures);
    if (!HEDGE.test(r.expectedImpact.hypothesis))
      issues.push({
        path: `${path}.expectedImpact`,
        code: 'impact_not_hypothesis',
        message: 'El impacto esperado debe redactarse como hipótesis ("podría", "se espera"…)',
      });
    if (!all.strings.includes(r.action.entityId))
      issues.push({
        path: `${path}.action`,
        code: 'unknown_entity',
        message: `La entidad ${r.action.entityId} no aparece en la evidencia`,
      });
    for (const f of r.relatedFindingIds)
      if (!all.strings.includes(f))
        issues.push({
          path,
          code: 'unknown_finding',
          message: `El hallazgo ${f} no aparece en la evidencia`,
        });
    const insufficient = es.some((e) => e.sufficiency === 'insufficient');
    if (
      r.action.type !== 'review' &&
      (answer.dataSufficiency.status === 'insufficient' ||
        (insufficient && r.confidence.level !== 'low'))
    )
      issues.push({
        path,
        code: 'action_on_insufficient_data',
        message:
          'Con datos insuficientes solo caben acciones de revisión (review) o confianza baja',
      });
  });

  if (statuses.length && RANK[answer.dataSufficiency.status] < RANK[worst(statuses)])
    issues.push({
      path: 'dataSufficiency',
      code: 'sufficiency_overstated',
      message: `La evidencia citada es "${worst(statuses)}" y la respuesta declara "${answer.dataSufficiency.status}"`,
    });

  return { status: issues.length ? 'unverified' : 'verified', issues, figures };
}

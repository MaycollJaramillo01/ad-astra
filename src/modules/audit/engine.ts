import { buildContexts, type EntityContext, type Window, type Windows } from './context.ts';
import { accountHealthOf, type HealthScore, healthOf } from './health.ts';
import {
  AUDIT_ENGINE_VERSION,
  type AuditConfig,
  type AuditInput,
  type AuditLevel,
  type Category,
  HEALTH_FORMULA_VERSION,
  type Profile,
  SEVERITY_WEIGHT,
  type Severity,
} from './model.ts';
import { appliesTo, type Env, type Impact, type Outcome, RULES, ruleParams } from './rules.ts';
import { benjaminiHochberg } from './stats.ts';

// Motor de auditoría: función pura y determinista (mismas entradas → mismos hallazgos y
// puntuaciones). No lee el reloj ni la BD: todo llega en `input` y `config`.

/** Huella del catálogo: cambia si cambia cualquier regla o su versión (FNV-1a de 32 bits). */
function catalogHash(): string {
  let h = 0x811c9dc5;
  for (const ch of RULES.map((r) => `${r.id}@${r.version}`).join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Versión del motor que se guarda en cada ejecución y en cada hallazgo. */
export const ENGINE_VERSION = `audit-${AUDIT_ENGINE_VERSION}+${catalogHash()}`;

export interface FindingDraft {
  ruleId: string;
  ruleVersion: number;
  category: Category;
  level: AuditLevel;
  entityId: string;
  entityName: string;
  profile: Profile;
  fingerprint: string;
  severity: Severity;
  confidence: number;
  priority: number;
  explanation: string;
  impact: Impact | null;
  evidence: {
    window: Window;
    metrics: Record<string, number | string | null>;
    reference: { metric: string; value: number; source: string; n: number } | null;
    threshold: Record<string, number | string> | null;
    sample: Record<string, number>;
    pValue: number | null;
    method: string;
    fdr: { q: number; passed: boolean } | null;
    params: Record<string, unknown>;
  };
  recommendationKey: string;
  recommendationText: string;
}

export interface Evaluation {
  ruleId: string;
  level: AuditLevel;
  entityId: string;
  status: Outcome['status'];
  reason?: string;
}

export interface AuditResult {
  engineVersion: string;
  formulaVersion: string;
  asOf: string;
  windows: Windows;
  findings: FindingDraft[];
  evaluations: Evaluation[];
  health: HealthScore[];
  stats: {
    entities: number;
    evaluated: number;
    triggered: number;
    insufficient: number;
    statisticalTests: number;
    downgradedByFdr: number;
  };
}

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
const maxSeverity = (a: Severity, b: Severity) =>
  SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;

export function runAudit(input: AuditInput, config: AuditConfig): AuditResult {
  const built = buildContexts(input, config);
  const accountSpend =
    built.account.cur.spend ||
    built.contexts.filter((c) => c.level === 'campaign').reduce((a, c) => a + c.cur.spend, 0);
  const shares = config.severityByImpactShare;
  const env: Env = {
    currency: input.account.currency,
    accountSpend,
    win: built.win,
    config,
    children: built.children,
    // Severidad según el impacto frente al gasto de la cuenta, nunca por debajo del mínimo de la regla.
    severityFor: (impact, floor) => {
      if (impact === null || accountSpend <= 0) return floor;
      const share = impact / accountSpend;
      const bySize: Severity =
        share >= shares.critical
          ? 'critical'
          : share >= shares.high
            ? 'high'
            : share >= shares.medium
              ? 'medium'
              : 'low';
      return maxSeverity(bySize, floor);
    },
  };

  const targets: EntityContext[] = [built.account, ...built.contexts];
  const evaluations: Evaluation[] = [];
  const triggered: Array<{
    draft: FindingDraft;
    pValue: number | null;
    statistical: boolean;
    share: number;
  }> = [];
  const pValues: number[] = [];

  for (const rule of [...RULES].sort((a, b) => a.id.localeCompare(b.id))) {
    const override = config.rules[rule.id];
    if (override?.enabled === false) continue;
    const params = ruleParams(rule, override?.params);
    for (const c of targets) {
      if (!appliesTo(rule, c)) continue;
      const outcome = rule.evaluate(c, params as never, env);
      evaluations.push({
        ruleId: rule.id,
        level: c.level,
        entityId: c.id,
        status: outcome.status,
        ...(outcome.status === 'insufficient_data' && { reason: outcome.reason }),
      });
      if (
        rule.statistical &&
        outcome.status !== 'insufficient_data' &&
        outcome.pValue !== undefined
      )
        pValues.push(outcome.pValue);
      if (outcome.status !== 'triggered') continue;
      const share =
        outcome.impact && accountSpend > 0
          ? Math.min(1, outcome.impact.value / accountSpend)
          : config.priorityShareWithoutImpact;
      triggered.push({
        share,
        statistical: rule.statistical,
        pValue: outcome.pValue ?? null,
        draft: {
          ruleId: rule.id,
          ruleVersion: rule.version,
          category: rule.category,
          level: c.level,
          entityId: c.id,
          entityName: c.name,
          profile: c.profile,
          fingerprint: `${rule.id}:${c.level}:${c.id}`,
          severity: outcome.severity,
          confidence: round(outcome.confidence, 3),
          priority: round(SEVERITY_WEIGHT[outcome.severity] * outcome.confidence * share, 4),
          explanation: outcome.explanation,
          impact: outcome.impact
            ? { ...outcome.impact, value: round(outcome.impact.value, 2) }
            : null,
          evidence: {
            window: outcome.window,
            metrics: roundAll(outcome.metrics),
            reference: outcome.reference
              ? { ...outcome.reference, value: round(outcome.reference.value, 6) }
              : null,
            threshold: outcome.threshold ?? null,
            sample: roundAll(outcome.sample) as Record<string, number>,
            pValue: outcome.pValue === undefined ? null : outcome.pValue,
            method: rule.method,
            fdr: null,
            params,
          },
          recommendationKey: outcome.recommendation.key,
          recommendationText: outcome.recommendation.text,
        },
      });
    }
  }

  // Control de falsos descubrimientos sobre todas las pruebas de la ejecución: un hallazgo de
  // severidad alta o crítica que no lo supera se abre como medio.
  let downgradedByFdr = 0;
  if (pValues.length > 0) {
    const sorted = [...pValues].sort((a, b) => a - b);
    let cutoff = 0;
    benjaminiHochberg(sorted, config.fdrQ).forEach((r, i) => {
      if (r) cutoff = sorted[i] as number;
    });
    for (const t of triggered) {
      if (!t.statistical || t.pValue === null) continue;
      const passed = t.pValue <= cutoff && cutoff > 0;
      t.draft.evidence.fdr = { q: config.fdrQ, passed };
      if (!passed && (t.draft.severity === 'high' || t.draft.severity === 'critical')) {
        t.draft.severity = 'medium';
        t.draft.priority = round(SEVERITY_WEIGHT.medium * t.draft.confidence * t.share, 4);
        downgradedByFdr++;
      }
    }
  }

  // Salud: cada entidad y la cuenta (media de las campañas ponderada por gasto).
  const health = built.contexts.map((c) => healthOf(c, config));
  const campaigns = built.contexts.flatMap((c, i) =>
    c.level === 'campaign' ? [{ health: health[i] as HealthScore, spend: c.cur.spend }] : [],
  );
  health.unshift(accountHealthOf(built.account.id, campaigns, config));

  const findings = triggered
    .map((t) => t.draft)
    .sort((a, b) => b.priority - a.priority || a.fingerprint.localeCompare(b.fingerprint));
  return {
    engineVersion: ENGINE_VERSION,
    formulaVersion: HEALTH_FORMULA_VERSION,
    asOf: input.asOf,
    windows: built.win,
    findings,
    evaluations,
    health,
    stats: {
      entities: targets.length,
      evaluated: evaluations.length,
      triggered: findings.length,
      insufficient: evaluations.filter((e) => e.status === 'insufficient_data').length,
      statisticalTests: pValues.length,
      downgradedByFdr,
    },
  };
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
const roundAll = (o: Record<string, number | string | null>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'number' && Number.isFinite(v) ? round(v, 6) : v,
    ]),
  );

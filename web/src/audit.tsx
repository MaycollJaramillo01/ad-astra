import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AuditCatalog, AuditEntity, Health } from '../../src/contracts.ts';
import type { Role } from '../../src/domain.ts';
import type { Tone } from '../../src/modules/insights/catalog.ts';
import { accountPath } from './account-context.ts';
import { api } from './api.ts';
import { formatDay } from './format.ts';
import { ErrorBox } from './pages.tsx';
import { ToneIcon } from './ui.tsx';

// Auditoría en el dashboard: índice de salud con sus subíndices y los hallazgos abiertos de la
// rama, con su explicación, confianza, impacto, recomendación y la evidencia que los respalda.

export type AuditLevel = 'account' | 'campaign' | 'adset' | 'ad';

export const useAuditEntity = (level: AuditLevel | null, id: string | null) =>
  useQuery({
    queryKey: ['audit-entity', level, id],
    queryFn: () =>
      api<AuditEntity>(`/v1/audit/entity?level=${level}&id=${encodeURIComponent(id ?? '')}`),
    enabled: level !== null && !!id,
  });

const useCatalog = () =>
  useQuery({
    queryKey: ['audit-catalog'],
    queryFn: () => api<AuditCatalog>('/v1/audit/catalog'),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const GRADE: Record<Health['grade'], { label: string; tone: Tone }> = {
  excellent: { label: 'Excelente', tone: 'good' },
  good: { label: 'Buena', tone: 'good' },
  attention: { label: 'Atención', tone: 'warning' },
  critical: { label: 'Crítica', tone: 'critical' },
  insufficient: { label: 'Datos insuficientes', tone: 'neutral' },
};
const SEVERITY: Record<string, { label: string; tone: Tone }> = {
  critical: { label: 'Crítica', tone: 'critical' },
  high: { label: 'Alta', tone: 'critical' },
  medium: { label: 'Media', tone: 'warning' },
  low: { label: 'Baja', tone: 'neutral' },
  info: { label: 'Info', tone: 'neutral' },
};
const confidenceLabel = (c: number) => (c >= 0.9 ? 'alta' : c >= 0.7 ? 'media' : 'baja');
const RUNNERS: Role[] = ['owner', 'admin', 'manager', 'analyst'];

export function HealthBadge({ score, grade }: { score: number | null; grade: Health['grade'] }) {
  const g = GRADE[grade];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`Salud: ${g.label}`}>
      <ToneIcon tone={g.tone} />
      {score === null ? 'Salud: datos insuficientes' : `Salud ${Math.round(score)}`}
    </span>
  );
}

export function AuditSection({
  level,
  id,
  accountId,
  currency,
  role,
}: {
  level: AuditLevel;
  id: string;
  accountId: string | null;
  currency: string | null;
  role: Role;
}) {
  const entity = useAuditEntity(level, id);
  const catalog = useCatalog();
  if (entity.error) return <ErrorBox error={entity.error} />;
  if (!entity.data) return <p className="text-sm text-gray-500">Cargando la auditoría…</p>;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <HealthPanel
        health={entity.data.health}
        subindices={catalog.data?.subindices ?? {}}
        accountId={level === 'account' ? accountId : null}
        canRun={RUNNERS.includes(role)}
      />
      <FindingsList
        entity={entity.data}
        catalog={catalog.data}
        currency={currency}
        nodeId={id}
        accountId={accountId}
        canAct={role !== 'viewer'}
      />
    </div>
  );
}

function HealthPanel({
  health,
  subindices,
  accountId,
  canRun,
}: {
  health: Health | null;
  subindices: Record<string, string>;
  accountId: string | null;
  canRun: boolean;
}) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () =>
      api<{ stats: Record<string, number> }>(`/v1/ad-accounts/${accountId}/audit`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['audit-entity'] }),
  });
  const g = health ? GRADE[health.grade] : null;
  const detailsId = useId();
  return (
    <section
      aria-labelledby="salud"
      className="min-w-0 rounded-lg border border-gray-200 p-4 dark:border-gray-800"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="salud" className="font-semibold">
          Índice de salud
        </h2>
        {accountId && canRun && (
          <button
            type="button"
            className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-gray-700"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Auditando…' : 'Auditar ahora'}
          </button>
        )}
      </div>
      {run.error && <ErrorBox error={run.error} />}
      {run.data && (
        <p className="mt-1 text-xs text-gray-500" role="status">
          Hecho: {run.data.stats.opened ?? 0} hallazgos nuevos, {run.data.stats.resolved ?? 0}{' '}
          resueltos.
        </p>
      )}
      {!health || !g ? (
        <p className="mt-3 text-sm text-gray-500">
          Aún no se ha auditado. El motor se ejecuta tras cada sincronización.
        </p>
      ) : (
        <>
          <p className="mt-2 flex items-baseline gap-2">
            {health.score === null ? (
              <span className="text-lg font-semibold text-gray-500">Datos insuficientes</span>
            ) : (
              <span className="text-4xl font-semibold">{Math.round(health.score)}</span>
            )}
            <span className="inline-flex items-center gap-1 text-sm">
              <ToneIcon tone={g.tone} />
              {health.score === null ? '' : g.label}
            </span>
          </p>
          <p className="text-xs text-gray-500">
            Cobertura {Math.round(health.coverage * 100)} %
            {health.confidence !== null && ` · confianza ${confidenceLabel(health.confidence)}`} ·{' '}
            al {formatDay(health.date, true)} ({health.windowDays} días)
          </p>
          <ul className="mt-3 space-y-2">
            {health.components.map((c) => {
              const comp = c as {
                id: string;
                status: string;
                s: number | null;
                weight: number;
                note: string;
                referenceSource: string | null;
                confidence: number | null;
              };
              // Lo que no aplica al perfil no se muestra; lo insuficiente sí (se explica por qué).
              if (comp.status === 'not_applicable') return null;
              const label = subindices[comp.id] ?? comp.id;
              return (
                <li key={comp.id} title={comp.note}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      {label}
                      {comp.weight > 0 && (
                        <span className="ml-1 text-xs text-gray-500">
                          peso {Math.round(comp.weight * 100)} %
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">
                      {comp.status === 'ok' && comp.s !== null
                        ? Math.round(comp.s)
                        : comp.status === 'not_applicable'
                          ? 'no aplica'
                          : 'insuficiente'}
                    </span>
                  </div>
                  <div aria-hidden="true" className="mt-1 h-1.5 rounded bg-[var(--viz-grid)]">
                    {comp.status === 'ok' && comp.s !== null && (
                      <div
                        className="h-1.5 rounded"
                        style={{
                          width: `${Math.max(2, comp.s)}%`,
                          background: 'var(--viz-series)',
                        }}
                      />
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">{comp.note}</p>
                </li>
              );
            })}
          </ul>
          <details className="mt-3 text-xs text-gray-600 dark:text-gray-300">
            <summary className="cursor-pointer" id={detailsId}>
              Cómo se calcula
            </summary>
            <p className="mt-1">
              Versión {health.formulaVersion}. Cada subíndice compara la estimación con su
              referencia (objetivo del cliente, línea base propia o mediana de la cuenta): s = 80 +
              40 · log2(q), entre 0 y 100, donde q &gt; 1 es mejor que la referencia. La entrega es
              lineal (100 = gasta su presupuesto o entrega todos los días). La puntuación es la
              media ponderada de los subíndices con muestra suficiente; si cubren menos del 60 % del
              peso se muestra «Datos insuficientes», nunca una nota baja.
            </p>
          </details>
        </>
      )}
    </section>
  );
}

const METRIC_LABEL: Record<string, string> = {
  spend: 'Gasto',
  events: 'Eventos',
  observedCost: 'Costo observado',
  estimatedCost: 'Costo estimado',
  interval80Low: 'Intervalo 80 % (mín.)',
  interval80High: 'Intervalo 80 % (máx.)',
  probabilityAboveLimit: 'P(costo > límite)',
  expectedEvents: 'Eventos esperados',
  probabilityOfZero: 'P(0 eventos)',
  observed: 'Observados',
  expected: 'Esperados',
  ratio: 'Observados / esperados',
  linkCtr: 'CTR del enlace',
  baselineLinkCtr: 'CTR de la línea base',
  relativeChange: 'Cambio relativo',
  adjustedCv: 'CV ajustado',
  accountMedianCv: 'CV mediano de la cuenta',
  threshold: 'Umbral',
  frequencyBefore: 'Frecuencia anterior',
  frequencyNow: 'Frecuencia actual',
  linkCtrBefore: 'CTR anterior',
  linkCtrNow: 'CTR actual',
  dailyBudget: 'Presupuesto diario',
  estimatedRoas: 'ROAS estimado',
  observedRoas: 'ROAS observado',
  purchaseValue: 'Valor de compra',
  purchases: 'Compras',
  averageOrderValue: 'Valor medio',
  linkClicks: 'Clics en el enlace',
  baselineConversionRate: 'Conversión por clic (base)',
  robustZ: 'z robusta',
  historyMedian: 'Mediana histórica',
  projectedWeeklyEvents: 'Eventos semanales proyectados',
};
const isMoney = (k: string) =>
  /spend|cost|value|budget|bid|median|cpm|cpc/i.test(k) && !/Cv|z$/i.test(k);
const isRate = (k: string) => /ctr|rate|probability|relativechange|ratio|conversi/i.test(k);

function formatEvidence(key: string, v: unknown, currency: string | null): string {
  if (typeof v !== 'number') return v === null ? '—' : String(v);
  if (isRate(key)) return `${(v * 100).toFixed(2)} %`;
  if (isMoney(key) && currency) return `${v.toFixed(2)} ${currency}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function FindingsList({
  entity,
  catalog,
  currency,
  nodeId,
  accountId,
  canAct,
}: {
  entity: AuditEntity;
  catalog: AuditCatalog | undefined;
  currency: string | null;
  nodeId: string;
  accountId: string | null;
  canAct: boolean;
}) {
  const [sp] = useSearchParams();
  const rules = new Map((catalog?.rules ?? []).map((r) => [r.id, r]));
  return (
    <section
      aria-labelledby="hallazgos"
      className="min-w-0 rounded-lg border border-gray-200 p-4 lg:col-span-2 dark:border-gray-800"
    >
      <h2 id="hallazgos" className="font-semibold">
        Hallazgos abiertos
      </h2>
      <p className="mb-3 text-xs text-gray-500">
        De esta entidad y de todo lo que cuelga de ella, por prioridad (severidad × confianza ×
        impacto).
      </p>
      {entity.findings.length === 0 ? (
        <p className="text-sm text-gray-500">Sin hallazgos abiertos.</p>
      ) : (
        <ul className="space-y-3">
          {entity.findings.map((f) => {
            const rule = rules.get(f.ruleId);
            const sev = SEVERITY[f.severity] ?? { label: f.severity, tone: 'neutral' as Tone };
            const ev = (f.evidence ?? {}) as {
              metrics?: Record<string, unknown>;
              reference?: { metric: string; value: number; source: string } | null;
              threshold?: Record<string, unknown> | null;
              sample?: Record<string, unknown>;
              pValue?: number | null;
              fdr?: { q: number; passed: boolean } | null;
              method?: string;
            };
            const impact = f.impact as { value?: number; method?: string } | null;
            const confidence = Number(f.confidence);
            return (
              <li key={f.id} className="rounded-md border border-gray-100 p-3 dark:border-gray-900">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="inline-flex items-center gap-1 font-medium">
                    <ToneIcon tone={sev.tone} />
                    {sev.label}
                  </span>
                  <strong className="font-semibold">{rule?.title ?? f.ruleId}</strong>
                  {f.entityMetaId !== nodeId && f.entityName && (
                    <span className="text-gray-500">· {f.entityName}</span>
                  )}
                  <span className="ml-auto text-xs text-gray-500">
                    {catalog?.categories[f.category ?? ''] ?? f.category} · confianza{' '}
                    {confidenceLabel(confidence)} ({Math.round(confidence * 100)} %)
                  </span>
                </div>
                <p className="mt-1 text-sm">{f.explanation}</p>
                {impact?.value ? (
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                    Impacto estimado: {impact.value.toFixed(2)} {currency} ({impact.method})
                  </p>
                ) : null}
                {f.recommendationText && (
                  <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
                    → {f.recommendationText}
                  </p>
                )}
                {accountId && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      className="button-secondary"
                      to={accountPath(
                        accountId,
                        'campanas',
                        sp,
                        f.entityLevel === 'account'
                          ? {}
                          : { entidad: f.entityMetaId, nivel: f.entityLevel },
                      )}
                    >
                      Revisar entidad y resultados
                    </Link>
                    {canAct && (
                      <Link
                        className="button-secondary"
                        to={accountPath(
                          accountId,
                          'acciones',
                          sp,
                          f.entityLevel === 'account'
                            ? {}
                            : { entidad: f.entityMetaId, nivel: f.entityLevel },
                        )}
                      >
                        Revisar posibles acciones
                      </Link>
                    )}
                  </div>
                )}
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-gray-600 dark:text-gray-300">
                    Evidencia · {f.ruleId} v{f.ruleVersion} · {f.engineVersion} ·{' '}
                    {f.windowStart && f.windowEnd
                      ? `${formatDay(f.windowStart)} – ${formatDay(f.windowEnd, true)}`
                      : ''}
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    {Object.entries(ev.metrics ?? {}).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-gray-500">{METRIC_LABEL[k] ?? k}</dt>
                        <dd className="tabular-nums">{formatEvidence(k, v, currency)}</dd>
                      </div>
                    ))}
                    {ev.reference && (
                      <div className="contents">
                        <dt className="text-gray-500">Referencia</dt>
                        <dd>
                          {ev.reference.metric}:{' '}
                          {formatEvidence(ev.reference.metric, ev.reference.value, currency)} (
                          {ev.reference.source})
                        </dd>
                      </div>
                    )}
                    {ev.pValue !== null && ev.pValue !== undefined && (
                      <div className="contents">
                        <dt className="text-gray-500">Valor p</dt>
                        <dd>
                          {ev.pValue < 0.0001 ? '< 0,0001' : ev.pValue.toFixed(4)}
                          {ev.fdr &&
                            ` · control de falsos descubrimientos (q = ${ev.fdr.q}): ${ev.fdr.passed ? 'superado' : 'no superado, severidad rebajada'}`}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {ev.method && <p className="mt-2 text-gray-500">Método: {ev.method}</p>}
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { AnalyticsChildRow, AnalyticsReport } from '../../src/contracts.ts';
import type { Role } from '../../src/domain.ts';
import {
  accountStatus,
  attributionLabel,
  COMPARE_MODES,
  type CompareMode,
  change,
  changeTone,
  compute,
  DEFAULT_COLUMNS,
  deliveryStatus,
  METRIC_IDS,
  METRICS,
  type MetricContext,
  type MetricId,
  type MetricValue,
  NO_DATA,
  type NodeLevel,
  PRESETS,
  type Preset,
  resultLabel,
  sumTotals,
  type Tone,
  type Totals,
} from '../../src/modules/insights/catalog.ts';
import { ApiError, api, download } from './api.ts';
import { type AuditLevel, AuditSection, HealthBadge, useAuditEntity } from './audit.tsx';
import { type ChartPoint, linePath, NotAvailable, TrendChart } from './chart.tsx';
import {
  formatAgo,
  formatDateTime,
  formatDay,
  formatDelta,
  formatMetric,
  formatRange,
} from './format.ts';
import { Icon } from './icons.tsx';
import { PortfolioWelcome } from './onboarding.tsx';
import { ErrorBox } from './pages.tsx';
import { ToneIcon } from './ui.tsx';

// Analítica (F2): una vista por nivel (cartera → cliente → cuenta → campaña → conjunto → anuncio)
// con el mismo esquema: periodo y comparación, notas sobre los datos, KPIs, tendencia, desglose
// de resultados y la tabla de los hijos para bajar de nivel. El estado vive en la URL
// (enlaces compartibles y botón atrás); las métricas salen del catálogo único.

const SLUG = {
  client: 'cliente',
  account: 'cuenta',
  campaign: 'campana',
  adset: 'conjunto',
  ad: 'anuncio',
} as const;
const FROM_SLUG = Object.fromEntries(Object.entries(SLUG).map(([k, v]) => [v, k])) as Record<
  string,
  Exclude<NodeLevel, 'org'>
>;
const LEVEL_LABEL: Record<NodeLevel, string> = {
  org: 'Cartera',
  client: 'Cliente',
  account: 'Cuenta publicitaria',
  campaign: 'Campaña',
  adset: 'Conjunto de anuncios',
  ad: 'Anuncio',
};
const CHILDREN_LABEL: Record<NodeLevel, string> = {
  org: 'clientes',
  client: 'cuentas',
  account: 'campañas',
  campaign: 'conjuntos de anuncios',
  adset: 'anuncios',
  ad: 'días',
};
const OBJECTIVES: Record<string, string> = {
  OUTCOME_AWARENESS: 'Reconocimiento',
  OUTCOME_TRAFFIC: 'Tráfico',
  OUTCOME_ENGAGEMENT: 'Interacción',
  OUTCOME_LEADS: 'Clientes potenciales',
  OUTCOME_APP_PROMOTION: 'Promoción de la app',
  OUTCOME_SALES: 'Ventas',
  // Objetivos de optimización de los conjuntos
  CONVERSATIONS: 'Conversaciones',
  LEAD_GENERATION: 'Clientes potenciales',
  QUALITY_LEAD: 'Clientes potenciales de calidad',
  LANDING_PAGE_VIEWS: 'Visitas a la página de destino',
  LINK_CLICKS: 'Clics en el enlace',
  OFFSITE_CONVERSIONS: 'Conversiones en el sitio web',
  VALUE: 'Valor de conversión',
  REACH: 'Alcance',
  IMPRESSIONS: 'Impresiones',
  THRUPLAY: 'ThruPlays',
  POST_ENGAGEMENT: 'Interacción con la publicación',
  APP_INSTALLS: 'Instalaciones de la app',
};
const objectiveLabel = (o: string) => OBJECTIVES[o] ?? o.toLowerCase().replaceAll('_', ' ');
const CLIENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Activo', tone: 'good' },
  paused: { label: 'En pausa', tone: 'neutral' },
  offboarded: { label: 'Baja', tone: 'neutral' },
};
const KPIS: MetricId[] = [
  'spend',
  'results',
  'costPerResult',
  'impressions',
  'cpm',
  'linkClicks',
  'linkCtr',
  'cpc',
];

export const nodePath = (level: NodeLevel, id: string | null) =>
  level === 'org' || !id ? '/analitica' : `/analitica/${SLUG[level]}/${encodeURIComponent(id)}`;

// --- Estado en la URL

const CARRIED = ['periodo', 'desde', 'hasta', 'comparar', 'moneda', 'metrica'];
const carried = (sp: URLSearchParams) => {
  const out = new URLSearchParams();
  for (const k of CARRIED) {
    const v = sp.get(k);
    if (v) out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
};
const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

function reportParams(level: NodeLevel, id: string | undefined, sp: URLSearchParams) {
  const p = new URLSearchParams({ level });
  if (id) p.set('id', id);
  const since = sp.get('desde');
  const until = sp.get('hasta');
  if (isDay(since) && isDay(until) && since <= until) {
    p.set('since', since);
    p.set('until', until);
  } else {
    const preset = sp.get('periodo');
    p.set('preset', preset && preset in PRESETS ? preset : 'last_7d');
  }
  const compare = sp.get('comparar');
  p.set('compare', compare && compare in COMPARE_MODES ? compare : 'previous');
  const currency = sp.get('moneda');
  if (currency && /^[A-Z]{3}$/.test(currency)) p.set('currency', currency);
  return p;
}

const reportQuery = (params: URLSearchParams) => ({
  queryKey: ['analytics', params.toString()],
  queryFn: () => api<AnalyticsReport>(`/v1/analytics?${params}`),
});

// --- Página

export function DashboardPage({ role }: { role: Role }) {
  const params = useParams();
  const [sp, setSp] = useSearchParams();
  const level: NodeLevel | undefined = params.level ? FROM_SLUG[params.level] : 'org';
  const apiParams = reportParams(level ?? 'org', params.id, sp);
  const query = useQuery({
    ...reportQuery(apiParams),
    placeholderData: keepPreviousData,
    enabled: level !== undefined,
  });
  const auditLevel: AuditLevel | null =
    level === 'account' || level === 'campaign' || level === 'adset' || level === 'ad'
      ? level
      : null;
  const audit = useAuditEntity(auditLevel, auditLevel ? (params.id ?? null) : null);
  const metricParam = sp.get('metrica');
  const metric: MetricId =
    metricParam && metricParam in METRICS ? (metricParam as MetricId) : 'spend';
  const set = (changes: Record<string, string | null>) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: false },
    );

  if (!level) return <p>Página no encontrada.</p>;
  if (query.error) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return notFound ? (
      <section className="space-y-2">
        <h1 className="text-lg font-semibold">No encontrado</h1>
        <p className="text-sm">Este elemento no existe o no tienes acceso a él.</p>
        <Link className="text-sm underline" to={`/analitica${carried(sp)}`}>
          Volver a la cartera
        </Link>
      </section>
    ) : (
      <ErrorBox error={query.error} />
    );
  }
  if (!query.data)
    return (
      <div className="dashboard-skeleton" role="status" aria-label="Cargando la analítica">
        <div className="skeleton" />
        <div className="skeleton-grid">
          {[1, 2, 3, 4].map((i) => (
            <div className="skeleton" key={i} />
          ))}
        </div>
        <div className="skeleton" />
      </div>
    );
  const r = query.data;
  const stale = query.isPlaceholderData;

  return (
    <div className="space-y-5" aria-busy={query.isFetching}>
      <p className="sr-only" aria-live="polite">
        {query.isFetching
          ? 'Actualizando datos…'
          : `${r.node.name}: datos de ${formatRange(r.range.since, r.range.until)}`}
      </p>
      {r.node.level !== 'org' && <Breadcrumbs report={r} search={carried(sp)} />}
      <header className="analytics-header">
        <div>
          <p className="page-eyebrow">
            {r.node.level === 'org' ? 'RENDIMIENTO DE TU CARTERA' : LEVEL_LABEL[r.node.level]}
          </p>
          <h1>{r.node.level === 'org' ? 'Resumen de cartera' : r.node.name}</h1>
          <p className="page-description">
            {r.node.level === 'org'
              ? 'Una perspectiva común de tus cuentas, resultados y oportunidades.'
              : `${LEVEL_LABEL[r.node.level]} · datos de ${formatRange(r.range.since, r.range.until)}`}
          </p>
        </div>
        {r.node.level !== 'org' && <StatusBadge row={r.node} />}
        {r.node.objective && (
          <span className="text-sm text-gray-500">· {objectiveLabel(r.node.objective)}</span>
        )}
        <span className="view-actions">
          {r.node.level === 'org' && (
            <Link to="/cuentas" className="button-secondary">
              <Icon name="accounts" size={14} />
              Ver cuentas
            </Link>
          )}
          {(r.node.level === 'account' || r.node.level === 'campaign') && r.node.id && (
            <Link
              className="button-secondary"
              to={`/prevision/${SLUG[r.node.level]}/${encodeURIComponent(r.node.id)}`}
            >
              Pronóstico y escenarios
            </Link>
          )}
          {role !== 'viewer' && (
            <Link
              className="button-secondary"
              to={`/asistente?nivel=${r.node.level}${r.node.id ? `&id=${r.node.id}` : ''}`}
            >
              <Icon name="assistant" size={14} />
              Consultar al asistente
            </Link>
          )}
        </span>
      </header>
      {r.node.level === 'org' && r.freshness.accounts === 0 ? (
        <PortfolioWelcome role={role} />
      ) : (
        <>
          <Toolbar report={r} sp={sp} set={set} />
          <div className={`space-y-5 transition-opacity ${stale ? 'opacity-60' : ''}`}>
            <DataNotes report={r} />
            <KpiGrid report={r} />
            {auditLevel && r.node.id && (
              <AuditSection
                level={auditLevel}
                id={r.node.id}
                accountId={r.node.accountId}
                currency={r.currency}
                role={role}
              />
            )}
            <div className="grid gap-5 lg:grid-cols-3">
              <section aria-labelledby="tendencia" className="data-panel lg:col-span-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 id="tendencia" className="font-semibold">
                    Tendencia diaria
                  </h2>
                  <label className="text-sm">
                    <span className="mr-2 text-gray-600 dark:text-gray-300">Métrica</span>
                    <select
                      className={select}
                      value={metric}
                      onChange={(e) => set({ metrica: e.target.value })}
                    >
                      {METRIC_IDS.map((id) => (
                        <option key={id} value={id}>
                          {METRICS[id].label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <TrendChart
                  metric={metric}
                  points={chartPoints(r, metric)}
                  currency={r.currency}
                  range={r.range}
                  compareRange={r.compare}
                />
              </section>
              <ResultsBreakdown report={r} />
            </div>
            {r.children ? (
              <ChildrenTable
                key={`${r.node.level}:${r.node.id}`}
                report={r}
                search={carried(sp)}
                health={audit.data?.childrenHealth ?? {}}
              />
            ) : (
              <DailyTable key={`${r.node.level}:${r.node.id}`} report={r} search={carried(sp)} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

const select =
  'rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950 focus-visible:outline-2 focus-visible:outline-offset-1';

function Breadcrumbs({ report, search }: { report: AnalyticsReport; search: string }) {
  return (
    <nav aria-label="Ruta">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
        {report.path.map((p, i) => {
          const last = i === report.path.length - 1;
          return (
            <li key={`${p.level}:${p.id}`} className="flex items-center gap-1">
              {last ? (
                <span aria-current="page" className="font-medium text-gray-900 dark:text-gray-100">
                  {p.name}
                </span>
              ) : (
                <Link
                  className="rounded hover:underline focus-visible:outline-2"
                  to={`${nodePath(p.level, p.id)}${search}`}
                >
                  {p.name}
                </Link>
              )}
              {!last && <span aria-hidden="true">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Toolbar({
  report,
  sp,
  set,
}: {
  report: AnalyticsReport;
  sp: URLSearchParams;
  set: (c: Record<string, string | null>) => void;
}) {
  const custom = isDay(sp.get('desde')) && isDay(sp.get('hasta'));
  const preset = custom ? 'custom' : (report.range.preset ?? 'last_7d');
  return (
    <fieldset className="analytics-toolbar">
      <legend className="sr-only">Periodo, comparación y moneda</legend>
      <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
        Periodo
        <select
          className={select}
          value={preset}
          onChange={(e) =>
            e.target.value === 'custom'
              ? set({ periodo: null, desde: report.range.since, hasta: report.range.until })
              : set({ periodo: e.target.value, desde: null, hasta: null })
          }
        >
          {(Object.entries(PRESETS) as Array<[Preset, string]>).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          <option value="custom">Personalizado…</option>
        </select>
      </label>
      {custom && (
        <>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            Desde
            <input
              type="date"
              className={select}
              value={report.range.since}
              max={report.range.until}
              onChange={(e) => isDay(e.target.value) && set({ desde: e.target.value })}
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            Hasta
            <input
              type="date"
              className={select}
              value={report.range.until}
              min={report.range.since}
              max={report.today}
              onChange={(e) => isDay(e.target.value) && set({ hasta: e.target.value })}
            />
          </label>
        </>
      )}
      <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
        Comparar con
        <select
          className={select}
          value={report.compare?.mode ?? 'none'}
          onChange={(e) => set({ comparar: e.target.value })}
        >
          {(Object.entries(COMPARE_MODES) as Array<[CompareMode, string]>).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {report.currencies.length > 1 && (
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          Moneda
          <select
            className={select}
            value={report.currency ?? ''}
            onChange={(e) => set({ moneda: e.target.value })}
          >
            {report.currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.accounts} {c.accounts === 1 ? 'cuenta' : 'cuentas'}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-sm">
        <strong className="font-medium">
          {formatRange(report.range.since, report.range.until)}
        </strong>
        <span className="text-gray-600 dark:text-gray-300">
          {' '}
          · {report.range.days} {report.range.days === 1 ? 'día' : 'días'}
          {report.compare &&
            ` · frente a ${formatRange(report.compare.since, report.compare.until)}`}
        </span>
      </p>
    </fieldset>
  );
}

// --- Notas sobre los datos: sincronización, zona horaria, moneda, atribución y madurez

function Note({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 dark:border-gray-800">
      <ToneIcon tone={tone} />
      <span>{children}</span>
    </li>
  );
}

function DataNotes({ report: r }: { report: AnalyticsReport }) {
  const f = r.freshness;
  const ageHours = f.oldestSyncAt ? (Date.now() - Date.parse(f.oldestSyncAt)) / 3_600_000 : null;
  let sync: { tone: Tone; text: string };
  if (f.accounts === 0) sync = { tone: 'neutral', text: 'Sin cuentas en esta vista' };
  else if (f.syncEnabled === 0) sync = { tone: 'warning', text: 'Sincronización desactivada' };
  else if (f.neverSynced > 0)
    sync = {
      tone: 'warning',
      text: `${f.neverSynced} de ${f.syncEnabled} cuentas aún sin sincronizar`,
    };
  else if (ageHours !== null && f.oldestSyncAt)
    sync = {
      tone: ageHours <= 2 ? 'good' : ageHours <= 6 ? 'warning' : 'critical',
      text: `${ageHours <= 2 ? 'Actualizado' : 'Retraso: actualizado'} ${formatAgo(f.oldestSyncAt)}`,
    };
  else sync = { tone: 'neutral', text: 'Sin datos de sincronización' };
  const immature = r.range.until >= f.immatureFrom;
  const otherCurrencies = r.currencies.filter((c) => c.code !== r.currency).map((c) => c.code);

  return (
    <details className="data-context">
      <summary>
        <span>
          <ToneIcon tone={sync.tone} />
          {sync.text}
        </span>
        <span>
          {immature ? 'Conversiones en maduración · ' : ''}Contexto de datos
          <Icon name="down" size={13} />
        </span>
      </summary>
      <ul
        aria-label="Sobre estos datos"
        className="flex flex-wrap gap-2 text-xs text-gray-700 dark:text-gray-300"
      >
        <Note tone={sync.tone}>
          <span
            title={
              f.oldestSyncAt
                ? `Última sincronización de la cuenta más atrasada: ${formatDateTime(f.oldestSyncAt)}`
                : undefined
            }
          >
            {sync.text}
          </span>
          {f.dataUntil && <> · datos hasta el {formatDay(f.dataUntil, true)}</>}
        </Note>
        <Note tone="neutral">
          {r.timezones.length > 1
            ? 'Varias zonas horarias: cada cuenta usa su propio día'
            : `Días en hora de ${r.timezones[0] ?? 'UTC'}`}
        </Note>
        <Note tone={otherCurrencies.length ? 'warning' : 'neutral'}>
          Moneda {r.currency ?? '—'}
          {otherCurrencies.length > 0 &&
            ` · las cuentas en ${otherCurrencies.join(', ')} se ven aparte (no se mezclan)`}
        </Note>
        <Note tone={r.attribution.length > 1 ? 'warning' : 'neutral'}>
          Atribución:{' '}
          {r.attribution.length === 0
            ? 'sin datos'
            : r.attribution.length > 1
              ? 'varias ventanas según la campaña'
              : attributionLabel(r.attribution[0] ?? null)}
        </Note>
        {immature && (
          <Note tone="warning">
            Los últimos 7 días pueden cambiar: hay conversiones aún por llegar
          </Note>
        )}
      </ul>
    </details>
  );
}

// --- Métricas: contexto, KPIs y definiciones

function nodeContext(
  r: AnalyticsReport,
  period: 'current' | 'previous' = 'current',
): MetricContext {
  const until = period === 'previous' && r.compare ? r.compare.until : r.range.until;
  return {
    days: r.range.days,
    reachSources: r.totals.sources,
    resultTypes: (period === 'previous' ? r.totals.previousResultTypes : r.totals.resultTypes)
      .length,
    immature: until >= r.freshness.immatureFrom,
  };
}

/** Contexto de un día suelto de la serie. */
const dayContext = (
  r: AnalyticsReport,
  date: string,
  period: 'current' | 'previous',
): MetricContext => ({
  ...nodeContext(r, period),
  days: 1,
  immature: date >= r.freshness.immatureFrom,
});

function chartPoints(r: AnalyticsReport, metric: MetricId): ChartPoint[] {
  return r.series.map((s) => ({
    date: s.date,
    previousDate: s.previousDate,
    current: compute(metric, s.current, dayContext(r, s.date, 'current')),
    previous:
      s.previous && s.previousDate
        ? compute(metric, s.previous, dayContext(r, s.previousDate, 'previous'))
        : null,
    immature: s.date >= r.freshness.immatureFrom,
  }));
}

function KpiGrid({ report: r }: { report: AnalyticsReport }) {
  const ctx = nodeContext(r);
  const prevCtx = r.compare ? nodeContext(r, 'previous') : null;
  const extra: MetricId[] = (['reach', 'frequency'] as const).filter(
    (id) => compute(id, r.totals.current, ctx).value !== null,
  );
  const single = r.totals.resultTypes.length === 1 ? r.totals.resultTypes[0] : undefined;
  return (
    <section aria-label="Indicadores clave">
      <ul className="kpi-grid">
        {[...KPIS, ...extra].map((id, index) => (
          <KpiTile
            key={id}
            id={id}
            primary={index < 4}
            series={index < 4 ? chartPoints(r, id).map((p) => p.current.value) : undefined}
            sublabel={
              (id === 'results' || id === 'costPerResult') && single
                ? resultLabel(single)
                : undefined
            }
            current={compute(id, r.totals.current, ctx)}
            previous={r.totals.previous && prevCtx ? compute(id, r.totals.previous, prevCtx) : null}
            currency={r.currency}
            compareLabel={r.compare ? COMPARE_MODES[r.compare.mode].toLowerCase() : null}
            attribution={r.attribution}
          />
        ))}
      </ul>
    </section>
  );
}

function KpiTile({
  id,
  sublabel,
  current,
  previous,
  currency,
  compareLabel,
  attribution,
  primary,
  series,
}: {
  id: MetricId;
  sublabel?: string;
  current: MetricValue;
  previous: MetricValue | null;
  currency: string | null;
  compareLabel: string | null;
  attribution: string[];
  primary: boolean;
  series?: Array<number | null>;
}) {
  const def = METRICS[id];
  const delta = change(current.value, previous?.value ?? null);
  const values = series?.filter((v): v is number => v !== null) ?? [],
    lo = Math.min(...values),
    hi = Math.max(...values);
  const sparkline =
    values.length > 1 && series
      ? linePath(
          series,
          (i) => 2 + (i * 96) / Math.max(1, series.length - 1),
          (v) => 27 - ((v - lo) / Math.max(hi - lo, 1)) * 22,
        )
      : null;
  return (
    <li className={`kpi-card ${primary ? '' : 'secondary'}`}>
      {primary && (
        <div className="metric-icon">
          <Icon
            size={15}
            name={
              id === 'spend'
                ? 'accounts'
                : id === 'results'
                  ? 'clients'
                  : id === 'costPerResult'
                    ? 'action'
                    : 'trend'
            }
          />
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm text-gray-600 dark:text-gray-300">
          {def.label}
          {sublabel && <span className="block text-xs text-gray-500">{sublabel}</span>}
        </h3>
        <MetricInfo id={id} attribution={attribution} />
      </div>
      {current.value === null ? (
        <>
          <p className="metric-unavailable">No disponible</p>
          <p className="text-xs text-gray-500">{current.reason}</p>
        </>
      ) : (
        <p className="metric-value">{formatMetric(id, current.value, currency)}</p>
      )}
      <StateTag value={current} />
      {compareLabel && current.value !== null && (
        <p className="mt-1 text-xs">
          {delta === null ? (
            <span className="text-gray-500">Sin dato del {compareLabel}</span>
          ) : (
            <>
              <Delta id={id} delta={delta} />{' '}
              <span className="text-gray-500">vs. {compareLabel}</span>
              {previous?.value !== null && previous && (
                <span className="block text-gray-500">
                  Antes: {formatMetric(id, previous.value as number, currency)}
                </span>
              )}
            </>
          )}
        </p>
      )}
      {sparkline && (
        <svg className="metric-sparkline" viewBox="0 0 100 32" aria-hidden="true">
          <path
            d={sparkline}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </li>
  );
}

function StateTag({ value }: { value: MetricValue }) {
  if (value.state === 'estimated')
    return <p className="mt-1 text-xs text-gray-500">Estimado por Meta</p>;
  if (value.state === 'immature')
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
        <ToneIcon tone="warning" /> En maduración
      </p>
    );
  if (value.state === 'not_applicable')
    return <p className="mt-1 text-xs text-gray-500">No aplica: {value.reason}</p>;
  return null;
}

function Delta({ id, delta }: { id: MetricId; delta: number }) {
  const tone = changeTone(id, delta);
  const color =
    tone === 'good'
      ? 'var(--status-good-text)'
      : tone === 'bad'
        ? 'var(--status-critical-text)'
        : undefined;
  const verdict = tone === 'good' ? ' (mejora)' : tone === 'bad' ? ' (empeora)' : '';
  return (
    <span className="font-medium tabular-nums" style={{ color }}>
      <span aria-hidden="true">{delta > 0 ? '▲' : delta < 0 ? '▼' : '='} </span>
      {formatDelta(delta)}
      <span className="sr-only">{verdict}</span>
    </span>
  );
}

/** Definición, fórmula y origen de una métrica, en un popover nativo (Esc o clic fuera lo cierran). */
function MetricInfo({ id, attribution }: { id: MetricId; attribution: string[] }) {
  const pid = useId();
  const def = METRICS[id];
  return (
    <>
      <button
        type="button"
        popoverTarget={pid}
        aria-label={`Definición de ${def.label}`}
        className="shrink-0 rounded-full px-1 text-xs leading-5 text-gray-500 hover:bg-gray-100 focus-visible:outline-2 dark:hover:bg-gray-800"
      >
        ⓘ
      </button>
      <div
        id={pid}
        popover="auto"
        role="dialog"
        aria-label={`Definición de ${def.label}`}
        className="metric-info rounded-lg border border-gray-200 bg-white p-4 text-left text-sm font-normal text-gray-900 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        <h4 className="mb-1 font-semibold">{def.label}</h4>
        <p className="mb-3">{def.definition}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-gray-500">Fórmula</dt>
          <dd>{def.formula}</dd>
          <dt className="text-gray-500">Origen</dt>
          <dd>
            {def.derived ? 'Calculada en Ad Astra con campos de Meta: ' : 'Meta, campo '}
            <code>{def.metaFields.join(', ')}</code>
          </dd>
          <dt className="text-gray-500">Suma</dt>
          <dd>
            {def.additive
              ? 'Se suma entre días y entidades'
              : 'No se suma: se recalcula desde sus componentes'}
          </dd>
          {def.conversion && (
            <>
              <dt className="text-gray-500">Atribución</dt>
              <dd>
                {attribution.length === 1
                  ? attributionLabel(attribution[0] ?? null)
                  : 'La de cada campaña'}
                . Los últimos 7 días aún pueden subir y Meta puede corregir hasta 28 días atrás.
              </dd>
            </>
          )}
        </dl>
        <button
          type="button"
          popoverTarget={pid}
          popoverTargetAction="hide"
          className="mt-3 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700"
        >
          Cerrar
        </button>
      </div>
    </>
  );
}

// --- Estado de entrega

type StatusFields = Pick<AnalyticsChildRow, 'statusKind' | 'status' | 'deleted' | 'learning'>;
function statusOf(row: StatusFields): { label: string; tone: Tone } {
  if (row.statusKind === 'account') return accountStatus(row.status ? Number(row.status) : null);
  if (row.statusKind === 'client')
    return (row.status && CLIENT_STATUS[row.status]) || { label: 'Sin cliente', tone: 'neutral' };
  return deliveryStatus(row.status, { deleted: row.deleted, learning: row.learning });
}

function StatusBadge({ row }: { row: StatusFields }) {
  const s = statusOf(row);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-gray-700 dark:text-gray-300">
      <ToneIcon tone={s.tone} />
      {s.label}
    </span>
  );
}

// --- Desglose de resultados

const CONVERSIONS: MetricId[] = [
  'messagingConversations',
  'leads',
  'purchases',
  'purchaseValue',
  'landingPageViews',
  'appInstalls',
  'thruplays',
];

function ResultsBreakdown({ report: r }: { report: AnalyticsReport }) {
  const max = Math.max(...r.results.map((x) => x.current ?? 0), 0);
  const ctx = nodeContext(r);
  const conversions = CONVERSIONS.map((id) => ({
    id,
    v: compute(id, r.totals.current, ctx),
  })).filter((c) => (c.v.value ?? 0) > 0);
  return (
    <section aria-labelledby="desglose" className="data-panel">
      <h2 id="desglose" className="font-semibold">
        Desglose de resultados
      </h2>
      <p className="mb-3 text-xs text-gray-500">
        Según el objetivo de cada campaña. Los tipos distintos no se suman.
      </p>
      {r.results.length === 0 ? (
        <p className="text-sm text-gray-500">Sin resultados en el periodo.</p>
      ) : (
        <ul className="space-y-3">
          {r.results.map((x) => (
            <li key={x.indicator}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{resultLabel(x.indicator)}</span>
                <span className="font-semibold tabular-nums">
                  {x.current === null ? (
                    <NotAvailable reason={NO_DATA} />
                  ) : (
                    formatMetric('results', x.current, null)
                  )}
                </span>
              </div>
              <div aria-hidden="true" className="mt-1 h-2">
                <div
                  className="h-2 rounded-r"
                  style={{
                    width: `${max > 0 && x.current !== null ? Math.max(2, (x.current / max) * 100) : 0}%`,
                    background: 'var(--viz-series)',
                  }}
                />
              </div>
              {r.compare && x.current !== null && (
                <p className="mt-0.5 text-xs text-gray-500">
                  {change(x.current, x.previous) === null ? (
                    'Sin dato del periodo anterior'
                  ) : (
                    <>
                      <Delta id="results" delta={change(x.current, x.previous) as number} /> · antes{' '}
                      {formatMetric('results', x.previous as number, null)}
                    </>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {conversions.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 text-sm font-medium">Conversiones registradas</h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            {conversions.map((c) => (
              <div key={c.id} className="contents">
                <dt className="text-gray-600 dark:text-gray-300">{METRICS[c.id].label}</dt>
                <dd className="text-right tabular-nums">
                  {formatMetric(c.id, c.v.value as number, r.currency)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

// --- Tablas

interface TableRow {
  key: string;
  name: string;
  cell: ReactNode;
  current: Totals;
  previous: Totals | null;
  ctx: MetricContext;
  prevCtx: MetricContext | null;
}

function readColumns(key: string): MetricId[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    if (Array.isArray(saved)) {
      const ok = saved.filter((c): c is MetricId => typeof c === 'string' && c in METRICS);
      if (ok.length) return ok;
    }
  } catch {
    // almacenamiento no disponible: columnas por defecto
  }
  return DEFAULT_COLUMNS;
}

function useColumns(level: NodeLevel) {
  const key = `ad-astra.columns.${level}`;
  const [cols, setCols] = useState<MetricId[]>(() => readColumns(key));
  const save = (next: MetricId[]) => {
    setCols(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // sin persistencia: dura lo que la pestaña
    }
  };
  return [cols, save] as const;
}

function ChildrenTable({
  report: r,
  search,
  health,
}: {
  report: AnalyticsReport;
  search: string;
  health: Record<
    string,
    { score: number | null; grade: Parameters<typeof HealthBadge>[0]['grade'] }
  >;
}) {
  const queryClient = useQueryClient();
  const children = r.children as NonNullable<AnalyticsReport['children']>;
  const level = children.level;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [objective, setObjective] = useState('');
  const [delivering, setDelivering] = useState(false);
  const statusLabels = [...new Set(children.rows.map((c) => statusOf(c).label))].sort();
  const objectives = [
    ...new Set(children.rows.map((c) => c.objective).filter((o): o is string => !!o)),
  ].sort();

  const prefetch = (row: AnalyticsChildRow) => {
    const params = reportParams(level, row.id, new URLSearchParams(search));
    void queryClient.prefetchQuery({ ...reportQuery(params), staleTime: 30_000 });
  };

  const visible = children.rows.filter((c) => {
    const needle = q.trim().toLowerCase();
    if (needle && !c.name.toLowerCase().includes(needle) && !c.id.includes(needle)) return false;
    if (status && statusOf(c).label !== status) return false;
    if (objective && c.objective !== objective) return false;
    if (delivering && !((c.current.spend ?? 0) > 0 || (c.current.impressions ?? 0) > 0))
      return false;
    return true;
  });

  const ctx = (c: AnalyticsChildRow, until: string, types: string[]): MetricContext => ({
    days: r.range.days,
    reachSources: Math.max(1, c.sources),
    resultTypes: types.length,
    immature: until >= r.freshness.immatureFrom,
  });
  const rows: TableRow[] = visible.map((c) => ({
    key: c.id,
    name: c.name,
    current: c.current,
    previous: c.previous,
    ctx: ctx(c, r.range.until, c.resultTypes),
    prevCtx: r.compare ? ctx(c, r.compare.until, c.previousResultTypes) : null,
    cell: (
      <div className="min-w-48">
        <Link
          to={`${nodePath(level, c.id)}${search}`}
          onMouseEnter={() => prefetch(c)}
          onFocus={() => prefetch(c)}
          className="font-medium hover:underline focus-visible:outline-2"
        >
          {c.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
          <StatusBadge row={c} />
          {c.objective && <span>{objectiveLabel(c.objective)}</span>}
          {c.statusKind === 'client' && (
            <span>
              {c.accounts} {c.accounts === 1 ? 'cuenta' : 'cuentas'}
            </span>
          )}
          {c.statusKind === 'account' && (
            <span>
              {c.lastSyncAt ? `Sincronizada ${formatAgo(c.lastSyncAt)}` : 'Sin sincronizar'}
            </span>
          )}
          {c.resultTypes.length === 1 && (
            <span>Resultado: {resultLabel(c.resultTypes[0] ?? null)}</span>
          )}
          {health[c.id] && (
            <HealthBadge
              score={health[c.id]?.score ?? null}
              grade={health[c.id]?.grade ?? 'insufficient'}
            />
          )}
        </div>
      </div>
    ),
  }));

  const exportPath = (cols: MetricId[]) =>
    `/v1/analytics/export.csv?${reportParams(r.node.level, r.node.id ?? undefined, new URLSearchParams(search))}&columns=${cols.join(',')}`;

  return (
    <MetricTable
      title={`${CHILDREN_LABEL[r.node.level][0]?.toUpperCase()}${CHILDREN_LABEL[r.node.level].slice(1)}`}
      noun={CHILDREN_LABEL[r.node.level]}
      level={level}
      report={r}
      rows={rows}
      total={children.rows.length}
      exportPath={exportPath}
      filters={
        <>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            Buscar
            <input
              type="search"
              className={select}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Nombre o ID"
            />
          </label>
          {statusLabels.length > 1 && (
            <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
              Estado
              <select className={select} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Todos</option>
                {statusLabels.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          {objectives.length > 1 && (
            <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
              {level === 'adset' ? 'Optimización' : 'Objetivo'}
              <select
                className={select}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              >
                <option value="">Todos</option>
                {objectives.map((o) => (
                  <option key={o} value={o}>
                    {objectiveLabel(o)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 self-end pb-1 text-sm">
            <input
              type="checkbox"
              checked={delivering}
              onChange={(e) => setDelivering(e.target.checked)}
            />
            Solo con entrega
          </label>
        </>
      }
    />
  );
}

function DailyTable({ report: r, search }: { report: AnalyticsReport; search: string }) {
  const rows: TableRow[] = r.series.map((s) => ({
    key: s.date,
    name: s.date,
    current: s.current,
    previous: s.previous,
    ctx: dayContext(r, s.date, 'current'),
    prevCtx: s.previousDate ? dayContext(r, s.previousDate, 'previous') : null,
    cell: (
      <span className="whitespace-nowrap">
        {formatDay(s.date, true)}
        {s.date >= r.freshness.immatureFrom && (
          <span className="ml-1 text-xs text-gray-500">(en maduración)</span>
        )}
        {s.previousDate && (
          <span className="block text-xs text-gray-500">vs. {formatDay(s.previousDate, true)}</span>
        )}
      </span>
    ),
  }));
  return (
    <MetricTable
      title="Detalle diario"
      noun="días"
      level="ad"
      report={r}
      rows={rows}
      total={rows.length}
      exportPath={(cols) =>
        `/v1/analytics/export.csv?${reportParams(r.node.level, r.node.id ?? undefined, new URLSearchParams(search))}&columns=${cols.join(',')}`
      }
      filters={null}
      defaultSort="name"
    />
  );
}

function MetricTable({
  title,
  noun,
  level,
  report: r,
  rows,
  total,
  filters,
  exportPath,
  defaultSort = 'spend',
}: {
  title: string;
  noun: string;
  level: NodeLevel;
  report: AnalyticsReport;
  rows: TableRow[];
  total: number;
  filters: ReactNode;
  exportPath: (cols: MetricId[]) => string;
  defaultSort?: 'name' | MetricId;
}) {
  const [cols, setCols] = useColumns(level);
  const [sort, setSort] = useState<{ by: 'name' | MetricId; dir: 'asc' | 'desc' }>({
    by: defaultSort,
    dir: defaultSort === 'name' ? 'asc' : 'desc',
  });
  const [showDelta, setShowDelta] = useState(false);
  const [exporting, setExporting] = useState<Error | null | 'busy'>(null);
  const headingId = useId();
  const compare = r.compare !== null;

  const computed = useMemo(
    () =>
      rows.map((row) => {
        const values = Object.fromEntries(
          cols.map((id) => {
            const cur = compute(id, row.current, row.ctx);
            const prev =
              row.previous && row.prevCtx ? compute(id, row.previous, row.prevCtx) : null;
            return [id, { cur, prev }];
          }),
        ) as Record<MetricId, { cur: MetricValue; prev: MetricValue | null }>;
        return { row, values };
      }),
    [rows, cols],
  );

  const sorted = [...computed].sort((a, b) => {
    const sign = sort.dir === 'asc' ? 1 : -1;
    if (sort.by === 'name') return sign * a.row.name.localeCompare(b.row.name);
    const pick = (x: (typeof computed)[number]) => {
      const v = x.values[sort.by as MetricId];
      if (!v) return null;
      // Con la variación visible se ordena por el cambio absoluto: qué fila explica la diferencia.
      if (showDelta && compare)
        return v.cur.value !== null && v.prev?.value != null ? v.cur.value - v.prev.value : null;
      return v.cur.value;
    };
    const va = pick(a);
    const vb = pick(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // sin dato, siempre al final
    if (vb === null) return -1;
    return sign * (va - vb);
  });

  const totalCtx: MetricContext = {
    days: rows[0]?.ctx.days ?? r.range.days,
    reachSources: Math.max(1, rows.length),
    resultTypes: r.totals.resultTypes.length,
    immature: r.range.until >= r.freshness.immatureFrom,
  };
  const totalCur = sumTotals(rows.map((x) => x.current));
  const totalPrev = compare ? sumTotals(rows.map((x) => x.previous ?? sumTotals([]))) : null;

  const toggleSort = (by: 'name' | MetricId) =>
    setSort((s) =>
      s.by === by
        ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { by, dir: by === 'name' ? 'asc' : 'desc' },
    );
  const ariaSort = (by: 'name' | MetricId) =>
    sort.by === by ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

  const cell = (id: MetricId, v: { cur: MetricValue; prev: MetricValue | null }) => (
    <>
      {v.cur.value === null ? (
        <NotAvailable reason={v.cur.reason} />
      ) : (
        formatMetric(id, v.cur.value, r.currency)
      )}
      {v.cur.state === 'immature' && (
        <span title="En maduración" className="ml-0.5 text-gray-400">
          *
        </span>
      )}
      {showDelta && compare && (
        <span className="block text-xs">
          {change(v.cur.value, v.prev?.value ?? null) === null ? (
            <span className="text-gray-400">—</span>
          ) : (
            <Delta id={id} delta={change(v.cur.value, v.prev?.value ?? null) as number} />
          )}
        </span>
      )}
    </>
  );

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={headingId} className="font-semibold">
            {title}
          </h2>
          <p className="text-xs text-gray-500">
            Mostrando {rows.length} de {total} {noun}
            {showDelta &&
              compare &&
              sort.by !== 'name' &&
              ` · ordenado por la variación de ${METRICS[sort.by].label.toLowerCase()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {filters}
          {compare && (
            <label className="flex items-center gap-2 self-end pb-1 text-sm">
              <input
                type="checkbox"
                checked={showDelta}
                onChange={(e) => setShowDelta(e.target.checked)}
              />
              Mostrar variación
            </label>
          )}
          <ColumnPicker cols={cols} setCols={setCols} />
          <button
            type="button"
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
            disabled={exporting === 'busy'}
            onClick={async () => {
              setExporting('busy');
              try {
                await download(exportPath(cols));
                setExporting(null);
              } catch (e) {
                setExporting(e as Error);
              }
            }}
          >
            {exporting === 'busy' ? 'Exportando…' : 'Exportar CSV'}
          </button>
        </div>
      </div>
      {exporting instanceof Error && <ErrorBox error={exporting} />}
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
          {total === 0
            ? `Todavía no hay ${noun} con datos en esta vista.`
            : 'Ninguna fila coincide con los filtros.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="min-w-full text-sm">
            <caption className="sr-only">
              {title}, {formatRange(r.range.since, r.range.until)}. Pulsa el nombre para ver el
              detalle.
            </caption>
            <thead className="bg-gray-50 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
              <tr>
                <th
                  scope="col"
                  aria-sort={ariaSort('name')}
                  className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left font-medium dark:bg-gray-900"
                >
                  <SortButton
                    active={sort.by === 'name'}
                    dir={sort.dir}
                    onClick={() => toggleSort('name')}
                  >
                    Nombre
                  </SortButton>
                </th>
                {cols.map((id) => (
                  <th
                    key={id}
                    scope="col"
                    aria-sort={ariaSort(id)}
                    className="px-3 py-2 text-right font-medium whitespace-nowrap"
                  >
                    <span className="inline-flex items-center gap-0.5">
                      <SortButton
                        active={sort.by === id}
                        dir={sort.dir}
                        onClick={() => toggleSort(id)}
                      >
                        {METRICS[id].label}
                      </SortButton>
                      <MetricInfo id={id} attribution={r.attribution} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ row, values }) => (
                <tr
                  key={row.key}
                  className="border-t border-gray-100 hover:bg-gray-50 dark:border-gray-900 dark:hover:bg-gray-900/50"
                >
                  <th
                    scope="row"
                    className="sticky left-0 bg-white px-3 py-2 text-left font-normal dark:bg-gray-950"
                  >
                    {row.cell}
                  </th>
                  {cols.map((id) => (
                    <td key={id} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {cell(id, values[id])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot className="border-t-2 border-gray-200 font-medium dark:border-gray-800">
                <tr>
                  <th
                    scope="row"
                    className="sticky left-0 bg-white px-3 py-2 text-left dark:bg-gray-950"
                  >
                    Total de las filas visibles
                  </th>
                  {cols.map((id) => (
                    <td key={id} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {cell(id, {
                        cur: compute(id, totalCur, totalCtx),
                        prev:
                          totalPrev && r.compare
                            ? compute(id, totalPrev, {
                                ...totalCtx,
                                resultTypes: r.totals.previousResultTypes.length,
                                immature: r.compare.until >= r.freshness.immatureFrom,
                              })
                            : null,
                      })}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      <p className="text-xs text-gray-500">
        n/d: no disponible (pasa el puntero o el foco para ver el motivo) · *: en maduración · La
        exportación incluye todas las filas y las columnas elegidas.
      </p>
    </section>
  );
}

function SortButton({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded hover:underline focus-visible:outline-2"
    >
      {children}
      <span aria-hidden="true" className={active ? '' : 'opacity-30'}>
        {active && dir === 'asc' ? '↑' : '↓'}
      </span>
    </button>
  );
}

function ColumnPicker({ cols, setCols }: { cols: MetricId[]; setCols: (c: MetricId[]) => void }) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700">
        Columnas ({cols.length})
      </summary>
      <div className="absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-auto rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900">
        <fieldset>
          <legend className="mb-2 text-xs text-gray-500">
            Columnas visibles (en el orden en que se activan)
          </legend>
          {METRIC_IDS.map((id) => (
            <label key={id} className="flex items-center gap-2 py-0.5 text-sm">
              <input
                type="checkbox"
                checked={cols.includes(id)}
                onChange={(e) =>
                  setCols(e.target.checked ? [...cols, id] : cols.filter((c) => c !== id))
                }
                disabled={cols.length === 1 && cols.includes(id)}
              />
              {METRICS[id].label}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="mt-2 text-xs underline"
          onClick={() => setCols(DEFAULT_COLUMNS)}
        >
          Restablecer
        </button>
      </div>
    </details>
  );
}

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type FormEvent, type KeyboardEvent, type PointerEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import type {
  AdAccount,
  Forecast,
  ForecastMetric,
  Simulation,
  SimulationCampaign,
} from '../../src/contracts.ts';
import type { Tone } from '../../src/modules/insights/catalog.ts';
import { api } from './api.ts';
import { linePath, niceStep, useWidth } from './chart.tsx';
import { formatDay, formatDayLong, formatRange, formatValue } from './format.ts';
import { ErrorBox } from './pages.tsx';
import { ToneIcon } from './ui.tsx';

// Previsión (F6): pronóstico "si nada cambia" con su ficha de modelo y simulador de escenarios de
// presupuesto. Todo rango es un intervalo del 80 % y se presenta como estimación, nunca como
// garantía; lo que no supera su validación no se muestra y se dice por qué.

type Unit = 'currency' | 'count';
type ForecastEvent = Forecast['events'][number];
const STATUS: Record<string, { label: string; tone: Tone }> = {
  published: { label: 'Publicado', tone: 'good' },
  not_published: { label: 'No publicado', tone: 'warning' },
  insufficient_data: { label: 'Datos insuficientes', tone: 'neutral' },
  paused: { label: 'En pausa', tone: 'neutral' },
};
const HORIZONS = [7, 14, 28, 56];
const SIM_HORIZONS = [7, 14, 28, 56, 91];
const box = 'min-w-0 rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const select =
  'rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950 focus-visible:outline-2 focus-visible:outline-offset-1';
const button =
  'rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';

const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? 'n/d' : `${Math.round(x * 100)} %`;
const dec = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined ? 'n/d' : x.toFixed(d).replace('.', ',');
const fmt = (v: number, unit: Unit, currency: string | null, compact = false) =>
  formatValue(unit === 'count' && !compact ? Math.round(v) : v, unit, currency, compact);

function StatusTag({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
      <ToneIcon tone={s.tone} />
      {s.label}
    </span>
  );
}

function Disclaimer() {
  return (
    <p
      role="note"
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950/40"
    >
      <strong>Estimación, no garantía.</strong> Los rangos tienen un nivel nominal del 80 %.
      Consulta la cobertura medida y los supuestos de cada modelo. Describen patrones observados;
      los escenarios de presupuesto dependen de supuestos adicionales y no prueban causalidad.
    </p>
  );
}

// --- Página

export function ForecastPage() {
  const { level, id } = useParams();
  if (!level || !id) return <AccountPicker />;
  const nodeLevel = level === 'cuenta' ? 'account' : level === 'campana' ? 'campaign' : null;
  if (!nodeLevel) return <p>Página no encontrada.</p>;
  return <ForecastView key={`${nodeLevel}:${id}`} level={nodeLevel} id={id} />;
}

function AccountPicker() {
  const accounts = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => api<AdAccount[]>('/v1/ad-accounts'),
  });
  if (accounts.error) return <ErrorBox error={accounts.error} />;
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Previsión y escenarios</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Elige una cuenta publicitaria. Desde la analítica de una campaña también puedes abrir su
        pronóstico.
      </p>
      {!accounts.data ? (
        <p className="text-sm text-gray-500">Cargando cuentas…</p>
      ) : accounts.data.length === 0 ? (
        <p className="text-sm">No hay cuentas visibles para ti.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-900 dark:border-gray-800">
          {accounts.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <Link className="underline" to={`/prevision/cuenta/${a.id}`}>
                {a.name}
              </Link>
              <span className="text-sm text-gray-500">
                {a.metaAccountId} · {a.currency}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ForecastView({ level, id }: { level: 'account' | 'campaign'; id: string }) {
  const [horizon, setHorizon] = useState(28);
  const [events, setEvents] = useState<ForecastEvent[]>([]);
  const [builtinCalendar, setBuiltinCalendar] = useState(false);
  const body = { level, id, horizonDays: horizon, events, builtinCalendar };
  const q = useQuery({
    queryKey: ['forecast', body],
    queryFn: () => api<Forecast>('/v1/forecasts', { method: 'POST', body }),
    placeholderData: keepPreviousData,
  });
  const [metricId, setMetricId] = useState('spend');

  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="p-6 text-sm text-gray-500">Calculando el pronóstico…</p>;
  const f = q.data;
  const metric = f.metrics.find((m) => m.id === metricId) ?? f.metrics[0];
  const analytics = `/analitica/${level === 'account' ? 'cuenta' : 'campana'}/${encodeURIComponent(f.node.id)}`;

  return (
    <div className="space-y-5" aria-busy={q.isFetching}>
      <nav aria-label="Ruta" className="text-sm text-gray-600 dark:text-gray-300">
        <Link className="underline" to="/prevision">
          Previsión
        </Link>{' '}
        › {f.node.name}
      </nav>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">{f.node.name}</h1>
        <span className="text-sm text-gray-500">
          {level === 'account' ? 'Cuenta publicitaria' : 'Campaña'} · {f.node.currency}
        </span>
        <Link className="ml-auto text-sm underline" to={analytics}>
          Ver la analítica
        </Link>
      </header>
      <Disclaimer />
      <div className={`space-y-5 transition-opacity ${q.isPlaceholderData ? 'opacity-60' : ''}`}>
        <section aria-labelledby="pronostico" className={`${box} space-y-4`}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="pronostico" className="font-semibold">
                Pronóstico si nada cambia
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Datos hasta el {formatDayLong(f.asOf)}; el ajuste usa hasta el{' '}
                {formatDay(f.cut, true)} ({f.gapDays} días de maduración de conversiones).
              </p>
            </div>
            <label className="text-sm">
              <span className="mr-2 text-gray-600 dark:text-gray-300">Horizonte</span>
              <select
                className={select}
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
              >
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {h} días
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DataSummary forecast={f} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={builtinCalendar}
              onChange={(e) => setBuiltinCalendar(e.target.checked)}
            />
            Usar calendario de Honduras, fechas comerciales y quincenas
          </label>
          <EventEditor value={events} onChange={setEvents} />
          {f.calendar.length > 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Eventos del horizonte:{' '}
              {f.calendar.map((e) => `${e.label} (${formatRange(e.since, e.until)})`).join('; ')}.
            </p>
          )}
          {metric && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Métrica">
                {f.metrics.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={m.id === metric.id}
                    className={`rounded px-2.5 py-1 text-sm ${m.id === metric.id ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'border border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900'}`}
                    onClick={() => setMetricId(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <FanChart metric={metric} currency={f.node.currency} />
              <ModelCard metric={metric} />
              <EventEffects metric={metric} />
            </div>
          )}
          <TotalsTable forecast={f} />
          <CardNotes assumptions={f.assumptions} limitations={f.limitations} />
          <p className="text-xs text-gray-500">
            {f.version} · huella de las entradas {f.inputHash.slice(0, 12)}
          </p>
        </section>
        {level === 'account' ? (
          <ScenarioSimulator
            accountId={f.node.accountId}
            currency={f.node.currency}
            events={events}
            builtinCalendar={builtinCalendar}
          />
        ) : (
          <p className="text-sm">
            El simulador reparte el presupuesto entre las campañas de una cuenta:{' '}
            <Link className="underline" to={`/prevision/cuenta/${f.node.accountId}`}>
              abrir el de la cuenta
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}

function DataSummary({ forecast: f }: { forecast: Forecast }) {
  const missing = f.requiredDays - f.usableDays;
  return (
    <div className="space-y-1 text-sm">
      <p>
        Historia utilizable: <strong>{f.usableDays} días</strong>
        {f.start && ` desde el ${formatDay(f.start, true)}`}. Este horizonte exige {f.requiredDays}{' '}
        días ({String(f.criteria.minTrain)} de entrenamiento y orígenes semanales para validar y
        calibrar).
      </p>
      {missing > 0 && (
        <p className="flex items-center gap-1.5">
          <ToneIcon tone="neutral" />
          Faltan {missing} días de historia para publicar cualquier pronóstico con este horizonte.
          Un horizonte más corto exige menos.
        </p>
      )}
      {f.breaks.length > 0 && (
        <p className="text-gray-600 dark:text-gray-300">
          Cortes de la historia:{' '}
          {f.breaks
            .map(
              (b) =>
                `${formatDay(b.date, true)} (${b.reason === 'attribution' ? 'cambio de atribución' : 'reanudación tras una pausa'})`,
            )
            .join(', ')}
          . Lo anterior no se usa.
        </p>
      )}
    </div>
  );
}

function EventEditor({
  value,
  onChange,
}: {
  value: ForecastEvent[];
  onChange: (v: ForecastEvent[]) => void;
}) {
  const [draft, setDraft] = useState<ForecastEvent>({
    since: '',
    until: '',
    label: '',
    category: 'promotion',
    yearly: false,
  });
  const formId = useId();
  const days = (Date.parse(draft.until) - Date.parse(draft.since)) / 86_400_000;
  const valid = draft.since && draft.until && days >= 0 && days <= 62 && draft.label.trim();
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onChange([...value, { ...draft, label: draft.label.trim() }]);
    setDraft({ since: '', until: '', label: '', category: 'promotion', yearly: false });
  };
  const input =
    'rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950';
  return (
    <details className="rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
      <summary className="cursor-pointer">
        Eventos externos ({value.length}): promociones, festivos, caídas de seguimiento…
      </summary>
      <p className="mt-2 text-gray-600 dark:text-gray-300">
        Promociones, festivos y pagos se estiman con su historia. Sin ocurrencias, el modelo usa un
        supuesto previo y amplía la incertidumbre. Las incidencias se excluyen del ajuste y la
        evaluación. Máximo 62 días por evento; solo marca eventos conocidos al planificar.
      </p>
      {value.length > 0 && (
        <ul className="mt-2 space-y-1">
          {value.map((r, i) => (
            <li
              key={`${r.since}-${r.until}-${r.label}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span>
                {formatRange(r.since, r.until)} · {r.label} ({r.category})
                {r.yearly ? ' · anual' : ''}
              </span>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
      <form id={formId} className="mt-2 flex flex-wrap items-end gap-2" onSubmit={add}>
        <label className="flex flex-col">
          <span className="text-xs text-gray-500">Desde</span>
          <input
            type="date"
            className={input}
            value={draft.since}
            onChange={(e) => setDraft({ ...draft, since: e.target.value })}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-gray-500">Hasta</span>
          <input
            type="date"
            className={input}
            value={draft.until}
            onChange={(e) => setDraft({ ...draft, until: e.target.value })}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-gray-500">Motivo</span>
          <input
            className={input}
            maxLength={80}
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-gray-500">Tipo</span>
          <select
            className={select}
            value={draft.category}
            onChange={(e) =>
              setDraft({ ...draft, category: e.target.value as ForecastEvent['category'] })
            }
          >
            <option value="promotion">Promoción</option>
            <option value="holiday">Festivo</option>
            <option value="commercial">Fecha comercial</option>
            <option value="payday">Días de pago</option>
            <option value="incident">Incidencia (excluir)</option>
          </select>
        </label>
        <label className="flex items-center gap-1 py-1">
          <input
            type="checkbox"
            checked={draft.yearly}
            onChange={(e) => setDraft({ ...draft, yearly: e.target.checked })}
          />{' '}
          Repetir cada año
        </label>
        <button type="submit" className={button} disabled={!valid || value.length >= 20}>
          Añadir evento
        </button>
      </form>
    </details>
  );
}

// --- Gráfico de abanico: historia observada, pronóstico central e intervalo del 80 %

const CH = 220;
const CM = { top: 16, right: 24, bottom: 28, left: 64 };

function FanChart({ metric, currency }: { metric: ForecastMetric; currency: string }) {
  const { ref, width } = useWidth<HTMLElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const unit = metric.unit;
  const future = metric.forecast ?? [];
  const points = [
    ...metric.history.map((h) => ({
      date: h.date,
      value: h.value,
      immature: h.immature,
      band: null,
    })),
    ...future.map((p) => ({ date: p.date, value: null, immature: false, band: p })),
  ];
  const n = points.length;
  const all = points
    .flatMap((p) => [p.value, p.band?.upper ?? null])
    .filter((x): x is number => x !== null);
  const max = Math.max(1e-9, ...all);
  const step = niceStep(max);
  const top = step * Math.ceil(max / step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = width - CM.left - CM.right;
  const x = (i: number) => CM.left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (val: number) => CM.top + CH - (val / top) * CH;
  const split = metric.history.length;
  const firstImmature = points.findIndex((p) => p.immature);
  const f = (val: number, compact = false) => fmt(val, unit, currency, compact);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));

  const central = points.map((p, i) => (i === split - 1 ? p.value : (p.band?.point ?? null)));
  const band = future.length
    ? `M${future.map((p, i) => `${x(split + i).toFixed(1)},${y(p.upper).toFixed(1)}`).join('L')}L${[
        ...future,
      ]
        .reverse()
        .map((p, i) => `${x(split + future.length - 1 - i).toFixed(1)},${y(p.lower).toFixed(1)}`)
        .join('L')}Z`
    : '';
  const pick = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - CM.left) / plotW) * (n - 1)))));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => Math.min(n - 1, Math.max(0, (h ?? (d === 1 ? -1 : n)) + d)));
    } else if (e.key === 'Escape') setHover(null);
  };
  const summary = `${metric.label}: ${metric.history.length} días observados${
    metric.total
      ? ` y pronóstico de ${future.length} días; total central ${f(metric.total.point)}, intervalo del 80 % entre ${f(metric.total.lower)} y ${f(metric.total.upper)}`
      : '; sin pronóstico publicado'
  }. Usa las flechas para recorrer los días.`;
  const h = hover !== null ? points[hover] : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        <Key color="var(--viz-series)" label="Observado" />
        {future.length > 0 && <Key color="var(--viz-series)" label="Pronóstico central" dashed />}
        {future.length > 0 && (
          <Key color="var(--viz-series-wash)" label="Intervalo del 80 %" block />
        )}
        {firstImmature >= 0 && <Key color="var(--viz-immature)" label="En maduración" block />}
        <button
          type="button"
          className="ml-auto rounded px-2 py-1 hover:underline focus-visible:outline-2"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? 'Ver gráfico' : 'Ver como tabla'}
        </button>
      </div>
      {metric.status !== 'published' && (
        <p className="mb-2 flex items-start gap-1.5 text-sm">
          <ToneIcon tone={STATUS[metric.status]?.tone ?? 'neutral'} />
          <span>Sin pronóstico publicado: {metric.reasons.join(' ')}</span>
        </p>
      )}
      {asTable ? (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">{summary}</caption>
            <thead className="sticky top-0 bg-white text-left text-xs text-gray-500 dark:bg-gray-950">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Día
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Observado
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Central
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Intervalo del 80 %
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date} className="border-t border-gray-100 dark:border-gray-900">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {formatDayLong(p.date)}
                    {p.immature && (
                      <span className="ml-1 text-xs text-gray-500">(en maduración)</span>
                    )}
                  </th>
                  <td className="py-1 pr-3 text-right">
                    {p.value === null ? (p.band ? '' : 'n/d') : f(p.value)}
                  </td>
                  <td className="py-1 pr-3 text-right">{p.band ? f(p.band.point) : ''}</td>
                  <td className="py-1 text-right">
                    {p.band ? `${f(p.band.lower)} – ${f(p.band.upper)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <figure
          ref={ref}
          className="relative rounded focus-visible:outline-2 focus-visible:outline-offset-2"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: foco para recorrer los días con las flechas (la tabla es su equivalente)
          tabIndex={0}
          aria-labelledby={titleId}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          <span id={titleId} className="sr-only">
            {summary}
          </span>
          <svg
            width={width}
            height={CH + CM.top + CM.bottom}
            viewBox={`0 0 ${width} ${CH + CM.top + CM.bottom}`}
            aria-hidden="true"
            className="block touch-pan-y select-none"
            onPointerMove={(e: PointerEvent<SVGSVGElement>) => pick(e.clientX, e.currentTarget)}
            onPointerDown={(e: PointerEvent<SVGSVGElement>) => pick(e.clientX, e.currentTarget)}
            onPointerLeave={() => setHover(null)}
          >
            {firstImmature >= 0 && (
              <rect
                x={x(firstImmature) - plotW / Math.max(1, n - 1) / 2}
                y={CM.top}
                width={x(split - 1) - x(firstImmature) + plotW / Math.max(1, n - 1)}
                height={CH}
                fill="var(--viz-immature)"
              />
            )}
            {ticks.map((tk) => (
              <g key={tk}>
                <line
                  x1={CM.left}
                  x2={CM.left + plotW}
                  y1={y(tk)}
                  y2={y(tk)}
                  stroke={tk === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                />
                <text
                  x={CM.left - 8}
                  y={y(tk)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill="var(--viz-ink-muted)"
                >
                  {f(tk, true)}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={p.date}
                  x={x(i)}
                  y={CM.top + CH + 18}
                  textAnchor={i === 0 ? 'start' : 'middle'}
                  fontSize={11}
                  fill="var(--viz-ink-muted)"
                >
                  {formatDay(p.date)}
                </text>
              ) : null,
            )}
            {future.length > 0 && <path d={band} fill="var(--viz-series-wash)" stroke="none" />}
            {future.length > 0 && (
              <line
                x1={x(split - 0.5)}
                x2={x(split - 0.5)}
                y1={CM.top}
                y2={CM.top + CH}
                stroke="var(--viz-axis)"
                strokeDasharray="2 3"
              />
            )}
            <path
              d={linePath(
                points.map((p) => p.value),
                x,
                y,
              )}
              fill="none"
              stroke="var(--viz-series)"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {future.length > 0 && (
              <path
                d={linePath(central, x, y)}
                fill="none"
                stroke="var(--viz-series)"
                strokeWidth={2}
                strokeDasharray="5 4"
              />
            )}
            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={CM.top}
                y2={CM.top + CH}
                stroke="var(--viz-axis)"
              />
            )}
          </svg>
          {h && hover !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-md border border-black/10 bg-white px-3 py-2 text-xs shadow-md dark:border-white/10 dark:bg-gray-900"
              style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 200) }}
            >
              <div className="mb-1 text-gray-500">{formatDayLong(h.date)}</div>
              {h.band ? (
                <>
                  <div>
                    Central <strong>{f(h.band.point)}</strong>
                  </div>
                  <div className="text-gray-500">
                    80 %: {f(h.band.lower)} – {f(h.band.upper)}
                  </div>
                </>
              ) : (
                <div>
                  {h.value === null ? 'No disponible' : <strong>{f(h.value)}</strong>}
                  {h.immature && <span className="ml-1 text-gray-500">en maduración</span>}
                </div>
              )}
            </div>
          )}
        </figure>
      )}
    </div>
  );
}

function Key({
  color,
  label,
  dashed,
  block,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  block?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {block ? (
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: color, outline: '1px solid var(--viz-axis)' }}
        />
      ) : (
        <svg aria-hidden="true" width="16" height="4">
          <line
            x1="0"
            x2="16"
            y1="2"
            y2="2"
            stroke={color}
            strokeWidth="2"
            strokeDasharray={dashed ? '4 3' : undefined}
          />
        </svg>
      )}
      {label}
    </span>
  );
}

// --- Ficha del modelo y totales

function EventEffects({ metric }: { metric: ForecastMetric }) {
  if (!metric.events.length) return null;
  return (
    <details className="rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
      <summary className="cursor-pointer">Efectos de eventos y evidencia</summary>
      <p className="mt-2 text-gray-600 dark:text-gray-300">
        Multiplicadores respecto al día habitual. Un efecto basado en el a priori es un supuesto,
        sin validación específica para ese evento. La recurrencia anual no equivale a una
        estacionalidad anual aprendida.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left tabular-nums">
          <caption className="sr-only">
            Evidencia de los efectos de eventos para {metric.label}
          </caption>
          <thead>
            <tr>
              <th scope="col">Evento</th>
              <th scope="col">Ocurrencias</th>
              <th scope="col">Multiplicador (80 %)</th>
              <th scope="col">Fuente</th>
            </tr>
          </thead>
          <tbody>
            {metric.events.map((e) => (
              <tr key={e.key}>
                <th scope="row" className="py-1 pr-3 font-normal">
                  {e.label}
                </th>
                <td>{e.occurrences}</td>
                <td>
                  {dec(e.effect.point)} ({dec(e.effect.lower)} a {dec(e.effect.upper)})
                </td>
                <td>
                  {e.source === 'history'
                    ? 'Historia, con contracción'
                    : 'A priori, sin ocurrencias'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ModelCard({ metric }: { metric: ForecastMetric }) {
  const bt = metric.backtest;
  return (
    <details className="rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
      <summary className="cursor-pointer">
        Ficha del modelo · {metric.label}: <StatusTag status={metric.status} />
      </summary>
      <div className="mt-2 space-y-2">
        <p>
          {metric.usableDays} días utilizables (se exigen {metric.requiredDays}). Media diaria de
          los últimos 56 días: {dec(metric.recentDailyMean)}.
          {metric.anomalies.length > 0 &&
            ` Picos aislados acotados al ajustar: ${metric.anomalies.map((d) => formatDay(d, true)).join(', ')}.`}
        </p>
        {metric.reasons.length > 0 && <p>{metric.reasons.join(' ')}</p>}
        {bt && (
          <>
            <p>
              Backtest: {bt.origins} orígenes semanales; {bt.selectionOrigins} para elegir el modelo
              y {bt.evaluationOrigins} posteriores para evaluar su error. Modelo elegido:{' '}
              <strong>{bt.chosenLabel ?? 'ninguno'}</strong>
              {bt.method && ` — ${bt.method}`}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <caption className="sr-only">Errores fuera de muestra por modelo</caption>
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Modelo
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      MAE diario
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      MASE
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      MAE ÷ ingenuo
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      Error del total
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Sesgo del total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bt.scores.map((s) => (
                    <tr key={s.model} className="border-t border-gray-100 dark:border-gray-900">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        {s.label}
                        {s.model === bt.chosen && ' (elegido)'}
                        {s.model === 'snaive' && ' (referencia)'}
                      </th>
                      <td className="py-1 pr-3 text-right">{dec(s.mae)}</td>
                      <td className="py-1 pr-3 text-right">{dec(s.mase)}</td>
                      <td className="py-1 pr-3 text-right">{dec(s.relMae)}</td>
                      <td className="py-1 pr-3 text-right">{pct(s.wapeTotal)}</td>
                      <td className="py-1 text-right">{pct(s.biasTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {bt.calibration && (
              <p>
                Cobertura empírica del intervalo del 80 % en {bt.calibration.evaluated} orígenes
                calibrados solo con el pasado: diaria {pct(bt.calibration.dailyCoverage)}, del total{' '}
                {pct(bt.calibration.totalCoverage)} (se publica con la diaria entre 70 % y 90 %).{' '}
                Días de evento evaluados: {bt.calibration.eventDays}, cobertura{' '}
                {pct(bt.calibration.eventCoverage)}.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function TotalsTable({ forecast: f }: { forecast: Forecast }) {
  const row = (
    key: string,
    label: string,
    status: string,
    unit: Unit,
    total: { point: number; lower: number; upper: number } | null,
    extra: string,
  ) => (
    <tr key={key} className="border-t border-gray-100 dark:border-gray-900">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
        {label}
      </th>
      <td className="py-1.5 pr-3">
        <StatusTag status={status} />
      </td>
      <td className="py-1.5 pr-3 text-right">
        {total ? fmt(total.point, unit, f.node.currency) : '—'}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right">
        {total
          ? `${fmt(total.lower, unit, f.node.currency)} – ${fmt(total.upper, unit, f.node.currency)}`
          : '—'}
      </td>
      <td className="py-1.5 text-gray-600 dark:text-gray-300">{extra}</td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <caption className="mb-1 text-left font-semibold">
          Totales de los próximos {f.horizonDays} días
        </caption>
        <thead className="text-left text-xs text-gray-500">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Métrica
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Estado
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Central
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Intervalo del 80 %
            </th>
            <th scope="col" className="py-1 font-medium">
              Validación
            </th>
          </tr>
        </thead>
        <tbody>
          {f.metrics.map((m) => {
            const best = m.backtest?.scores.find((s) => s.model === m.backtest?.chosen);
            return row(
              m.id,
              m.label,
              m.status,
              m.unit,
              m.total,
              best ? `${m.backtest?.chosenLabel}: MAE ÷ ingenuo ${dec(best.relMae)}` : '',
            );
          })}
          {f.ratios.map((r) =>
            row(
              r.id,
              r.label,
              r.status,
              'currency',
              r.total,
              r.coverage === null ? '' : `cobertura ${pct(r.coverage)} en ${r.evaluated} orígenes`,
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function CardNotes({ assumptions, limitations }: { assumptions: string[]; limitations: string[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">Supuestos y limitaciones</summary>
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 font-medium">Supuestos</h3>
          <ul className="list-disc space-y-1 pl-5">
            {assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1 font-medium">Limitaciones</h3>
          <ul className="list-disc space-y-1 pl-5">
            {limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

// --- Simulador de escenarios

function ScenarioSimulator({
  accountId,
  currency,
  events,
  builtinCalendar,
}: {
  accountId: string;
  currency: string;
  events: ForecastEvent[];
  builtinCalendar: boolean;
}) {
  const [horizon, setHorizon] = useState(28);
  // Cambios en % por campaña: el borrador y el aplicado (que se convierte en gasto diario al simular).
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [applied, setApplied] = useState<{
    pct: Record<string, number>;
    changes: Array<{ campaignId: string; dailySpend: number }>;
  }>({ pct: {}, changes: [] });
  const body = {
    adAccountId: accountId,
    horizonDays: horizon,
    events,
    builtinCalendar,
    changes: applied.changes,
  };
  const q = useQuery({
    queryKey: ['simulation', body],
    queryFn: () => api<Simulation>('/v1/simulations', { method: 'POST', body }),
    placeholderData: keepPreviousData,
  });
  const sim = q.data;
  const money = (v: number) => formatValue(v, 'currency', currency);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied.pct);
  const apply = (pctById: Record<string, number>) =>
    setApplied({
      pct: pctById,
      changes: (sim?.campaigns ?? [])
        .filter((c) => (pctById[c.id] ?? 0) !== 0)
        .map((c) => ({
          campaignId: c.id,
          dailySpend: Math.max(0, c.currentDailySpend * (1 + (pctById[c.id] as number) / 100)),
        })),
    });

  return (
    <section aria-labelledby="escenarios" className={`${box} space-y-4`} aria-busy={q.isFetching}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="escenarios" className="font-semibold">
            Simulador de escenarios de presupuesto
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Cambia el gasto diario de cada campaña y compara con mantener el actual. Monte Carlo con{' '}
            {sim?.draws.toLocaleString() ?? '10 000'} extracciones de la curva de respuesta de cada
            campaña.
          </p>
        </div>
        <label className="text-sm">
          <span className="mr-2 text-gray-600 dark:text-gray-300">Horizonte</span>
          <select
            className={select}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {SIM_HORIZONS.map((h) => (
              <option key={h} value={h}>
                {h} días
              </option>
            ))}
          </select>
        </label>
      </div>
      <Disclaimer />
      <p className="text-sm text-gray-600 dark:text-gray-300">
        El gasto del plan es una entrada fija. La validación de eventos es semanal y condicionada al
        gasto observado; los totales del escenario son exploratorios, especialmente con campañas
        correlacionadas.
      </p>
      {q.error && <ErrorBox error={q.error} />}
      {!sim ? (
        <p className="text-sm text-gray-500">Calculando el escenario…</p>
      ) : sim.campaigns.length === 0 ? (
        <p className="text-sm">No hay campañas con gasto en los últimos 28 días.</p>
      ) : (
        <form
          className={`space-y-4 transition-opacity ${q.isPlaceholderData ? 'opacity-60' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <caption className="sr-only">Escenario por campaña</caption>
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Campaña
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Gasto diario actual
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Cambio
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Gasto del plan
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Eventos (P10 · P50 · P90)
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Costo por evento
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Cambio esperado
                  </th>
                </tr>
              </thead>
              <tbody>
                {sim.campaigns.map((c) => (
                  <CampaignRow
                    key={c.id}
                    c={c}
                    currency={currency}
                    value={draft[c.id] ?? 0}
                    onChange={(p) => setDraft({ ...draft, [c.id]: p })}
                    max={Math.max(1, ...sim.campaigns.map((x) => x.outcome?.events.p90 ?? 0))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={button} disabled={!dirty || q.isFetching}>
              Simular
            </button>
            {dirty && (
              <span role="status" className="text-sm text-amber-700 dark:text-amber-400">
                Cambios sin simular: los resultados corresponden al último plan calculado.
              </span>
            )}
            <button
              type="button"
              className={button}
              onClick={() => {
                setDraft({});
                apply({});
              }}
            >
              Volver al gasto actual
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              Gasto del plan en {sim.horizonDays} días: <strong>{money(sim.spend.planned)}</strong>{' '}
              (actual: {money(sim.spend.current)}
              {sim.spend.notSimulated > 0 &&
                `; sin curva publicada: ${money(sim.spend.notSimulated)}`}
              )
            </span>
          </div>
          {sim.totals.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <caption className="mb-1 text-left font-semibold">
                  Totales por tipo de evento
                </caption>
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Evento
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      Gasto del plan
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      Eventos P10 – P90 (P50)
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      Costo por evento
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Cambio esperado
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sim.totals.map((t) => (
                    <tr key={t.field} className="border-t border-gray-100 dark:border-gray-900">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {capitalize(t.label)} ({t.campaigns}{' '}
                        {t.campaigns === 1 ? 'campaña' : 'campañas'})
                      </th>
                      <td className="py-1.5 pr-3 text-right">{money(t.spend)}</td>
                      <td className="py-1.5 pr-3 text-right">
                        {fmt(t.events.p10, 'count', null)} – {fmt(t.events.p90, 'count', null)} (
                        <strong>{fmt(t.events.p50, 'count', null)}</strong>)
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right">
                        {costRange(t.cost, currency)}
                      </td>
                      <td className="whitespace-nowrap py-1.5 text-right">
                        {changeRange(t.expectedChange)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <CurvesTable sim={sim} currency={currency} />
          <CardNotes assumptions={sim.assumptions} limitations={sim.limitations} />
          <p className="text-xs text-gray-500">
            {sim.version} · semilla {sim.seed} · incertidumbre de confusión σ ={' '}
            {dec(sim.confounding.sd)} (
            {sim.confounding.source === 'experiments'
              ? `${sim.confounding.experiments} experimentos`
              : 'supuesto, sin evidencia experimental suficiente'}
            ) · huella {sim.inputHash.slice(0, 12)}
          </p>
          <details className="text-xs">
            <summary>Supuestos previos del modelo</summary>
            <pre className="mt-2 overflow-auto">{JSON.stringify(sim.priors, null, 2)}</pre>
          </details>
        </form>
      )}
    </section>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const signed = (v: number) => `${v > 0 ? '+' : ''}${fmt(v, 'count', null)}`;
const changeRange = (q: { p10: number; p50: number; p90: number }) =>
  q.p10 === 0 && q.p90 === 0
    ? 'sin cambio'
    : `${signed(q.p10)} a ${signed(q.p90)} (${signed(q.p50)})`;
const costRange = (
  c: { p10: number | null; p50: number | null; p90: number | null },
  currency: string,
) => {
  const m = (v: number | null) => (v === null ? 'sin cota' : formatValue(v, 'currency', currency));
  return `${m(c.p10)} – ${m(c.p90)}`;
};

function CampaignRow({
  c,
  currency,
  value,
  onChange,
  max,
}: {
  c: SimulationCampaign;
  currency: string;
  value: number;
  onChange: (p: number) => void;
  max: number;
}) {
  const inputId = useId();
  const money = (v: number) => formatValue(v, 'currency', currency);
  const o = c.outcome;
  return (
    <tr className="border-t border-gray-100 align-top dark:border-gray-900">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
        <div>{c.name}</div>
        <div className="text-xs text-gray-500">Evento: {c.kpi.label}</div>
        {c.validatedRange && (
          <div className="text-xs text-gray-600 dark:text-gray-300">
            Rango validado: {money(c.validatedRange.minDaily)} a {money(c.validatedRange.maxDaily)}
            /día.
          </div>
        )}
        {c.status !== 'published' && (
          <div className="mt-1 flex items-start gap-1 text-xs">
            <StatusTag status={c.status} />
            <span className="text-gray-600 dark:text-gray-300">{c.reasons.join(' ')}</span>
          </div>
        )}
        {c.status === 'published' && c.reasons.length > 0 && (
          <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">{c.reasons.join(' ')}</div>
        )}
      </th>
      <td className="py-1.5 pr-3 text-right">{money(c.currentDailySpend)}</td>
      <td className="py-1.5 pr-3">
        <label htmlFor={inputId} className="sr-only">
          Cambio del gasto diario de {c.name}, en %
        </label>
        <span className="inline-flex items-center gap-1">
          <input
            id={inputId}
            type="number"
            min={-100}
            max={300}
            step={5}
            value={value}
            onChange={(e) => onChange(Math.min(300, Math.max(-100, Number(e.target.value) || 0)))}
            className="w-20 rounded border border-gray-300 bg-white px-2 py-0.5 text-right dark:border-gray-700 dark:bg-gray-950"
          />
          %
        </span>
      </td>
      <td className="py-1.5 pr-3 text-right">{money(c.plannedDailySpend)}/día</td>
      <td className="py-1.5 pr-3">
        {o ? (
          <div className="min-w-48">
            <RangeBar q={o.events} max={max} />
            <div className="text-xs">
              {fmt(o.events.p10, 'count', null)} ·{' '}
              <strong>{fmt(o.events.p50, 'count', null)}</strong> ·{' '}
              {fmt(o.events.p90, 'count', null)}
              {(o.extrapolation || o.largeChange) && (
                <span
                  className="ml-1 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
                  title={
                    o.extrapolation
                      ? 'El gasto semanal del plan está fuera del rango observado: la curva no tiene datos ahí.'
                      : 'Cambio de más de ±30 %: en la validación con datos simulados, el intervalo cubrió menos de lo nominal.'
                  }
                >
                  <ToneIcon tone="warning" /> {o.extrapolation ? 'extrapolación' : 'cambio grande'}
                </span>
              )}
            </div>
          </div>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right">
        {o ? costRange(o.cost, currency) : '—'}
        {o && o.probNoEvents > 0 && (
          <div className="text-xs">P(0 eventos): {pct(o.probNoEvents)}</div>
        )}
      </td>
      <td className="whitespace-nowrap py-1.5 text-right">
        {o ? changeRange(o.expectedChange) : '—'}
      </td>
    </tr>
  );
}

/** Barra P10–P90 con una marca en P50, en la escala común de la tabla. */
function RangeBar({ q, max }: { q: { p10: number; p50: number; p90: number }; max: number }) {
  const w = 160;
  const sx = (v: number) => (v / max) * w;
  return (
    <svg aria-hidden="true" width={w} height={10} className="block">
      <rect x={0} y={4} width={w} height={2} fill="var(--viz-grid)" />
      <rect
        x={sx(q.p10)}
        y={2}
        width={Math.max(2, sx(q.p90) - sx(q.p10))}
        height={6}
        rx={2}
        fill="var(--viz-series-wash)"
        stroke="var(--viz-series)"
      />
      <rect x={sx(q.p50) - 1} y={0} width={2} height={10} fill="var(--viz-series)" />
    </svg>
  );
}

function CurvesTable({ sim, currency }: { sim: Simulation; currency: string }) {
  const fitted = sim.campaigns.filter((c) => c.curve);
  if (!fitted.length) return null;
  const money = (v: number) => formatValue(v, 'currency', currency);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">Curvas de respuesta y su validación</summary>
      <p className="mt-2 text-gray-600 dark:text-gray-300">
        La curva ajusta gasto, curvatura, tendencia, eventos externos y gasto de otras campañas. La
        elasticidad local describe una asociación. Sin un experimento válido, el cambio simulado
        incluye un supuesto sobre confusión; no identifica un efecto causal.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full tabular-nums">
          <caption className="sr-only">Curvas de respuesta por campaña</caption>
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Campaña
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Semanas · eventos
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Elasticidad b (80 %)
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Aprendido de los datos
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Gasto semanal observado
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Validación de un paso
              </th>
            </tr>
          </thead>
          <tbody>
            {fitted.map((c) => {
              const k = c.curve as NonNullable<SimulationCampaign['curve']>;
              return (
                <tr key={c.id} className="border-t border-gray-100 dark:border-gray-900">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {c.name}
                    <div className="text-xs text-gray-500">
                      Extremos: {c.validation?.extremes.evaluated ?? 0} semanas, cobertura{' '}
                      {pct(c.validation?.extremes.coverage)}.
                    </div>
                  </th>
                  <td className="py-1 pr-3 text-right">
                    {k.weeks} · {fmt(k.events, 'count', null)}
                  </td>
                  <td className="py-1 pr-3 text-right">
                    {dec(k.elasticity.point)} ({dec(k.elasticity.lower)} a {dec(k.elasticity.upper)}
                    )
                    <div className="text-xs text-gray-500">
                      Escenario: {dec(k.causal.point)} ({dec(k.causal.lower)} a{' '}
                      {dec(k.causal.upper)}),{' '}
                      {k.causal.source === 'experiment'
                        ? 'experimento, condicionado a sus supuestos'
                        : 'observación + confusión supuesta'}
                    </div>
                  </td>
                  <td className="py-1 pr-3 text-right">{pct(k.learned)}</td>
                  <td className="py-1 pr-3 text-right">
                    {money(k.spendRange[0])} – {money(k.spendRange[1])}
                  </td>
                  <td className="py-1 text-right">
                    {c.validation
                      ? `${c.validation.oneStep.evaluated} semanas · cobertura ${pct(c.validation.oneStep.coverage)} · MAE ÷ costo constante ${dec(c.validation.oneStep.relMae)}`
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

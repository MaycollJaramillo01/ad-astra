import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { METRICS, type MetricId, type MetricValue } from '../../src/modules/insights/catalog.ts';
import { formatDay, formatDayLong, formatMetric, formatRange } from './format.ts';

// Tendencia diaria de una métrica: periodo actual (color de serie) frente al de comparación (gris,
// de contexto). Un solo eje; los huecos son días sin dato (no se inventan ceros). Cruceta y
// tooltip con puntero o teclado, y una vista de tabla con los mismos valores.

export interface ChartPoint {
  date: string;
  previousDate: string | null;
  current: MetricValue;
  previous: MetricValue | null;
  immature: boolean;
}

const H = 220;
const M = { top: 16, right: 64, bottom: 28, left: 64 };

function niceStep(max: number, ticks = 4): number {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(
      ([entry]) => entry && setWidth(Math.max(280, entry.contentRect.width)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Trazo con cortes donde falta el dato. */
function linePath(
  values: Array<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function TrendChart({
  metric,
  points,
  currency,
  range,
  compareRange,
}: {
  metric: MetricId;
  points: ChartPoint[];
  currency: string | null;
  range: { since: string; until: string };
  compareRange: { since: string; until: string } | null;
}) {
  const { ref, width } = useWidth<HTMLElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const def = METRICS[metric];
  const cur = points.map((p) => p.current.value);
  const prev = points.map((p) => p.previous?.value ?? null);
  const all = [...cur, ...prev].filter((v): v is number => v !== null);
  const fmt = (v: number, compact = false) => formatMetric(metric, v, currency, compact);

  if (all.length === 0) {
    const reason = points.find((p) => p.current.reason)?.current.reason;
    return (
      <p className="py-10 text-center text-sm text-gray-500">
        No hay datos de {def.label.toLowerCase()} en este periodo{reason ? ` (${reason})` : ''}.
      </p>
    );
  }

  const step = niceStep(Math.max(...all) || 1);
  const top = step * Math.ceil((Math.max(...all) || 1) / step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = width - M.left - M.right;
  const n = points.length;
  const x = (i: number) => M.left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => M.top + H - (v / top) * H;
  const firstImmature = points.findIndex((p) => p.immature);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));

  // Etiquetas directas al final de cada línea, solo si no se pisan.
  const lastIdx = (vals: Array<number | null>) =>
    vals.reduce<number>((acc, v, i) => (v === null ? acc : i), -1);
  const endCur = lastIdx(cur);
  const endPrev = compareRange ? lastIdx(prev) : -1;
  const endCurY = endCur >= 0 ? y(cur[endCur] as number) : null;
  const endPrevY = endPrev >= 0 ? y(prev[endPrev] as number) : null;
  const directLabels =
    endCurY !== null && endPrevY !== null ? Math.abs(endCurY - endPrevY) > 14 : endCurY !== null;

  const pick = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    const i = n === 1 ? 0 : Math.round(((px - M.left) / plotW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in keys) {
      e.preventDefault();
      setHover((h) =>
        Math.min(n - 1, Math.max(0, (h ?? (keys[e.key] === 1 ? -1 : n)) + (keys[e.key] ?? 0))),
      );
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHover(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape') setHover(null);
  };

  const peak = cur.reduce<number>(
    (best, v, i) => (v !== null && v > (cur[best] ?? -Infinity) ? i : best),
    0,
  );
  const summary = `${def.label} por día, ${formatRange(range.since, range.until)}. Máximo ${fmt(cur[peak] ?? 0)} el ${formatDay(points[peak]?.date ?? range.since)}.${compareRange ? ` En gris, el periodo ${formatRange(compareRange.since, compareRange.until)}.` : ''} Usa las flechas para recorrer los días.`;
  const h = hover !== null ? points[hover] : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        {compareRange && (
          <>
            <LegendKey
              color="var(--viz-series)"
              label={`Actual · ${formatRange(range.since, range.until)}`}
            />
            <LegendKey
              color="var(--viz-compare)"
              label={`Anterior · ${formatRange(compareRange.since, compareRange.until)}`}
            />
          </>
        )}
        {firstImmature >= 0 && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm"
              style={{
                background: 'var(--viz-immature)',
                outline: '1px solid var(--status-warning)',
              }}
            />
            En maduración: las conversiones aún pueden subir
          </span>
        )}
        <button
          type="button"
          className="ml-auto rounded px-2 py-1 underline-offset-2 hover:underline focus-visible:outline-2"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? 'Ver gráfico' : 'Ver como tabla'}
        </button>
      </div>

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
                  {def.label}
                </th>
                {compareRange && (
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Día anterior
                  </th>
                )}
                {compareRange && (
                  <th scope="col" className="py-1 text-right font-medium">
                    Anterior
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date} className="border-t border-gray-100 dark:border-gray-900">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {formatDayLong(p.date)}
                    {p.current.state === 'immature' && (
                      <span className="ml-1 text-xs text-gray-500">(en maduración)</span>
                    )}
                  </th>
                  <td className="py-1 pr-3 text-right">
                    {p.current.value === null ? (
                      <NotAvailable reason={p.current.reason} />
                    ) : (
                      fmt(p.current.value)
                    )}
                  </td>
                  {compareRange && (
                    <td className="py-1 pr-3">
                      {p.previousDate ? formatDay(p.previousDate, true) : ''}
                    </td>
                  )}
                  {compareRange && (
                    <td className="py-1 text-right">
                      {p.previous?.value === null || p.previous === null ? (
                        <NotAvailable reason={p.previous?.reason} />
                      ) : (
                        fmt(p.previous.value)
                      )}
                    </td>
                  )}
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
            height={H + M.top + M.bottom}
            viewBox={`0 0 ${width} ${H + M.top + M.bottom}`}
            aria-hidden="true"
            className="block touch-pan-y select-none"
            onPointerMove={(e: PointerEvent<SVGSVGElement>) => pick(e.clientX, e.currentTarget)}
            onPointerDown={(e: PointerEvent<SVGSVGElement>) => pick(e.clientX, e.currentTarget)}
            onPointerLeave={() => setHover(null)}
          >
            {firstImmature >= 0 && (
              <rect
                x={x(firstImmature) - (n > 1 ? plotW / (n - 1) / 2 : 0)}
                y={M.top}
                width={
                  M.left + plotW - x(firstImmature) + (n > 1 ? plotW / (n - 1) / 2 : plotW / 2)
                }
                height={H}
                fill="var(--viz-immature)"
              />
            )}
            {ticks.map((tk) => (
              <g key={tk}>
                <line
                  x1={M.left}
                  x2={M.left + plotW}
                  y1={y(tk)}
                  y2={y(tk)}
                  stroke={tk === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                  strokeWidth={1}
                />
                <text
                  x={M.left - 8}
                  y={y(tk)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill="var(--viz-ink-muted)"
                  className="tabular-nums"
                >
                  {fmt(tk, true)}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 || (i === n - 1 && (n - 1) % labelEvery >= labelEvery / 2) ? (
                <text
                  key={p.date}
                  x={x(i)}
                  y={M.top + H + 18}
                  textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}
                  fontSize={11}
                  fill="var(--viz-ink-muted)"
                >
                  {formatDay(p.date)}
                </text>
              ) : null,
            )}
            {compareRange && (
              <path
                d={linePath(prev, x, y)}
                fill="none"
                stroke="var(--viz-compare)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            <path
              d={`${linePath(cur, x, y)}`}
              fill="none"
              stroke="var(--viz-series)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {n === 1 && cur[0] !== null && (
              <circle
                cx={x(0)}
                cy={y(cur[0] as number)}
                r={4}
                fill="var(--viz-series)"
                stroke="var(--viz-surface)"
                strokeWidth={2}
              />
            )}
            {directLabels && endCurY !== null && (
              <text x={x(endCur) + 8} y={endCurY} dy="0.32em" fontSize={11} fill="currentColor">
                Actual
              </text>
            )}
            {directLabels && endPrevY !== null && (
              <text
                x={x(endPrev) + 8}
                y={endPrevY}
                dy="0.32em"
                fontSize={11}
                fill="var(--viz-ink-muted)"
              >
                Anterior
              </text>
            )}
            {hover !== null && (
              <g>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={M.top}
                  y2={M.top + H}
                  stroke="var(--viz-axis)"
                  strokeWidth={1}
                />
                {compareRange && prev[hover] !== null && (
                  <circle
                    cx={x(hover)}
                    cy={y(prev[hover] as number)}
                    r={4}
                    fill="var(--viz-compare)"
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                )}
                {cur[hover] !== null && (
                  <circle
                    cx={x(hover)}
                    cy={y(cur[hover] as number)}
                    r={4}
                    fill="var(--viz-series)"
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                )}
              </g>
            )}
          </svg>
          {h && hover !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-md border border-black/10 bg-white px-3 py-2 text-xs shadow-md dark:border-white/10 dark:bg-gray-900"
              style={{
                left: Math.min(Math.max(0, x(hover) + 12), width - 190),
              }}
            >
              <div className="mb-1 text-gray-500">{formatDayLong(h.date)}</div>
              <TooltipRow
                color="var(--viz-series)"
                value={h.current.value === null ? 'No disponible' : fmt(h.current.value)}
                note={
                  h.current.value === null
                    ? h.current.reason
                    : h.current.state === 'immature'
                      ? 'en maduración'
                      : undefined
                }
              />
              {compareRange && h.previousDate && (
                <TooltipRow
                  color="var(--viz-compare)"
                  value={
                    h.previous?.value === null || !h.previous
                      ? 'No disponible'
                      : fmt(h.previous.value)
                  }
                  note={formatDay(h.previousDate, true)}
                />
              )}
            </div>
          )}
        </figure>
      )}
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-0.5 w-4 rounded"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function TooltipRow({ color, value, note }: { color: string; value: string; note?: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        aria-hidden="true"
        className="inline-block h-0.5 w-3 rounded"
        style={{ background: color }}
      />
      <strong className="font-semibold">{value}</strong>
      {note && <span className="text-gray-500">{note}</span>}
    </div>
  );
}

export function NotAvailable({ reason }: { reason?: string }) {
  return (
    <span title={reason ? `No disponible: ${reason}` : 'No disponible'} className="text-gray-400">
      n/d<span className="sr-only"> (No disponible{reason ? `: ${reason}` : ''})</span>
    </span>
  );
}

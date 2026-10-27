import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AnalyticsExportQuery, AnalyticsQuery, AnalyticsReportDto } from '../../contracts.ts';
import { type Db, withContext } from '../../db/client.ts';
import { userEvent } from '../../platform/events.ts';
import { tenantOf } from '../../platform/http.ts';
import { ReadCache } from '../../platform/read-cache.ts';
import {
  accountStatus,
  change,
  compute,
  DEFAULT_COLUMNS,
  deliveryStatus,
  isMetricId,
  METRICS,
  type MetricContext,
  type MetricId,
  sumTotals,
  type Totals,
} from './catalog.ts';
import { buildReport, type Report } from './report.ts';

// Analítica (F2): un informe por vista y su exportación a CSV.

const CLIENT_STATUS: Record<string, string> = {
  active: 'Activo',
  paused: 'En pausa',
  offboarded: 'Baja',
};

function statusLabel(row: {
  statusKind: string;
  status: string | null;
  deleted: boolean;
  learning: string | null;
}) {
  if (row.statusKind === 'account')
    return accountStatus(row.status ? Number(row.status) : null).label;
  if (row.statusKind === 'client')
    return row.status ? (CLIENT_STATUS[row.status] ?? row.status) : '';
  return deliveryStatus(row.status, { deleted: row.deleted, learning: row.learning }).label;
}

/** Celda CSV segura: comillas cuando hace falta y sin fórmulas (los nombres vienen de Meta). */
export function csvCell(value: string): string {
  // Un número negativo empieza por "-" pero no es una fórmula: se deja tal cual.
  const formula = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value);
  const safe = formula ? `'${value}` : value;
  return /[",\r\n;]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const number = (v: number | null, percent: boolean) =>
  v === null ? '' : String(Number((percent ? v * 100 : v).toFixed(4)));

export function reportToCsv(report: Report, columns: MetricId[]): { csv: string; rows: number } {
  const compare = report.compare !== null;
  const immature = (until: string) => until >= report.freshness.immatureFrom;
  const ctxFor = (sources: number, resultTypes: number, until: string): MetricContext => ({
    days: report.range.days,
    reachSources: sources,
    resultTypes,
    immature: immature(until),
  });

  const lines: string[][] = [];
  const header = ['Nombre', 'ID', 'Estado', 'Moneda'];
  for (const id of columns) {
    const label = `${METRICS[id].label}${METRICS[id].unit === 'percent' ? ' (%)' : ''}`;
    header.push(label, ...(compare ? [`${label} (anterior)`, `${label} (variación %)`] : []));
  }
  lines.push(header);

  type Line = {
    name: string;
    id: string;
    status: string;
    current: Totals;
    previous: Totals | null;
    sources: number;
    resultTypes: number;
    previousResultTypes: number;
    days: number;
  };
  const source: Line[] = report.children
    ? report.children.rows.map((r) => ({
        name: r.name,
        id: r.id,
        status: statusLabel(r),
        current: r.current,
        previous: r.previous,
        sources: r.sources,
        resultTypes: r.resultTypes.length,
        previousResultTypes: r.previousResultTypes.length,
        days: report.range.days,
      }))
    : report.series.map((s) => ({
        name: s.date,
        id: s.date,
        status: '',
        current: s.current,
        previous: s.previous,
        sources: 1,
        resultTypes: report.totals.resultTypes.length,
        previousResultTypes: report.totals.previousResultTypes.length,
        days: 1,
      }));
  const total: Line = {
    name: 'Total',
    id: '',
    status: '',
    current: sumTotals(source.map((l) => l.current)),
    previous: compare ? sumTotals(source.map((l) => l.previous ?? sumTotals([]))) : null,
    sources: Math.max(1, source.length),
    resultTypes: report.totals.resultTypes.length,
    previousResultTypes: report.totals.previousResultTypes.length,
    days: report.range.days,
  };

  for (const l of [...source, total]) {
    const cells = [l.name, l.id, l.status, report.currency ?? ''];
    for (const id of columns) {
      const percent = METRICS[id].unit === 'percent';
      const ctx = { ...ctxFor(l.sources, l.resultTypes, report.range.until), days: l.days };
      const cur = compute(id, l.current, ctx).value;
      cells.push(number(cur, percent));
      if (report.compare) {
        const prev = l.previous
          ? compute(id, l.previous, {
              ...ctx,
              resultTypes: l.previousResultTypes,
              immature: immature(report.compare.until),
            }).value
          : null;
        const delta = change(cur, prev);
        cells.push(
          number(prev, percent),
          delta === null ? '' : String(Number((delta * 100).toFixed(2))),
        );
      }
    }
    lines.push(cells);
  }
  // BOM: Excel abre el UTF-8 con acentos sin preguntar.
  return {
    csv: `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`,
    rows: source.length,
  };
}

export async function insightsRoutes(
  fastify: FastifyInstance,
  { db, cacheMs = 0 }: { db: Db; cacheMs?: number },
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const cache = new ReadCache(cacheMs);

  app.get(
    '/v1/analytics',
    {
      config: { access: { permission: 'insights:read' } },
      schema: { querystring: AnalyticsQuery, response: { 200: AnalyticsReportDto } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      return withContext(db, ctx, (tx) => buildReport(tx, ctx, request.query, undefined, cache));
    },
  );

  app.get(
    '/v1/analytics/export.csv',
    {
      config: { access: { permission: 'insights:read' } },
      schema: { querystring: AnalyticsExportQuery },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const { columns: list, ...query } = request.query;
      const columns = (list?.split(',').filter(isMetricId) ?? []).slice(0, 40);
      const chosen = columns.length ? columns : DEFAULT_COLUMNS;
      const { csv, report } = await withContext(db, ctx, async (tx) => {
        const report = await buildReport(tx, ctx, query);
        const out = reportToCsv(report, chosen);
        await userEvent(tx, request, {
          action: 'analytics.exported',
          targetType: report.node.level,
          targetId: report.node.id ?? 'org',
          after: {
            since: report.range.since,
            until: report.range.until,
            compare: report.compare?.mode ?? 'none',
            currency: report.currency,
            columns: chosen,
            rows: out.rows,
          },
        });
        return { csv: out.csv, report };
      });
      const filename = `ad-astra-${report.node.level}-${report.range.since}_${report.range.until}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(csv);
    },
  );
}

import { METRICS, type MetricId, type Unit } from '../../src/modules/insights/catalog.ts';

// Formato de cifras y fechas con el idioma del navegador. Los días de los informes son locales de
// la cuenta ('YYYY-MM-DD'): se formatean en UTC para no desplazarlos un día.

const LOCALE = typeof navigator === 'undefined' ? 'es' : navigator.language || 'es';
const cache = new Map<string, Intl.NumberFormat>();
const nf = (key: string, opts: Intl.NumberFormatOptions) => {
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, opts);
    cache.set(key, f);
  }
  return f;
};

export function formatValue(
  value: number,
  unit: Unit,
  currency: string | null,
  compact = false,
): string {
  const c = compact ? { notation: 'compact' as const, maximumFractionDigits: 1 } : {};
  switch (unit) {
    case 'currency':
      return currency
        ? nf(`cur${currency}${compact}`, {
            style: 'currency',
            currency,
            maximumFractionDigits: 2,
            ...c,
          }).format(value)
        : nf(`num${compact}`, { maximumFractionDigits: 2, ...c }).format(value);
    case 'percent':
      return nf('pct', {
        style: 'percent',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    case 'decimal':
      return nf('dec', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    case 'count':
      return nf(`cnt${compact}`, { maximumFractionDigits: compact ? 1 : 2, ...c }).format(value);
  }
}

export const formatMetric = (
  id: MetricId,
  value: number,
  currency: string | null,
  compact = false,
) => formatValue(value, METRICS[id].unit, currency, compact);

export const formatDelta = (d: number) =>
  nf('delta', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(d);

const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayYearFmt = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const dayLongFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const at = (day: string) => new Date(`${day}T00:00:00Z`);

export const formatDay = (day: string, withYear = false) =>
  (withYear ? dayYearFmt : dayFmt).format(at(day));
export const formatDayLong = (day: string) => dayLongFmt.format(at(day));
export const formatRange = (since: string, until: string) =>
  since === until
    ? formatDay(since, true)
    : `${formatDay(since, since.slice(0, 4) !== until.slice(0, 4))} – ${formatDay(until, true)}`;

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
/** "hace 25 minutos", "hace 3 horas". */
export function formatAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

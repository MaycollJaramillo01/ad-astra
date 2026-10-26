import { describe, expect, it } from 'vitest';
import { synthetic, UNTIL } from '../../../test/forecast-fixtures.ts';
import { addDays } from '../insights/catalog.ts';
import { calendarEvents, easter, eventLookup } from './calendar.ts';
import {
  CRITERIA,
  coverageOk,
  type DailyRow,
  errorInterval,
  estimateEffects,
  etsForecast,
  forecastRatio,
  forecastSeries,
  type Horizon,
  prepareHistory,
  requiredDays,
  seasonalNaive,
  seriesAt,
  seriesOf,
  weekdayProfile,
} from './forecast.ts';

const H: Horizon = { horizon: 28, gap: 3 };
const row = (date: string, spend: number, attribution = '7d_click_1d_view'): DailyRow => ({
  date,
  attribution,
  values: { spend, leads: spend / 10 },
});
const daysBack = (n: number, fn: (t: number) => number, attribution?: (t: number) => string) =>
  Array.from({ length: n }, (_, t) => row(addDays(UNTIL, t - n + 1), fn(t), attribution?.(t)));

describe('modelos', () => {
  const week = [10, 20, 30, 40, 50, 60, 70];
  const seasonal = Array.from({ length: 70 }, (_, t) => week[t % 7] as number);

  it('el ingenuo estacional repite la última semana y salta los días sin dato', () => {
    expect(seasonalNaive(seasonal, 9)).toEqual([10, 20, 30, 40, 50, 60, 70, 10, 20]);
    const withGap = [...seasonal];
    withGap[63] = Number.NaN; // el lunes de la última semana, excluido
    expect(seasonalNaive(withGap, 1)).toEqual([10]); // usa el de la semana anterior
  });

  it('el perfil semanal y ETS reproducen una serie estacional sin ruido', () => {
    expect(weekdayProfile(seasonal, 7).map((x) => Math.round(x))).toEqual(week);
    const trend = Array.from({ length: 120 }, (_, t) => 100 + 2 * t + (week[t % 7] as number));
    const next = Array.from(
      { length: 14 },
      (_, i) => 100 + 2 * (120 + i) + (week[(120 + i) % 7] as number),
    );
    // Tendencia amortiguada (φ ≤ 0,98): a 14 días se queda un poco corta, pero la sigue.
    const ets = etsForecast(trend, 14);
    const flat = weekdayProfile(trend, 14);
    ets.forEach((p, i) => {
      const err = Math.abs(p - (next[i] as number)) / (next[i] as number);
      expect(err).toBeLessThan(0.02);
      expect(err).toBeLessThan(
        Math.abs((flat[i] as number) - (next[i] as number)) / (next[i] as number),
      );
    });
  });

  it('el intervalo empírico corrige por muestra finita (cubre más con pocos errores)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => i);
    const [lo, hi] = errorInterval(ten);
    expect(lo).toBeLessThan(0.9); // cuantil 10 % sin corregir: 0,9
    expect(hi).toBeGreaterThan(8.1);
    const many = Array.from({ length: 1001 }, (_, i) => i / 1000);
    expect(errorInterval(many)[1]).toBeCloseTo(0.9, 2);
  });
});

describe('historia utilizable', () => {
  it('empieza tras el último cambio de atribución', () => {
    const h = prepareHistory(
      daysBack(
        100,
        () => 50,
        (t) => (t < 60 ? '7d_click_1d_view' : '7d_click'),
      ),
      UNTIL,
    );
    expect(h.dates.length).toBe(40);
    expect(h.breaks).toEqual([{ date: addDays(UNTIL, -39), reason: 'attribution' }]);
  });

  it('una pausa de 7 días o más corta la historia; al final, la entidad está en pausa', () => {
    const paused = daysBack(100, (t) => (t >= 30 && t < 40 ? 0 : 50)).filter((r) => r.values.spend);
    const h = prepareHistory(paused, UNTIL);
    expect(h.dates.length).toBe(60);
    expect(h.breaks[0]?.reason).toBe('pause');
    const ended = prepareHistory(
      daysBack(100, (t) => (t < 90 ? 50 : 0)),
      UNTIL,
    );
    expect(ended.pausedAtEnd).toBe(true);
    // Un hueco corto (3 días sin entrega) no corta: cuenta como 0.
    const short = prepareHistory(
      daysBack(100, (t) => (t >= 30 && t < 33 ? 0 : 50)),
      UNTIL,
    );
    expect(short.dates.length).toBe(100);
  });

  it('las incidencias no se ajustan; un pico aislado se acota y un cambio sostenido no', () => {
    const rows = daysBack(100, (t) => (t === 70 ? 500 : t >= 90 ? 150 : 50 + (t % 3)));
    const incident = {
      since: addDays(UNTIL, -5),
      until: addDays(UNTIL, -4),
      label: 'Caída del píxel',
      category: 'incident' as const,
    };
    const h = prepareHistory(
      rows,
      UNTIL,
      calendarEvents(addDays(UNTIL, -99), UNTIL, [incident], false),
    );
    const s = seriesOf(h, 'spend');
    expect(s.anomalies).toEqual([70]);
    expect(s.train[70]).toBeLessThan(100);
    expect(s.actual[70]).toBe(500); // se puntúa con el valor real
    expect(s.train[92]).toBe(150); // el nuevo nivel se respeta
    expect(Number.isNaN(s.train[94] as number)).toBe(true);
    expect(Number.isNaN(s.actual[95] as number)).toBe(true);
  });
});

describe('festivos, fechas comerciales y días de pago', () => {
  const events = calendarEvents(addDays(UNTIL, -400), addDays(UNTIL, 60));
  const at = eventLookup(events);
  // Días de pago con un 50 % más de leads; el resto del calendario no tiene efecto real.
  const rows = synthetic({
    days: 300,
    seed: 4,
    spend: () => 300,
    leads: { k: 0.2, b: 0.8 },
    effect: (d) => (at(d)?.category === 'payday' ? 1.5 : 1),
  });
  const h = prepareHistory(rows, UNTIL, events);

  it('calcula el calendario incorporado y da prioridad a los festivos', () => {
    expect(easter(2026)).toBe('2026-04-05');
    expect(easter(2027)).toBe('2027-03-28');
    const nov = calendarEvents('2026-11-01', '2026-12-31');
    expect(nov.find((e) => e.key === 'black-friday')).toMatchObject({
      since: '2026-11-27',
      until: '2026-11-29',
    });
    expect(nov.find((e) => e.key === 'cyber-monday')?.since).toBe('2026-11-30');
    const winter = eventLookup(calendarEvents('2025-12-01', '2026-02-28'));
    expect(winter('2026-01-01')?.key).toBe('fin-de-ano'); // también es día de pago: gana el festivo
    expect(winter('2026-01-15')?.key).toBe('quincena');
    expect(winter('2026-01-20')).toBeNull();
    const own = calendarEvents(
      '2025-01-01',
      '2026-12-31',
      [
        {
          since: '2025-10-01',
          until: '2025-10-03',
          label: 'Feriado morazánico',
          category: 'holiday',
          yearly: true,
        },
      ],
      false,
    );
    expect(own.map((e) => e.since)).toEqual(['2025-10-01', '2026-10-01']);
    expect(own[0]?.key).toBe('user:holiday:feriado-morazanico');
  });

  it('estima el efecto de los días de pago y deja amplio el de un evento sin historia', () => {
    const s = seriesOf(h, 'leads');
    const effects = estimateEffects(s, s.train.length);
    const payday = effects(events.find((e) => e.key === 'quincena')!);
    expect(payday.occurrences).toBeGreaterThan(15);
    expect(Math.abs(payday.mean - Math.log(1.5))).toBeLessThan(0.1);
    // Black Friday de 2025 cae fuera de los 300 días: solo el a priori de su categoría.
    const blackFriday = effects(events.find((e) => e.key === 'black-friday')!);
    expect(blackFriday.occurrences).toBe(0);
    expect(blackFriday.sd).toBeGreaterThan(0.3);
  });

  it('pronostica los días de pago con su efecto y su incertidumbre', () => {
    const f = forecastSeries(h, seriesOf(h, 'leads'), H, { count: true });
    expect(f.status).toBe('published');
    const points = f.points ?? [];
    const paid = points.filter((p) => p.event === 'Días de pago (quincena)');
    const normal = points.filter((p) => p.event === null);
    expect(paid.length).toBeGreaterThan(1);
    const mean = (xs: typeof points) => xs.reduce((s, p) => s + p.point, 0) / xs.length;
    expect(mean(paid) / mean(normal)).toBeGreaterThan(1.3);
    const width = (xs: typeof points) =>
      xs.reduce((s, p) => s + (p.upper - p.lower) / p.point, 0) / xs.length;
    expect(width(paid)).toBeGreaterThan(width(normal));
    expect(f.backtest?.calibration?.eventDays).toBeGreaterThan(0);
    expect(f.events.find((e) => e.key === 'quincena')?.occurrences).toBeGreaterThan(15);
  });
});

describe('backtest, calibración y publicación', () => {
  const stable = (seed: number, days = 240) =>
    synthetic({ days, seed, spend: () => 300, leads: { k: 0.2, b: 0.8 } });

  it('recalcula los picos dentro del corte sin confirmar con datos del holdout', () => {
    const actual = Array.from({ length: 110 }, (_, t) => (t === 79 ? 500 : 50 + (t % 3)));
    const s = { actual, event: actual.map(() => null) };
    expect(seriesAt(s, 110).anomalies).toContain(79);
    expect(seriesAt(s, 80).anomalies).not.toContain(79);
    const changed = { ...s, actual: actual.map((x, i) => (i < 80 ? x : 10000)) };
    expect(seriesAt(changed, 80)).toEqual(seriesAt(s, 80));
  });

  it('elige con orígenes anteriores y compara contra el baseline en el periodo posterior', () => {
    const h = prepareHistory(stable(3), UNTIL);
    const bt = forecastSeries(h, seriesOf(h, 'spend'), H, { count: false }).backtest!;
    expect(bt.selectionOrigins).toBe(6);
    expect(bt.evaluationOrigins).toBeGreaterThanOrEqual(6);
    const best = bt.selectionScores
      .filter((s) => s.model !== 'snaive')
      .sort((a, b) => (a.relMae ?? Infinity) - (b.relMae ?? Infinity))[0];
    expect(bt.chosen).toBe(best?.model);
  });

  it('con pocas evaluaciones tolera un error típico binomial alrededor de [70 %, 90 %]', () => {
    expect(coverageOk(17 / 18, 18)).toBe(true);
    expect(coverageOk(11 / 18, 18)).toBe(true);
    expect(coverageOk(18 / 18, 18)).toBe(false);
    expect(coverageOk(10 / 18, 18)).toBe(false);
    expect(coverageOk(0.68, 2000)).toBe(false); // con muchos puntos, casi el rango literal
    expect(coverageOk(0.7, 2000)).toBe(true);
  });

  it('exige historia suficiente y dice cuánta falta', () => {
    expect(requiredDays(H)).toBe(199);
    const h = prepareHistory(stable(1, 120), UNTIL);
    const f = forecastSeries(h, seriesOf(h, 'spend'), H, { count: false });
    expect(f.status).toBe('insufficient_data');
    expect(f.reasons[0]).toContain('Faltan 79');
    expect(f.points).toBeNull();
  });

  it('publica cuando supera al ingenuo estacional y el intervalo está calibrado (CA-F6-01, 02)', () => {
    const h = prepareHistory(stable(3), UNTIL);
    const f = forecastSeries(h, seriesOf(h, 'spend'), H, { count: false });
    expect(f.status).toBe('published');
    const chosen = f.backtest?.scores.find((s) => s.model === f.backtest?.chosen);
    expect(chosen?.relMae).toBeLessThan(1);
    const cov = f.backtest?.calibration?.dailyCoverage as number;
    expect(cov).toBeGreaterThanOrEqual(CRITERIA.coverage[0]);
    expect(cov).toBeLessThanOrEqual(CRITERIA.coverage[1]);
    expect(f.points).toHaveLength(28);
    for (const p of f.points ?? []) expect(p.lower <= p.point && p.point <= p.upper).toBe(true);
    // El total ronda 28 días × 300 (la semana suma 7 × 1,0 de media).
    expect(f.total?.point).toBeGreaterThan(28 * 300 * 0.85);
    expect(f.total?.point).toBeLessThan(28 * 300 * 1.15);
  });

  it('en promedio la cobertura del 80 % está calibrada en datos sintéticos', () => {
    const coverage: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const h = prepareHistory(stable(seed * 31), UNTIL);
      for (const field of ['spend', 'leads']) {
        const f = forecastSeries(h, seriesOf(h, field), H, { count: field === 'leads' });
        const c = f.backtest?.calibration?.dailyCoverage;
        if (c !== null && c !== undefined) coverage.push(c);
      }
    }
    const mean = coverage.reduce((a, b) => a + b, 0) / coverage.length;
    expect(mean).toBeGreaterThan(0.74);
    expect(mean).toBeLessThan(0.86);
  });

  it('no mira el futuro: filas posteriores al corte no cambian el resultado', () => {
    const rows = stable(5, 260);
    const cut = addDays(UNTIL, -20);
    const a = forecastSeries(
      prepareHistory(rows, cut),
      seriesOf(prepareHistory(rows, cut), 'spend'),
      H,
      {
        count: false,
      },
    );
    const past = rows.filter((r) => r.date <= cut);
    const b = forecastSeries(
      prepareHistory(past, cut),
      seriesOf(prepareHistory(past, cut), 'spend'),
      H,
      {
        count: false,
      },
    );
    expect(a).toEqual(b);
  });

  it('una serie escasa no se pronostica a diario', () => {
    const rows = synthetic({ days: 240, seed: 2, spend: () => 300, leads: { k: 0.002, b: 0.8 } });
    const h = prepareHistory(rows, UNTIL);
    const f = forecastSeries(h, seriesOf(h, 'leads'), H, { count: true });
    expect(f.status).toBe('insufficient_data');
    expect(f.reasons[0]).toContain('Volumen bajo');
  });

  it('no confunde muchos días excluidos con historia suficiente', () => {
    const h = prepareHistory(stable(2), UNTIL);
    h.excluded = h.dates.map((_, i) => i >= h.dates.length - 40);
    const f = forecastSeries(h, seriesOf(h, 'spend'), H, { count: false });
    expect(f.status).toBe('insufficient_data');
    expect(f.reasons.join(' ')).toContain('Pocos días normales');
    expect(f.points).toBeNull();
  });

  it('el costo por evento solo se publica con sus dos series publicadas', () => {
    const h = prepareHistory(stable(8), UNTIL);
    const spend = forecastSeries(h, seriesOf(h, 'spend'), H, { count: false });
    const leads = forecastSeries(h, seriesOf(h, 'leads'), H, { count: true });
    const cpl = forecastRatio(spend, leads, H);
    if (spend.status === 'published' && leads.status === 'published' && cpl.total) {
      expect(cpl.total.lower).toBeLessThanOrEqual(cpl.total.point);
      expect(cpl.total.upper).toBeGreaterThanOrEqual(cpl.total.point);
    }
    const short = prepareHistory(stable(8, 100), UNTIL);
    const none = forecastSeries(short, seriesOf(short, 'leads'), H, { count: true });
    expect(forecastRatio(spend, none, H).status).toBe('insufficient_data');
  });
});

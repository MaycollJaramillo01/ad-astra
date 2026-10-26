import { existsSync, readFileSync } from 'node:fs';
import {
  CRITERIA,
  coverageOk,
  type DailyRow,
  forecastRatio,
  forecastSeries,
  type Horizon,
  prepareHistory,
  requiredDays,
  seriesOf,
} from '../src/modules/forecasting/forecast.ts';
import {
  fitResponse,
  mulberry32,
  normal,
  poissonSample,
  RESPONSE,
  simulatePlans,
  validateResponse,
  type Week,
} from '../src/modules/forecasting/simulate.ts';
import { addDays } from '../src/modules/insights/catalog.ts';
import { synthetic, UNTIL, WEEKLY } from '../test/forecast-fixtures.ts';

// Experimentos de la capa de pronóstico y simulación (docs/FORECASTING.md §7). Deterministas
// (semillas fijas). Uso: pnpm forecast:experiments [--real ruta.csv]
// Con datos reales solo imprime conteos y estados, nunca valores de la cuenta.

const H: Horizon = { horizon: 28, gap: 3 };
const R = Number(process.env.REPS ?? 40);
const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? 'n/d' : x.toFixed(d);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : Number.NaN);
const medianOf = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : Number.NaN;
};

// --- E1. Pronóstico: habilidad, calibración en el backtest y cobertura real en un horizonte oculto

const SCENARIOS: Array<{
  id: string;
  label: string;
  spend: (t: number) => number;
  flat?: boolean;
}> = [
  { id: 'S1', label: 'Estable con estacionalidad semanal', spend: () => 300 },
  { id: 'S2', label: 'Tendencia creciente', spend: (t) => 200 + t },
  { id: 'S3', label: 'Cambio de régimen (×2 el día 200)', spend: (t) => (t < 200 ? 300 : 600) },
  { id: 'S4', label: 'Sin estacionalidad', spend: () => 300, flat: true },
  { id: 'S5', label: 'Volumen bajo (≈ 1 lead/día)', spend: () => 40 },
];

function e1() {
  const days = 300;
  console.log('\n## E1. Pronóstico (300 días, horizonte 28 + hueco 3, R =', R, 'semillas)\n');
  console.log(
    '| Escenario | Serie | Publicado | Modelo más elegido | MAE rel. (mediana) | MASE (mediana) | Cobertura diaria (backtest) | Cobertura del total (backtest) | Cobertura del total en horizonte oculto |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const sc of SCENARIOS) {
    for (const field of ['spend', 'leads', 'cpl'] as const) {
      const published: number[] = [];
      const rel: number[] = [];
      const mase: number[] = [];
      const dcov: number[] = [];
      const tcov: number[] = [];
      const hidden: number[] = [];
      const chosen = new Map<string, number>();
      for (let seed = 1; seed <= R; seed++) {
        // Se generan 31 días más: el horizonte oculto, que el modelo nunca ve.
        const rows = synthetic({
          days: days + H.gap + H.horizon,
          seed: seed * 101 + sc.id.charCodeAt(1),
          spend: sc.spend,
          weekly: sc.flat ? [1, 1, 1, 1, 1, 1, 1] : WEEKLY,
          leads: { k: sc.id === 'S5' ? 0.05 : 0.2, b: 0.8 },
        });
        const cut = addDays(UNTIL, -(H.gap + H.horizon));
        const hist = prepareHistory(rows, cut);
        const future = rows.filter((r) => r.date > addDays(cut, H.gap));
        const sum = (f: string) => future.reduce((s, r) => s + (r.values[f] ?? 0), 0);
        const fs = forecastSeries(hist, seriesOf(hist, 'spend'), H, { count: false });
        const fl = forecastSeries(hist, seriesOf(hist, 'leads'), H, { count: true });
        if (field === 'cpl') {
          const r = forecastRatio(fs, fl, H);
          published.push(r.status === 'published' ? 1 : 0);
          if (r.coverage !== null) tcov.push(r.coverage);
          if (r.total) {
            const actual = sum('spend') / sum('leads');
            hidden.push(actual >= r.total.lower && actual <= r.total.upper ? 1 : 0);
          }
          continue;
        }
        const f = field === 'spend' ? fs : fl;
        published.push(f.status === 'published' ? 1 : 0);
        const c = f.backtest?.chosen;
        if (c) chosen.set(c, (chosen.get(c) ?? 0) + 1);
        const best = f.backtest?.scores.find((s) => s.model === c);
        if (best?.relMae != null) rel.push(best.relMae);
        if (best?.mase != null) mase.push(best.mase);
        const cal = f.backtest?.calibration;
        if (cal?.dailyCoverage != null) dcov.push(cal.dailyCoverage);
        if (cal?.totalCoverage != null) tcov.push(cal.totalCoverage);
        if (f.total) {
          const actual = sum(field);
          hidden.push(actual >= f.total.lower && actual <= f.total.upper ? 1 : 0);
        }
      }
      const top = [...chosen].sort((a, b) => b[1] - a[1])[0];
      console.log(
        `| ${sc.id} ${sc.label} | ${field === 'cpl' ? 'Costo por lead' : field === 'spend' ? 'Gasto' : 'Leads'} | ${fmt(mean(published) * 100, 0)} % | ${top ? `${top[0]} (${top[1]}/${R})` : '—'} | ${fmt(medianOf(rel))} | ${fmt(medianOf(mase))} | ${dcov.length ? `${fmt(mean(dcov) * 100, 0)} %` : '—'} | ${tcov.length ? `${fmt(mean(tcov) * 100, 0)} %` : 'n/d'} | ${hidden.length ? `${fmt(mean(hidden) * 100, 0)} % (n = ${hidden.length})` : 'n/d'} |`,
      );
    }
  }
}

// --- E2. Criterios mínimos de datos según la longitud de la historia

function e2() {
  console.log('\n## E2. Criterios mínimos de datos (gasto, escenario S1, semilla 1)\n');
  console.log(
    `Días exigidos: horizonte 7 → ${requiredDays({ horizon: 7, gap: 3 })} · 14 → ${requiredDays({ horizon: 14, gap: 3 })} · 28 → ${requiredDays(H)} · 56 → ${requiredDays({ horizon: 56, gap: 3 })}\n`,
  );
  console.log('| Días de historia | Estado | Motivo |');
  console.log('|---|---|---|');
  for (const days of [30, 90, 150, 198, 199, 240, 365]) {
    const rows = synthetic({ days, seed: 1, spend: () => 300, leads: { k: 0.2, b: 0.8 } });
    const hist = prepareHistory(rows, UNTIL);
    const f = forecastSeries(hist, seriesOf(hist, 'spend'), H, { count: false });
    console.log(`| ${days} | ${f.status} | ${f.reasons.join(' ') || '—'} |`);
  }
  // Cambio de atribución y pausa: la historia se corta.
  const attr = synthetic({
    days: 300,
    seed: 2,
    spend: () => 300,
    attribution: (t) => (t < 250 ? '7d_click_1d_view' : '7d_click'),
  });
  const ha = prepareHistory(attr, UNTIL);
  const pause = synthetic({ days: 300, seed: 3, spend: (t) => (t >= 100 && t < 110 ? 0 : 300) });
  const hp = prepareHistory(pause, UNTIL);
  console.log(
    `\nCambio de atribución el día 250 → historia utilizable de ${ha.dates.length} días (cortes: ${ha.breaks.map((b) => b.reason).join(', ')}). Pausa de 10 días → ${hp.dates.length} días.`,
  );
}

// --- E3. Curva de respuesta: recuperación de la elasticidad y calibración del intervalo creíble

/** Eventos semanales esperados según el gasto: potencia (la forma del modelo) o saturación. */
type Truth = (weeklySpend: number) => number;
const power =
  (b: number): Truth =>
  (s) =>
    0.5 * s ** b;
// Michaelis-Menten con elasticidad local 0,5 en el gasto típico (2000) y la misma media allí.
const saturating: Truth = (s) => (2 * 0.5 * 2000 ** 0.8 * s) / (s + 2000);

function weeklyData(seed: number, truth: Truth, sd: number, weeks = 26): Week[] {
  const rand = mulberry32(seed);
  return Array.from({ length: weeks }, (_, i) => {
    const spend = 2000 * Math.exp(sd * normal(rand));
    return { end: addDays(UNTIL, 7 * (i - weeks)), spend, events: draw(truth(spend), rand) };
  });
}
/** Sobredispersión real: λ con ruido log-normal (cv ≈ 0,15) antes del Poisson. */
const draw = (mean: number, rand: () => number) =>
  poissonSample(mean * Math.exp(0.15 * normal(rand) - 0.0113), rand);

function credible(fit: NonNullable<ReturnType<typeof fitResponse>>) {
  const sd = Math.sqrt(fit.cov.bb);
  return [fit.b - 1.2816 * sd, fit.b + 1.2816 * sd] as const;
}

function e3() {
  const reps = 200;
  console.log(
    `\n## E3. Curva de respuesta: recuperación de b (26 semanas, ${reps} réplicas; a priori N(${RESPONSE.prior.mean}; ${RESPONSE.prior.sd}²))\n`,
  );
  console.log(
    '| b real | Variación del gasto (sd log) | Media a posteriori de b | Cobertura del intervalo creíble del 80 % | Aprendido de los datos (media) |',
  );
  console.log('|---|---|---|---|---|');
  for (const sd of [0.35, 0.1, 0.01])
    for (const b of [0.5, 0.8, 1.0]) {
      const est: number[] = [];
      const cover: number[] = [];
      const learned: number[] = [];
      for (let s = 1; s <= reps; s++) {
        const fit = fitResponse(weeklyData(s * 7 + Math.round(b * 10), power(b), sd));
        if (!fit) continue;
        est.push(fit.b);
        const [lo, hi] = credible(fit);
        cover.push(b >= lo && b <= hi ? 1 : 0);
        learned.push(fit.learned);
      }
      console.log(
        `| ${b} | ${sd} | ${fmt(mean(est))} | ${fmt(mean(cover) * 100, 0)} % | ${fmt(mean(learned) * 100, 0)} % |`,
      );
    }
}

// --- E4. Validación de un paso y cobertura real de los escenarios (Monte Carlo)

function e4() {
  const reps = Number(process.env.REPS_MC ?? 60);
  const truths: Array<[string, Truth]> = [
    ['potencia b = 0,8 (forma correcta)', power(0.8)],
    ['saturación Michaelis-Menten (forma incorrecta)', saturating],
  ];
  console.log(`\n## E4. Validación de un paso y escenarios (${reps} réplicas por celda)\n`);
  console.log(
    '| Respuesta real | Cobertura PIT de la validación (nominal 80 %) | MAE ÷ costo constante (mediana) | Publicable |',
  );
  console.log('|---|---|---|---|');
  for (const [label, truth] of truths) {
    const pit: number[] = [];
    const rel: number[] = [];
    let ok = 0;
    for (let s = 1; s <= reps; s++) {
      const v = validateResponse(weeklyData(s * 13, truth, 0.35), s);
      if (v.coverage !== null) pit.push(v.coverage);
      if (v.relMae !== null) rel.push(v.relMae);
      if (v.coverage !== null && coverageOk(v.coverage, v.evaluated)) ok++;
    }
    console.log(
      `| ${label} | ${fmt(mean(pit) * 100, 0)} % | ${fmt(medianOf(rel))} | ${fmt((ok / reps) * 100, 0)} % |`,
    );
  }
  console.log(
    '\n| Respuesta real | Cambio del gasto diario | Eventos reales de 4 semanas dentro de P10–P90 | Marcado como extrapolación | Marcado como cambio grande |',
  );
  console.log('|---|---|---|---|---|');
  for (const [label, truth] of truths)
    for (const change of [-0.5, 0, 0.3, 1, 3]) {
      let inside = 0;
      let extrapolated = 0;
      let large = 0;
      for (let s = 1; s <= reps; s++) {
        const weeks = weeklyData(s * 17, truth, 0.35);
        const fit = fitResponse(weeks);
        if (!fit) continue;
        const current = weeks.slice(-4).reduce((x, w) => x + w.spend, 0) / 28;
        const planned = current * (1 + change);
        const { outcomes } = simulatePlans(
          [{ id: 'c', group: 'leads', fit, currentDaily: current, plannedDaily: planned }],
          28,
          { seed: s, draws: 4000 },
        );
        const o = outcomes[0];
        if (!o) continue;
        // El futuro real: 4 semanas del mismo proceso generador al gasto planificado.
        const rand = mulberry32(s * 999);
        let actual = 0;
        for (let w = 0; w < 4; w++) actual += draw(truth(7 * planned), rand);
        if (actual >= o.events.p10 && actual <= o.events.p90) inside++;
        if (o.extrapolation) extrapolated++;
        if (o.largeChange) large++;
      }
      console.log(
        `| ${label} | ${change >= 0 ? '+' : ''}${Math.round(change * 100)} % | ${fmt((inside / reps) * 100, 0)} % | ${fmt((extrapolated / reps) * 100, 0)} % | ${fmt((large / reps) * 100, 0)} % |`,
      );
    }
}

// --- E5. Datos reales disponibles (solo estados y conteos)

function e5(path: string) {
  console.log('\n## E5. Datos reales disponibles\n');
  if (!existsSync(path)) {
    console.log(`No existe ${path}.`);
    return;
  }
  const [header, ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = (header ?? '').split(',');
  const rows: DailyRow[] = lines.map((l) => {
    const cells = l.split(',');
    const get = (c: string) => Number(cells[cols.indexOf(c)] ?? 0);
    return {
      date: cells[0] as string,
      attribution: null,
      values: { spend: get('spend'), impressions: get('impressions') },
    };
  });
  const until = rows.at(-1)?.date ?? UNTIL;
  const hist = prepareHistory(rows, addDays(until, -H.gap));
  const f = forecastSeries(hist, seriesOf(hist, 'spend'), H, { count: false });
  console.log(
    `${rows.length} filas diarias de 1 cuenta; historia utilizable ${hist.dates.length} días (cortes: ${hist.breaks.map((b) => `${b.reason} ${b.date}`).join(', ') || 'ninguno'}). Gasto: ${f.status} — ${f.reasons.join(' ')}`,
  );
}

const realArg = process.argv.indexOf('--real');
console.log(
  `# Experimentos ${new Date().toISOString().slice(0, 10)} · criterios`,
  JSON.stringify(CRITERIA),
);
e1();
e2();
e3();
e4();
e5(realArg > 0 ? (process.argv[realArg + 1] ?? '') : 'spike-output/reconciliacion.csv');

import { existsSync, readFileSync } from 'node:fs';
import { calendarEvents, eventLookup } from '../src/modules/forecasting/calendar.ts';
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
  analyzeExperiment,
  type CurveFit,
  causalElasticity,
  designExperiment,
  fitCurve,
  localElasticity,
  mulberry32,
  normal,
  type Plan,
  poissonSample,
  RESPONSE,
  simulatePlans,
  validatedRange,
  validateExtremes,
  validateResponse,
  type Week,
} from '../src/modules/forecasting/simulate.ts';
import { addDays } from '../src/modules/insights/catalog.ts';
import { synthetic, UNTIL, WEEKLY } from '../test/forecast-fixtures.ts';

// Experimentos de la capa de pronóstico y simulación (docs/FORECASTING.md §8). Deterministas
// (semillas fijas). Uso: pnpm forecast:experiments [--real ruta.csv]
// Con datos reales solo imprime conteos y estados, nunca valores de la cuenta.

const H: Horizon = { horizon: 28, gap: 3 };
const R = Number(process.env.REPS ?? 40);
const RM = Number(process.env.REPS_MC ?? 60);
const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? 'n/d' : x.toFixed(d);
const pct = (x: number) => `${fmt(x * 100, 0)} %`;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : Number.NaN);
const medianOf = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : Number.NaN;
};
/** Calendario incorporado de la historia sintética y su horizonte (como en producción). */
const CALENDAR = calendarEvents(addDays(UNTIL, -500), addDays(UNTIL, 90));

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
  console.log(
    `\n## E1. Pronóstico con el calendario incorporado (300 días, horizonte 28 + hueco 3, R = ${R})\n`,
  );
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
        const hist = prepareHistory(rows, cut, CALENDAR);
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
        `| ${sc.id} ${sc.label} | ${field === 'cpl' ? 'Costo por lead' : field === 'spend' ? 'Gasto' : 'Leads'} | ${pct(mean(published))} | ${top ? `${top[0]} (${top[1]}/${R})` : '—'} | ${fmt(medianOf(rel))} | ${fmt(medianOf(mase))} | ${dcov.length ? pct(mean(dcov)) : '—'} | ${tcov.length ? pct(mean(tcov)) : 'n/d'} | ${hidden.length ? `${pct(mean(hidden))} (n = ${hidden.length})` : 'n/d'} |`,
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
    const hist = prepareHistory(rows, UNTIL, CALENDAR);
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

// --- Datos semanales para la curva de respuesta

/** Eventos semanales esperados según el gasto: potencia (la forma del modelo) o saturación. */
type Truth = (weeklySpend: number) => number;
const power =
  (b: number): Truth =>
  (s) =>
    0.5 * s ** b;
// Michaelis-Menten con elasticidad local 0,5 en el gasto típico (2000) y la misma media allí.
const saturating: Truth = (s) => (2 * 0.5 * 2000 ** 0.8 * s) / (s + 2000);
/** Sobredispersión real: λ con ruido log-normal (cv ≈ 0,15) antes del Poisson. */
const draw = (m: number, rand: () => number) =>
  poissonSample(m * Math.exp(0.15 * normal(rand) - 0.0113), rand);

function weeklyData(seed: number, truth: Truth, sd: number, weeks = 26): Week[] {
  const rand = mulberry32(seed);
  return Array.from({ length: weeks }, (_, i) => {
    const spend = 2000 * Math.exp(sd * normal(rand));
    return {
      end: addDays(UNTIL, 7 * (i - weeks + 1)),
      index: i - (weeks - 1),
      spend,
      events: draw(truth(spend), rand),
      others: 0,
      share: [0, 0, 0, 0],
    };
  });
}
const plan = (fit: CurveFit, current: number, planned: number, id = 'c'): Plan => ({
  id,
  group: 'leads',
  fit,
  currentDaily: current,
  plannedDaily: planned,
  othersCurrent: 0,
  othersPlanned: 0,
  experiment: null,
  shares: [],
});

// --- E3. Curva de respuesta: recuperación de la elasticidad y calibración del intervalo creíble

function e3() {
  const reps = 200;
  const p = RESPONSE.priors.elasticity;
  console.log(
    `\n## E3. Curva de respuesta v2: recuperación de b (26 semanas, ${reps} réplicas; a priori N(${p.mean}; ${p.sd}²); curvatura N(0; ${RESPONSE.priors.curvature}²))\n`,
  );
  console.log(
    '| b real | Variación del gasto (sd log) | Media a posteriori de b | Cobertura del intervalo creíble del 80 % | Aprendido de los datos (media) |',
  );
  console.log('|---|---|---|---|---|');
  for (const sd of [0.35, 0.1, 0.01])
    for (const b of [0.5, 0.8, 1.0]) {
      const est: number[] = [];
      const cover: number[] = [];
      const learnedB: number[] = [];
      for (let s = 1; s <= reps; s++) {
        const fit = fitCurve(weeklyData(s * 7 + Math.round(b * 10), power(b), sd));
        if (!fit) continue;
        const e = localElasticity(fit, Math.exp(fit.xMean));
        est.push(e.mean);
        cover.push(Math.abs(e.mean - b) <= 1.2816 * e.sd ? 1 : 0);
        learnedB.push(Math.max(0, 1 - e.sd ** 2 / p.sd ** 2));
      }
      console.log(
        `| ${b} | ${sd} | ${fmt(mean(est))} | ${pct(mean(cover))} | ${pct(mean(learnedB))} |`,
      );
    }
}

// --- E4. Validación (de un paso y de extremos) y cobertura real de los escenarios

function e4() {
  const truths: Array<[string, Truth]> = [
    ['Potencia b = 0,8 (forma correcta)', power(0.8)],
    ['Saturación Michaelis-Menten (forma incorrecta)', saturating],
  ];
  console.log(`\n## E4. Validación y escenarios v2 (${RM} réplicas por celda)\n`);
  console.log(
    '| Respuesta real | Cobertura PIT de un paso (nominal 80 %) | MAE ÷ costo constante (mediana) | Cobertura PIT de extremos | Extremos calibrados |',
  );
  console.log('|---|---|---|---|---|');
  for (const [label, truth] of truths) {
    const pit: number[] = [];
    const rel: number[] = [];
    const ext: number[] = [];
    let ok = 0;
    for (let s = 1; s <= RM; s++) {
      const ws = weeklyData(s * 13, truth, 0.35);
      const v = validateResponse(ws, s);
      if (v.coverage !== null) pit.push(v.coverage);
      if (v.relMae !== null) rel.push(v.relMae);
      const x = validateExtremes(ws, s);
      if (x.coverage !== null) {
        ext.push(x.coverage);
        if (coverageOk(x.coverage, x.evaluated)) ok++;
      }
    }
    console.log(
      `| ${label} | ${pct(mean(pit))} | ${fmt(medianOf(rel))} | ${pct(mean(ext))} | ${pct(ok / RM)} |`,
    );
  }
  console.log(
    '\n| Respuesta real | Sesgo de confusión σ | Cambio del gasto diario | Publicado | Eventos reales de 4 semanas dentro de P10–P90 (publicados) |',
  );
  console.log('|---|---|---|---|---|');
  for (const [label, truth] of truths)
    for (const biasSd of [RESPONSE.confounding.sd, 0])
      for (const change of [-0.5, 0, 0.3, 1, 3]) {
        let inside = 0;
        let published = 0;
        for (let s = 1; s <= RM; s++) {
          const ws = weeklyData(s * 17, truth, 0.35);
          const fit = fitCurve(ws);
          if (!fit) continue;
          const current = ws.slice(-4).reduce((x, w) => x + w.spend, 0) / 28;
          const planned = current * (1 + change);
          const range = validatedRange(fit, ws, validateExtremes(ws, s));
          if (change !== 0 && (7 * planned < range.min || 7 * planned > range.max)) continue;
          published++;
          const o = simulatePlans([plan(fit, current, planned)], 28, {
            seed: s,
            draws: 3000,
            biasSd,
          }).outcomes[0];
          if (!o) continue;
          // El futuro real: 4 semanas del mismo proceso generador al gasto planificado.
          const rand = mulberry32(s * 999);
          let actual = 0;
          for (let w = 0; w < 4; w++) actual += draw(truth(7 * planned), rand);
          if (actual >= o.events.p10 && actual <= o.events.p90) inside++;
        }
        console.log(
          `| ${label} | ${biasSd} | ${change >= 0 ? '+' : ''}${Math.round(change * 100)} % | ${pct(published / RM)} | ${published ? pct(inside / published) : 'n/d'} |`,
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
  const hist = prepareHistory(rows, addDays(until, -H.gap), CALENDAR);
  const f = forecastSeries(hist, seriesOf(hist, 'spend'), H, { count: false });
  console.log(
    `${rows.length} filas diarias de 1 cuenta; historia utilizable ${hist.dates.length} días (cortes: ${hist.breaks.map((b) => `${b.reason} ${b.date}`).join(', ') || 'ninguno'}). Gasto: ${f.status} — ${f.reasons.join(' ')}`,
  );
}

// --- E6. Confusión: la regresión observacional frente al experimento aleatorizado

/**
 * La demanda semanal D sube los eventos y, como el anunciante sube el presupuesto cuando va bien,
 * también el gasto (S ∝ D^1,5): la elasticidad observada sobreestima la causal (0,6).
 */
function e6() {
  const truth = 0.6;
  console.log(
    `\n## E6. Confusión y experimentos (elasticidad causal ${truth}; ${RM} réplicas; 26 semanas observacionales y un experimento de 9 periodos, niveles 0,6 · 1 · 1,6)\n`,
  );
  const obs: number[] = [];
  const cover = { plain: 0, bias: 0, experiment: 0, combined: 0 };
  let n = 0;
  let conclusive = 0;
  for (let s = 1; s <= RM; s++) {
    const rand = mulberry32(s * 31);
    const ws: Week[] = Array.from({ length: 26 }, (_, i) => {
      const d = Math.exp(0.25 * normal(rand));
      const spend = 2000 * d ** 1.5 * Math.exp(0.1 * normal(rand));
      return {
        end: addDays(UNTIL, 7 * (i - 25)),
        index: i - 25,
        spend,
        events: poissonSample(0.5 * spend ** truth * d, rand),
        others: 0,
        share: [0, 0, 0, 0],
      };
    });
    const fit = fitCurve(ws);
    if (!fit) continue;
    n++;
    const e = localElasticity(fit, Math.exp(fit.xMean));
    obs.push(e.mean);
    const inside = (m: number, sd: number) => Math.abs(m - truth) <= 1.2816 * sd;
    if (inside(e.mean, e.sd)) cover.plain++;
    const withBias = causalElasticity(e, RESPONSE.confounding.sd, null);
    if (inside(withBias.mean, withBias.sd)) cover.bias++;
    // Experimento: el gasto sigue al nivel asignado (con ruido de entrega) y la demanda sigue ahí.
    const schedule = designExperiment({
      start: '2026-06-01',
      levels: [0.6, 1, 1.6],
      blocks: 3,
      seed: s,
    });
    const days = new Map<string, { spend: number; events: number }>();
    for (const p of schedule) {
      const d = Math.exp(0.25 * normal(rand));
      for (let k = 0; k < 7; k++) {
        const spend = (2000 / 7) * p.multiplier * Math.exp(0.1 * normal(rand));
        days.set(addDays(p.since, k), {
          spend,
          events: poissonSample((0.5 * (7 * spend) ** truth * d) / 7, rand),
        });
      }
    }
    const r = analyzeExperiment(
      schedule,
      (date) => days.get(date) ?? { spend: 0, events: 0 },
      '2026-12-31',
      2000 / 7,
    );
    if (!r.elasticity) continue;
    conclusive++;
    if (inside(r.elasticity.point, r.elasticity.se)) cover.experiment++;
    const c = causalElasticity(e, RESPONSE.confounding.sd, {
      mean: r.elasticity.point,
      se: r.elasticity.se,
    });
    if (inside(c.mean, c.sd)) cover.combined++;
  }
  console.log('| Estimación | Cobertura de la elasticidad causal con su intervalo del 80 % |');
  console.log('|---|---|');
  console.log(
    `| Observacional sin término de confusión (media ${fmt(mean(obs))}) | ${pct(cover.plain / n)} |`,
  );
  console.log(
    `| Observacional + confusión N(0; ${RESPONSE.confounding.sd}²) | ${pct(cover.bias / n)} |`,
  );
  console.log(
    `| Experimento aleatorizado (variable instrumental; concluyente en ${conclusive}/${n}) | ${pct(cover.experiment / Math.max(1, conclusive))} |`,
  );
  console.log(
    `| Sustituir la elasticidad observacional por la experimental | ${pct(cover.combined / Math.max(1, conclusive))} |`,
  );
}

// --- E7. Dependencia entre campañas: total de dos campañas con choques comunes

function e7() {
  console.log(
    `\n## E7. Dependencia entre campañas (dos campañas con choques semanales comunes; ${RM} réplicas)\n`,
  );
  console.log(
    '| Correlación de los choques | Cobertura del total (remuestreo conjunto por bloques) | Cobertura del total (campañas independientes, v1) |',
  );
  console.log('|---|---|---|');
  for (const rho of [0, 0.5, 0.9]) {
    let joint = 0;
    let indep = 0;
    let n = 0;
    for (let s = 1; s <= RM; s++) {
      const rand = mulberry32(s * 53);
      // Choques: común (√ρ) + propio (√(1−ρ)), sd total 0,25; 26 semanas de historia + 4 futuras.
      const shocks = Array.from({ length: 30 }, () => {
        const c = normal(rand);
        return [0, 1].map(() => 0.25 * (Math.sqrt(rho) * c + Math.sqrt(1 - rho) * normal(rand)));
      });
      const series = [0, 1].map((k) =>
        Array.from({ length: 26 }, (_, i) => {
          const spend = 2000 * Math.exp(0.3 * normal(rand));
          return {
            end: addDays(UNTIL, 7 * (i - 25)),
            index: i - 25,
            spend,
            events: poissonSample(
              0.5 * spend ** 0.8 * Math.exp((shocks[i]?.[k] as number) - 0.031),
              rand,
            ),
            others: 0,
            share: [0, 0, 0, 0],
          };
        }),
      );
      const fits = series.map((w) => fitCurve(w));
      if (!fits[0] || !fits[1]) continue;
      n++;
      const [a, b] = fits as [CurveFit, CurveFit];
      const shifted: CurveFit = {
        ...b,
        shocks: new Map([...b.shocks].map(([k, v]) => [addDays(k, -365), v])),
      };
      const total = (second: CurveFit) =>
        simulatePlans([plan(a, 300, 300, 'a'), plan(second, 300, 300, 'b')], 28, {
          seed: s,
          draws: 3000,
          biasSd: 0,
        }).totals[0];
      // El futuro real: 4 semanas con choques comunes nuevos.
      let actual = 0;
      for (let w = 26; w < 30; w++)
        for (const k of [0, 1])
          actual += poissonSample(
            0.5 * 2100 ** 0.8 * Math.exp((shocks[w]?.[k] as number) - 0.031),
            rand,
          );
      const inside = (t: ReturnType<typeof total>) =>
        t && actual >= t.events.p10 && actual <= t.events.p90 ? 1 : 0;
      joint += inside(total(b));
      indep += inside(total(shifted));
    }
    console.log(`| ${rho} | ${pct(joint / n)} | ${pct(indep / n)} |`);
  }
}

// --- E8. Festivos y días de pago: con y sin calendario

function e8() {
  console.log(
    `\n## E8. Días de pago (+40 %) y fiestas patrias (−40 %) con y sin el calendario (R = ${R}; leads, horizonte oculto de 28 días)\n`,
  );
  const at = eventLookup(CALENDAR);
  const effect = (d: string) => {
    const e = at(d);
    return e?.category === 'payday' ? 1.4 : e?.key === 'independencia' ? 0.6 : 1;
  };
  console.log(
    '| Calendario | Publicado | MAE rel. (mediana) | Cobertura en días de pago (horizonte oculto) | Cobertura del total (horizonte oculto) |',
  );
  console.log('|---|---|---|---|---|');
  for (const builtin of [true, false]) {
    const events = builtin ? CALENDAR : [];
    const published: number[] = [];
    const rel: number[] = [];
    const paid: number[] = [];
    const total: number[] = [];
    for (let seed = 1; seed <= R; seed++) {
      const rows = synthetic({
        days: 331,
        seed: seed * 7 + 3,
        spend: () => 300,
        leads: { k: 0.2, b: 0.8 },
        effect,
      });
      const cut = addDays(UNTIL, -(H.gap + H.horizon));
      const hist = prepareHistory(rows, cut, events);
      const f = forecastSeries(hist, seriesOf(hist, 'leads'), H, { count: true });
      published.push(f.status === 'published' ? 1 : 0);
      const best = f.backtest?.scores.find((s) => s.model === f.backtest?.chosen);
      if (best?.relMae != null) rel.push(best.relMae);
      if (!f.points || !f.total) continue;
      const future = rows.filter((r) => r.date > addDays(cut, H.gap));
      f.points.forEach((p, i) => {
        const r = future[i];
        if (!r || at(r.date)?.category !== 'payday') return;
        const a = r.values.leads ?? 0;
        paid.push(a >= p.lower && a <= p.upper ? 1 : 0);
      });
      const sum = future.reduce((s, r) => s + (r.values.leads ?? 0), 0);
      total.push(sum >= f.total.lower && sum <= f.total.upper ? 1 : 0);
    }
    console.log(
      `| ${builtin ? 'Incorporado' : 'Sin calendario'} | ${pct(mean(published))} | ${fmt(medianOf(rel))} | ${paid.length ? `${pct(mean(paid))} (n = ${paid.length})` : 'n/d'} | ${total.length ? `${pct(mean(total))} (n = ${total.length})` : 'n/d'} |`,
    );
  }
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
e6();
e7();
e8();

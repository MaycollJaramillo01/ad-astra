import { addDays } from '../insights/catalog.ts';

// Calendario de eventos para el pronóstico y la simulación (docs/FORECASTING.md §2.5). Funciones
// puras. Dos fuentes:
//   - Incorporado: festivos y fechas comerciales que se calculan solos (Honduras y región), más
//     los días de pago (quincena). Un evento que no afecta a una cuenta queda con efecto ≈ 1 en
//     cuanto hay historia; mientras no la hay, solo ensancha el intervalo de sus días.
//   - Propio de la petición: promociones, festivos por decreto (p. ej., el feriado morazánico) e
//     incidencias. Las incidencias (caídas del seguimiento, errores) se excluyen y no se proyectan.

export const CATEGORIES = {
  holiday: 'Festivo',
  commercial: 'Fecha comercial',
  payday: 'Días de pago',
  promotion: 'Promoción',
  incident: 'Incidencia (se excluye)',
} as const;
export type EventCategory = keyof typeof CATEGORIES;
export const EVENT_CATEGORIES = Object.keys(CATEGORIES) as [EventCategory, ...EventCategory[]];
/** Categorías cuyo efecto se estima y se proyecta (las incidencias solo se excluyen). */
export const MODELED: EventCategory[] = ['holiday', 'commercial', 'payday', 'promotion'];

export interface CalendarEvent {
  /** Identifica el mismo evento entre años (su efecto se estima con todas sus ocurrencias). */
  key: string;
  label: string;
  category: EventCategory;
  since: string;
  until: string;
  source: 'builtin' | 'user';
}

/** Evento definido en la petición; `yearly` lo repite cada año en las mismas fechas. */
export interface UserEvent {
  since: string;
  until: string;
  label: string;
  category: EventCategory;
  yearly?: boolean;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** n-ésimo día de la semana (0 = domingo) del mes. */
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((weekday - first + 7) % 7) + 7 * (n - 1));
}
/** Domingo de Pascua (algoritmo anónimo gregoriano, Meeus). */
export function easter(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return iso(y, month, ((h + l - 7 * m + 114) % 31) + 1);
}

/** Ocurrencias de un año: [clave, etiqueta, categoría, desde, hasta]. */
function yearEvents(y: number): Array<[string, string, EventCategory, string, string]> {
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  const mothers = nthWeekday(y, 5, 0, 2);
  const out: Array<[string, string, EventCategory, string, string]> = [
    ['fin-de-ano', 'Fin de año', 'holiday', iso(y - 1, 12, 31), iso(y, 1, 1)],
    [
      'san-valentin',
      'San Valentín (y los 3 días previos)',
      'commercial',
      iso(y, 2, 11),
      iso(y, 2, 14),
    ],
    [
      'dia-del-padre',
      'Día del Padre en Honduras, 19 mar (y los 3 días previos)',
      'commercial',
      iso(y, 3, 16),
      iso(y, 3, 19),
    ],
    [
      'semana-santa',
      'Semana Santa (jueves a domingo)',
      'holiday',
      addDays(easter(y), -3),
      easter(y),
    ],
    ['dia-del-trabajo', 'Día del Trabajo', 'holiday', iso(y, 5, 1), iso(y, 5, 1)],
    [
      'dia-de-la-madre',
      'Día de la Madre en Honduras, 2.º domingo de mayo (y los 3 días previos)',
      'commercial',
      addDays(mothers, -3),
      mothers,
    ],
    [
      'dia-del-nino',
      'Día del Niño en Honduras, 10 sep (y los 3 días previos)',
      'commercial',
      iso(y, 9, 7),
      iso(y, 9, 10),
    ],
    ['independencia', 'Fiestas patrias, 15 sep', 'holiday', iso(y, 9, 15), iso(y, 9, 15)],
    [
      'black-friday',
      'Black Friday (viernes a domingo)',
      'commercial',
      addDays(thanksgiving, 1),
      addDays(thanksgiving, 3),
    ],
    [
      'cyber-monday',
      'Cyber Monday',
      'commercial',
      addDays(thanksgiving, 4),
      addDays(thanksgiving, 4),
    ],
    [
      'temporada-navidena',
      'Compras navideñas (15–23 dic)',
      'commercial',
      iso(y, 12, 15),
      iso(y, 12, 23),
    ],
    ['navidad', 'Navidad (24–25 dic)', 'holiday', iso(y, 12, 24), iso(y, 12, 25)],
  ];
  for (let m = 1; m <= 12; m++) {
    out.push(['quincena', 'Días de pago (quincena)', 'payday', iso(y, m, 15), iso(y, m, 16)]);
    out.push([
      'quincena',
      'Días de pago (quincena)',
      'payday',
      iso(y, m, lastDay(y, m)),
      addDays(iso(y, m, lastDay(y, m)), 1),
    ]);
  }
  return out;
}

const overlaps = (e: { since: string; until: string }, since: string, until: string) =>
  e.since <= until && e.until >= since;
const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Eventos (incorporados y de la petición) que tocan [since, until]. */
export function calendarEvents(
  since: string,
  until: string,
  user: readonly UserEvent[] = [],
  builtin = true,
): CalendarEvent[] {
  const y0 = Number(since.slice(0, 4));
  const y1 = Number(until.slice(0, 4)) + 1; // el fin de año del año siguiente empieza el 31 dic
  const out: CalendarEvent[] = [];
  if (builtin)
    for (let y = y0; y <= y1; y++)
      for (const [key, label, category, s, u] of yearEvents(y))
        if (overlaps({ since: s, until: u }, since, until))
          out.push({ key, label, category, since: s, until: u, source: 'builtin' });
  for (const e of user) {
    const key = `user:${e.category}:${slug(e.label)}`;
    const years = e.yearly
      ? Array.from({ length: y1 - y0 + 2 }, (_, i) => y0 - 1 + i)
      : [Number(e.since.slice(0, 4))];
    for (const y of years) {
      const shift = y - Number(e.since.slice(0, 4));
      const s = `${Number(e.since.slice(0, 4)) + shift}${e.since.slice(4)}`;
      const u = `${Number(e.until.slice(0, 4)) + shift}${e.until.slice(4)}`;
      if (overlaps({ since: s, until: u }, since, until))
        out.push({ key, label: e.label, category: e.category, since: s, until: u, source: 'user' });
    }
  }
  return out;
}

/** Prioridad cuando dos eventos caen el mismo día: lo propio, después festivos, fechas y pagos. */
const PRIORITY: Record<EventCategory, number> = {
  incident: 0,
  promotion: 1,
  holiday: 2,
  commercial: 3,
  payday: 4,
};

/** Evento de cada día (como mucho uno: el de más prioridad). */
export function eventLookup(
  events: readonly CalendarEvent[],
): (date: string) => CalendarEvent | null {
  const sorted = [...events].sort(
    (a, b) =>
      (a.source === 'user' ? 0 : 1) - (b.source === 'user' ? 0 : 1) ||
      PRIORITY[a.category] - PRIORITY[b.category],
  );
  return (date) => sorted.find((e) => date >= e.since && date <= e.until) ?? null;
}

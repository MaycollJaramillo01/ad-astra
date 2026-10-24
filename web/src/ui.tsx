import type { Tone } from '../../src/modules/insights/catalog.ts';

// Piezas de interfaz compartidas por las vistas.

/** Icono de estado: forma y color (nunca solo color), siempre junto a un texto. */
export function ToneIcon({ tone }: { tone: Tone }) {
  const color = {
    good: 'var(--status-good)',
    warning: 'var(--status-warning)',
    critical: 'var(--status-critical)',
    neutral: 'var(--status-neutral)',
  }[tone];
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
      {tone === 'good' && <circle cx="5" cy="5" r="4" fill={color} />}
      {tone === 'warning' && <path d="M5 1 L9.2 9 H0.8 Z" fill={color} />}
      {tone === 'critical' && (
        <rect x="1.5" y="1.5" width="7" height="7" transform="rotate(45 5 5)" fill={color} />
      )}
      {tone === 'neutral' && (
        <circle cx="5" cy="5" r="3.5" fill="none" stroke={color} strokeWidth="1.5" />
      )}
    </svg>
  );
}

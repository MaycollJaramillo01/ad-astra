import { expect, it } from 'vitest';
import { slug } from './check-docs.ts';

it('genera las mismas anclas que GitHub', () => {
  expect(slug('4.1 F0 — Fundaciones y spikes de viabilidad')).toBe(
    '41-f0--fundaciones-y-spikes-de-viabilidad',
  );
  expect(slug('6.6 Índice de salud (fórmula `health-v1`)')).toBe(
    '66-índice-de-salud-fórmula-health-v1',
  );
  expect(slug('1.19 Condiciones de la plataforma de Meta aplicables [V]')).toBe(
    '119-condiciones-de-la-plataforma-de-meta-aplicables-v',
  );
});

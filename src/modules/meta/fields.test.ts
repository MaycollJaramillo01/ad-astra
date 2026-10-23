import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { META_API_VERSION } from './client.ts';
import { AD_LEVEL_INSIGHTS_FIELDS, FIELDS } from './fields.ts';

// Test de contrato (ADR-004): todo campo pedido existe en las specs oficiales de la versión fijada.
// Si META_API_VERSION cambia sin regenerar el snapshot (pnpm specs:update), falla al leerlo.
const snapshot = JSON.parse(
  readFileSync(new URL(`./spec-fields.${META_API_VERSION}.json`, import.meta.url), 'utf8'),
) as { objects: Record<string, string[]> };

const requested = { ...FIELDS, AdsInsights: [...FIELDS.AdsInsights, ...AD_LEVEL_INSIGHTS_FIELDS] };

it.each(Object.entries(requested))('%s: campos presentes en la spec', (object, fields) => {
  const known = new Set(snapshot.objects[object]);
  expect(known.size).toBeGreaterThan(0);
  expect(fields.filter((f) => !known.has(f))).toEqual([]);
});

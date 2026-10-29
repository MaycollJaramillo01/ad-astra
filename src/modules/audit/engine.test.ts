import { describe, expect, it } from 'vitest';
import { auditInput, entity, leadsDay, series, stack } from '../../../test/audit-fixtures.ts';
import { runAudit } from './engine.ts';
import { type AuditConfig, DEFAULT_CONFIG } from './model.ts';

// Objetivo del cliente: da una referencia de costo sin depender de la línea base.
const config: AuditConfig = {
  ...DEFAULT_CONFIG,
  targets: [{ profile: 'leads', currency: 'USD', costPerEvent: 10 }],
};

// Gasto en la ventana madura (días 3–6) sin ningún lead: dispara "gasto sin eventos clave".
const spendNoLeads = series(7, (back) => (back >= 3 && back <= 6 ? leadsDay(20, 0) : null));

describe('runAudit y entidades apagadas', () => {
  it('no abre hallazgos sobre una campaña pausada, sí sobre la misma activa', () => {
    const active = entity('campaign', 'c-activa', { objective: 'OUTCOME_LEADS', days: spendNoLeads });
    const paused = entity('campaign', 'c-pausada', {
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      days: spendNoLeads,
    });
    const result = runAudit(auditInput([active, paused]), config);
    const flagged = new Set(result.findings.map((f) => f.entityId));
    expect(flagged.has('c-activa')).toBe(true);
    expect(flagged.has('c-pausada')).toBe(false);
  });

  it('un anuncio activo hereda el estado apagado de su conjunto pausado', () => {
    // stack('9', …) → campaña '90', conjunto '91', anuncio '92'. Solo el conjunto está pausado.
    const entities = stack('9', spendNoLeads, { adset: { status: 'PAUSED' } });
    const result = runAudit(auditInput(entities), config);
    const flagged = new Set(result.findings.map((f) => f.entityId));
    expect(flagged.has('90')).toBe(true); // campaña activa: sí se evalúa
    expect(flagged.has('91')).toBe(false); // conjunto pausado
    expect(flagged.has('92')).toBe(false); // anuncio activo, pero su conjunto está pausado
  });
});

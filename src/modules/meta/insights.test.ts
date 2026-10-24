import { describe, expect, it } from 'vitest';
import {
  addDays,
  decimal,
  localDate,
  monthRange,
  parseResults,
  pickAction,
  splitRange,
  sumStats,
  toInsightRow,
} from './insights.ts';

describe('valores', () => {
  it('decimal conserva el string exacto y rechaza lo que no es un número', () => {
    expect(decimal('1234.5678')).toBe('1234.5678');
    expect(decimal('0.1')).toBe('0.1');
    expect(decimal(12)).toBe('12');
    expect(decimal('12,5')).toBeNull();
    expect(decimal(undefined)).toBeNull();
    expect(decimal('NaN')).toBeNull();
  });

  it('pickAction usa un solo tipo por KPI (sin contar dos veces) y 0 si Meta lo omite', () => {
    const actions = [
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
      { action_type: 'omni_purchase', value: '4' },
    ];
    expect(
      pickAction(actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
    ).toBe('4');
    expect(pickAction(actions, ['lead'])).toBe('0');
    expect(pickAction(undefined, ['lead'])).toBe('0');
  });

  it('sumStats suma sin error de coma flotante', () => {
    expect(sumStats([{ value: '0.1' }, { value: '0.2' }])).toBe('0.3000');
    expect(sumStats([{ value: '7' }, { value: '5' }])).toBe('12.0000');
    expect(sumStats(undefined)).toBe('0.0000');
  });

  it('parseResults interpreta la forma esperada y marca la que no entiende', () => {
    expect(parseResults([{ indicator: 'actions:lead', values: [{ value: '9' }] }])).toEqual({
      value: '9',
      indicator: 'actions:lead',
      unparsed: false,
    });
    expect(parseResults(undefined)).toEqual({ value: null, indicator: null, unparsed: false });
    expect(parseResults({ raro: true })).toMatchObject({ value: null, unparsed: true });
  });
});

describe('fechas locales de la cuenta', () => {
  it('el día depende de la zona horaria de la cuenta', () => {
    const at = new Date('2026-10-23T23:30:00Z');
    expect(localDate('Europe/Madrid', at)).toBe('2026-10-24');
    expect(localDate('America/Mexico_City', at)).toBe('2026-10-23');
  });

  it('aritmética de días, meses y división de rangos', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthRange('2026-10-23', 1)).toEqual({ since: '2026-09-01', until: '2026-09-30' });
    expect(monthRange('2026-03-15', 1)).toEqual({ since: '2026-02-01', until: '2026-02-28' });
    expect(splitRange('2026-10-01', '2026-10-28')).toEqual([
      ['2026-10-01', '2026-10-14'],
      ['2026-10-15', '2026-10-28'],
    ]);
    expect(splitRange('2026-10-01', '2026-10-01')).toBeNull();
  });
});

describe('toInsightRow', () => {
  const ctx = {
    tenantId: 't',
    adAccountId: 'a',
    metaAccountId: 'act_9',
    currency: 'EUR',
    level: 'campaign' as const,
    today: '2026-10-23',
    syncRunId: 1,
    fetchedAt: new Date(),
  };

  it('extrae columnas canónicas, marca madurez y firmeza, y conserva el crudo', () => {
    const row = toInsightRow(
      {
        campaign_id: '777',
        date_start: '2026-10-20',
        spend: '12.3456',
        impressions: '1000',
        reach: '800',
        clicks: '30',
        inline_link_clicks: '20',
        outbound_clicks: [{ action_type: 'outbound_click', value: '15' }],
        actions: [{ action_type: 'lead', value: '2' }],
        attribution_setting: '7d_click_1d_view',
      },
      ctx,
    );
    expect(row).toMatchObject({
      entityMetaId: '777',
      spend: '12.3456',
      impressions: 1000,
      outboundClicks: 15,
      leads: '2',
      purchases: '0',
      isFinal: false,
      dataFlags: ['immature'],
      results: null,
    });
    expect(toInsightRow({ campaign_id: '777', date_start: '2026-09-01' }, ctx)).toMatchObject({
      isFinal: true,
      dataFlags: [],
      spend: null, // no disponible, nunca 0
    });
    expect(
      toInsightRow({ date_start: '2026-09-01' }, { ...ctx, level: 'account' }).entityMetaId,
    ).toBe('act_9');
  });
});

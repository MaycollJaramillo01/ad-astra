import { expect, it } from 'vitest';
import { createSanitizer } from './sanitize.ts';

const real = {
  data: [
    {
      id: '23851234567890',
      account_id: 'act_9876543210',
      name: 'Cliente Real · Black Friday',
      campaign_id: '23851234567890',
      spend: '1000.00',
      impressions: '123456',
      action_values: [{ action_type: 'purchase', value: '200.00' }],
      actions: [{ action_type: 'purchase', value: '7' }],
      thumbnail_url: 'https://scontent.example/img.jpg',
      objective: 'OUTCOME_SALES',
      promoted_object: { page_id: '9876543210', whatsapp_phone_number: '+15550000123' },
    },
  ],
  paging: { next: 'https://graph.facebook.com/v26.0/act_1/x?access_token=EAAsecret' },
};

it('elimina nombres, URLs, paginación y credenciales, y mantiene la forma', () => {
  const out = JSON.stringify(createSanitizer().sanitize(real));
  for (const leak of [
    'Cliente Real',
    'scontent',
    'EAAsecret',
    '23851234567890',
    '9876543210',
    'paging',
    '+15550000123',
  ]) {
    expect(out).not.toContain(leak);
  }
  expect(out).toContain('OUTCOME_SALES');
});

it('asigna IDs ficticios estables y escala solo los importes', () => {
  const [row] = (createSanitizer().sanitize(real) as typeof real).data;
  expect(row?.id).toBe(row?.campaign_id); // el mismo ID real recibe el mismo ID ficticio
  expect(row?.account_id).toMatch(/^act_\d+$/);
  expect(row?.spend).toBe('370.00');
  expect(row?.action_values[0]?.value).toBe('74.00');
  expect(row?.actions[0]?.value).toBe('7'); // los conteos no se alteran
  expect(row?.impressions).toBe('123456'); // ni las métricas numéricas en string
});

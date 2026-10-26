// Sanitiza respuestas reales de Meta antes de guardarlas como fixtures (docs/TESTING.md §3).
// Conserva la forma de los datos; elimina textos, nombres, URLs y credenciales; sustituye los IDs
// por valores ficticios estables y escala los importes. La revisión manual sigue siendo obligatoria.

const DROP = new Set([
  'access_token',
  'token',
  'name',
  'title',
  'body',
  'message',
  'link',
  'url_tags',
  'thumbnail_url',
  'image_url',
  'object_story_spec',
  'asset_feed_spec',
  'targeting',
  'extra_data',
  'account_name',
  'campaign_name',
  'adset_name',
  'ad_name',
  'object_name',
  'actor_name',
  'application_name',
  'whatsapp_phone_number',
]);
const MONEY = new Set([
  'spend',
  'amount_spent',
  'balance',
  'spend_cap',
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
  'bid_amount',
  'daily_min_spend_target',
  'daily_spend_cap',
]);
const SCALE = 0.37;
// Las métricas también llegan como strings numéricos ("impressions": "123456"): solo se tratan
// como ID las claves id / *_id y los valores act_…
const isId = (key: string, v: string) =>
  key === 'id' || key.endsWith('_id') || v.startsWith('act_');

function scale(v: unknown): unknown {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return v;
  const scaled = (n * SCALE).toFixed(2);
  return typeof v === 'string' ? scaled : Number(scaled);
}

export function createSanitizer() {
  const ids = new Map<string, string>();
  const fakeId = (real: string) => {
    let fake = ids.get(real);
    if (!fake) {
      fake = `${real.startsWith('act_') ? 'act_' : ''}${100000 + ids.size + 1}`;
      ids.set(real, fake);
    }
    return fake;
  };

  function walk(value: unknown, key = '', parent = ''): unknown {
    if (Array.isArray(value)) return value.map((v) => walk(v, key, parent));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === 'paging') continue; // las URLs de paginación llevan el token
        if (DROP.has(k)) {
          out[k] = '[sanitized]';
          continue;
        }
        out[k] = walk(v, k, key);
      }
      return out;
    }
    if (typeof value === 'string') {
      if (isId(key, value)) return fakeId(value);
      if (MONEY.has(key) || (key === 'value' && parent === 'action_values')) return scale(value);
      if (/https?:\/\//.test(value)) return '[sanitized-url]';
    }
    if (typeof value === 'number' && MONEY.has(key)) return scale(value);
    return value;
  }

  return { sanitize: (value: unknown) => walk(value) };
}

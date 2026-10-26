import { z } from 'zod';
import { ActionSnapshot, type Preview, type Snapshot } from '../../action-contracts.ts';
import type { Db } from '../../db/client.ts';
import type { actions, adAccounts, metaConnections } from '../../db/schema.ts';
import type { Config } from '../../platform/config.ts';
import type { TokenCipher } from '../../platform/crypto.ts';
import { badRequest, forbidden } from '../../platform/errors.ts';
import { createMetaClient, MetaApiError } from '../meta/client.ts';
import { createGovernor, createMetaSession } from '../meta/governor.ts';
import { openConnectionToken } from '../meta/sync.ts';

export type ActionRow = typeof actions.$inferSelect;
export interface WriteContext {
  account: typeof adAccounts.$inferSelect;
  connection: typeof metaConnections.$inferSelect;
}
export interface ActionGateway {
  inspect(ctx: WriteContext, action: ActionRow, readOnly?: boolean): Promise<Snapshot>;
  beforeWrite(ctx: WriteContext): Promise<void>;
  write(ctx: WriteContext, action: ActionRow, preview: Preview): Promise<void>;
}
const Raw = z.object({
  id: z.string(),
  account_id: z.string().optional(),
  status: z.string(),
  effective_status: z.string(),
  daily_budget: z.string().optional(),
  lifetime_budget: z.string().optional(),
  is_budget_schedule_enabled: z.boolean().optional(),
  campaign_id: z.string().optional(),
  adset_id: z.string().optional(),
  end_time: z.string().optional(),
  stop_time: z.string().optional(),
});
const Account = z.object({
  id: z.string(),
  currency: z.string(),
  timezone_name: z.string(),
  account_status: z.number(),
  user_tasks: z.array(z.string()),
});

/** Solo el ejecutor llama write. Inspección y verificación siempre usan GET; nada de validate_only
 * por POST en el preview, para mantener una frontera de escritura inequívoca. */
export function createActionGateway(opts: {
  db: Db;
  config: Config;
  cipher: TokenCipher;
  fetch?: typeof fetch;
}): ActionGateway {
  const { config } = opts;
  const governor = createGovernor(opts.db, config.META_APP_ID ?? 'disabled');
  const clientFor = (ctx: WriteContext) => {
    if (!config.META_APP_ID || !config.META_APP_SECRET)
      throw badRequest('Meta no está configurado.');
    const c = ctx.connection;
    const token = openConnectionToken(opts.cipher, c);
    return {
      token,
      client: createMetaClient({
        accessToken: token,
        appSecret: config.META_APP_SECRET,
        fetch: opts.fetch,
      }),
    };
  };
  return {
    async inspect(ctx, a, readOnly = false) {
      const { token, client } = clientFor(ctx);
      const appClient = createMetaClient({
        accessToken: `${config.META_APP_ID}|${config.META_APP_SECRET}`,
        appSecret: config.META_APP_SECRET as string,
        fetch: opts.fetch,
      });
      const debug = createMetaSession({
        client: appClient,
        governor,
        metaAccountId: ctx.account.metaAccountId,
      });
      const { body: d } = await debug.get<{
        data: {
          is_valid: boolean;
          app_id: string;
          scopes: string[];
          expires_at?: number;
          data_access_expires_at?: number;
        };
      }>('/debug_token', { input_token: token });
      if (
        !d.data?.is_valid ||
        d.data.app_id !== config.META_APP_ID ||
        !(readOnly
          ? d.data.scopes?.some((s) => s === 'ads_read' || s === 'ads_management')
          : d.data.scopes?.includes('ads_management')) ||
        [d.data.expires_at, d.data.data_access_expires_at].some((t) => t && t * 1000 <= Date.now())
      )
        throw forbidden('El token no tiene ads_management vigente para esta app.');
      const session = createMetaSession({
        client,
        governor,
        metaAccountId: ctx.account.metaAccountId,
      });
      const { body: rawAccount } = await session.get<unknown>(`/${ctx.account.metaAccountId}`, {
        fields: 'id,currency,timezone_name,account_status,user_tasks',
      });
      const account = Account.parse(rawAccount);
      if (
        account.id !== ctx.account.metaAccountId ||
        (!readOnly && account.account_status !== 1) ||
        !account.user_tasks.some((t) =>
          (readOnly ? ['MANAGE', 'ADVERTISE', 'ANALYZE'] : ['MANAGE', 'ADVERTISE']).includes(t),
        )
      )
        throw forbidden('La cuenta no está activa o el token no tiene ADVERTISE/MANAGE.');
      if (
        account.currency !== ctx.account.currency ||
        account.timezone_name !== ctx.account.timezoneName
      )
        throw badRequest(
          'La moneda o zona horaria cambió: sincroniza la cuenta antes de continuar.',
        );
      const read = async (id: string, level: string) => {
        const fields = [
          'id',
          'account_id',
          'status',
          'effective_status',
          ...(level === 'ad'
            ? ['campaign_id', 'adset_id']
            : [
                'daily_budget',
                'lifetime_budget',
                'is_budget_schedule_enabled',
                level === 'adset' ? 'end_time' : 'stop_time',
                ...(level === 'adset' ? ['campaign_id'] : []),
              ]),
        ];
        const { body } = await session.get<unknown>(`/${id}`, { fields: fields.join(',') });
        const r = Raw.parse(body);
        if (r.id !== id || r.account_id !== ctx.account.metaAccountId.slice(4))
          throw forbidden('La entidad no pertenece a la cuenta autorizada.');
        return r;
      };
      const r = await read(a.entityMetaId, a.entityLevel);
      const parent = r.campaign_id ? await read(r.campaign_id, 'campaign') : null;
      const adset = r.adset_id ? await read(r.adset_id, 'adset') : null;
      if (adset && adset.campaign_id !== r.campaign_id)
        throw forbidden('Jerarquía de entidades inconsistente.');
      return ActionSnapshot.parse({
        id: r.id,
        accountId: account.id,
        status: r.status,
        effectiveStatus: r.effective_status,
        dailyBudget: r.daily_budget ?? '0',
        lifetimeBudget: r.lifetime_budget ?? '0',
        scheduleEnabled: r.is_budget_schedule_enabled ?? false,
        campaignId: r.campaign_id ?? null,
        adsetId: r.adset_id ?? null,
        parentDailyBudget: parent?.daily_budget ?? '0',
        parentLifetimeBudget: parent?.lifetime_budget ?? '0',
        parentStatus: parent?.status ?? null,
        adsetStatus: adset?.status ?? null,
        adsetDailyBudget: adset?.daily_budget ?? '0',
        adsetLifetimeBudget: adset?.lifetime_budget ?? '0',
        endTime: r.end_time ?? r.stop_time ?? null,
        currency: account.currency,
        timezone: account.timezone_name,
      });
    },
    async beforeWrite(ctx) {
      const blocked = await governor.blocked([
        governor.key.app,
        governor.key.account(ctx.account.metaAccountId),
      ]);
      if (blocked) throw blocked;
    },
    async write(ctx, a, p) {
      const { client } = clientFor(ctx);
      const response = await client
        .post<{ success?: boolean }>(`/${a.entityMetaId}`, {
          [p.field]: p.after,
        })
        .catch(async (err) => {
          if (err instanceof MetaApiError)
            await governor.fromApiError(err, ctx.account.metaAccountId);
          throw err;
        });
      await governor.observe(response.usage, ctx.account.metaAccountId);
      if (response.body.success !== true)
        throw new Error('Meta no confirmó el resultado: reconciliación obligatoria.');
    },
  };
}

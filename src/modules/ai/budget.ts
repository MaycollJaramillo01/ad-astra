import { eq, inArray, sql } from 'drizzle-orm';
import { type Db, type Tx, withContext } from '../../db/client.ts';
import { llmBudgetHolds, llmUsage } from '../../db/schema.ts';
import type { Config } from '../../platform/config.ts';
import type { TenantContext } from '../../platform/http.ts';
import { assertSideEffects } from '../../platform/operations.ts';

export const lockBudget = (tx: Tx, tenantId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`llm-budget:${tenantId}`},0))`);
export async function reserveBudget(db: Db, ctx: TenantContext, config: Config, amount: number) {
  return withContext(db, ctx, async (tx) => {
    await lockBudget(tx, ctx.tenantId);
    await assertSideEffects(tx, config, ctx.tenantId);
    const [spent] = await tx
      .select({
        month: sql<string>`coalesce(sum(cost_usd) filter(where created_at>=date_trunc('month',now() at time zone 'utc') at time zone 'utc'),0)`,
        day: sql<string>`coalesce(sum(cost_usd) filter(where user_id=${ctx.userId} and created_at>=date_trunc('day',now() at time zone 'utc') at time zone 'utc'),0)`,
      })
      .from(llmUsage);
    const [holds] = await tx
      .select({
        month: sql<string>`coalesce(sum(amount_usd),0)`,
        day: sql<string>`coalesce(sum(amount_usd) filter(where user_id=${ctx.userId}),0)`,
      })
      .from(llmBudgetHolds)
      .where(inArray(llmBudgetHolds.status, ['reserved', 'unknown']));
    if (
      Number(spent?.month ?? 0) + Number(holds?.month ?? 0) + amount >
        config.AI_MONTHLY_BUDGET_USD ||
      Number(spent?.day ?? 0) + Number(holds?.day ?? 0) + amount > config.AI_USER_DAILY_BUDGET_USD
    )
      return null;
    const [hold] = await tx
      .insert(llmBudgetHolds)
      .values({ tenantId: ctx.tenantId, userId: ctx.userId, amountUsd: amount.toFixed(6) })
      .returning();
    return hold?.id ?? null;
  });
}
export async function settleHold(tx: Tx, id: string, unknown: boolean) {
  await tx
    .update(llmBudgetHolds)
    .set({ status: unknown ? 'unknown' : 'settled', updatedAt: new Date() })
    .where(eq(llmBudgetHolds.id, id));
}

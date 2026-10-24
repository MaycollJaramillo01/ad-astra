ALTER TABLE "insights_daily" ADD COLUMN "campaign_meta_id" text;--> statement-breakpoint
ALTER TABLE "insights_daily" ADD COLUMN "adset_meta_id" text;--> statement-breakpoint
CREATE INDEX "insights_daily_campaign" ON "insights_daily" USING btree ("tenant_id","campaign_meta_id","level","date");--> statement-breakpoint
CREATE INDEX "insights_daily_adset" ON "insights_daily" USING btree ("tenant_id","adset_meta_id","level","date");
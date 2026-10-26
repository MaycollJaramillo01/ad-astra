CREATE TABLE "budget_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_meta_id" text NOT NULL,
	"kpi_field" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"start_date" date NOT NULL,
	"burn_in_days" integer NOT NULL,
	"base_daily_spend" numeric(20, 4) NOT NULL,
	"levels" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"seed" integer NOT NULL,
	"observed" jsonb,
	"power" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	CONSTRAINT "budget_experiments_status_check" CHECK ("budget_experiments"."status" in ('planned', 'cancelled')),
	CONSTRAINT "budget_experiments_burn_in_check" CHECK ("budget_experiments"."burn_in_days" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "budget_experiments" ADD CONSTRAINT "budget_experiments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_experiments" ADD CONSTRAINT "budget_experiments_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_experiments_account" ON "budget_experiments" USING btree ("tenant_id","ad_account_id");
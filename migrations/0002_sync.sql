CREATE TABLE "ads" (
	"tenant_id" uuid NOT NULL,
	"meta_id" text NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"adset_meta_id" text NOT NULL,
	"campaign_meta_id" text NOT NULL,
	"creative_meta_id" text,
	"name" text NOT NULL,
	"status" text,
	"effective_status" text,
	"issues_info" jsonb,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ads_tenant_id_meta_id_pk" PRIMARY KEY("tenant_id","meta_id")
);
--> statement-breakpoint
CREATE TABLE "adsets" (
	"tenant_id" uuid NOT NULL,
	"meta_id" text NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_meta_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"effective_status" text,
	"optimization_goal" text,
	"billing_event" text,
	"bid_strategy" text,
	"bid_amount_minor" bigint,
	"daily_budget_minor" bigint,
	"lifetime_budget_minor" bigint,
	"destination_type" text,
	"promoted_object" jsonb,
	"attribution_spec" jsonb,
	"learning_stage_info" jsonb,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "adsets_tenant_id_meta_id_pk" PRIMARY KEY("tenant_id","meta_id")
);
--> statement-breakpoint
CREATE TABLE "insights_daily" (
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"level" text NOT NULL,
	"entity_meta_id" text NOT NULL,
	"date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"attribution_setting" text,
	"spend" numeric(20, 4),
	"impressions" bigint,
	"reach" bigint,
	"clicks" bigint,
	"inline_link_clicks" bigint,
	"outbound_clicks" bigint,
	"results" numeric(20, 4),
	"result_indicator" text,
	"leads" numeric(20, 4),
	"purchases" numeric(20, 4),
	"purchase_value" numeric(20, 4),
	"messaging_conversations" numeric(20, 4),
	"app_installs" numeric(20, 4),
	"landing_page_views" numeric(20, 4),
	"thruplays" numeric(20, 4),
	"actions" jsonb,
	"action_values" jsonb,
	"results_raw" jsonb,
	"quality_ranking" text,
	"engagement_rate_ranking" text,
	"conversion_rate_ranking" text,
	"extraction_version" integer NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"data_flags" text[] DEFAULT '{}' NOT NULL,
	"sync_run_id" bigint NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "insights_daily_tenant_id_level_entity_meta_id_date_pk" PRIMARY KEY("tenant_id","level","entity_meta_id","date"),
	CONSTRAINT "insights_daily_level_check" CHECK ("insights_daily"."level" in ('account', 'campaign', 'adset', 'ad'))

) PARTITION BY RANGE ("date");  -- editado a mano: particionado mensual (ADR-009)
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recurring_every_seconds" integer,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "meta_rate_state" (
	"scope" text PRIMARY KEY NOT NULL,
	"blocked_until" timestamp with time zone,
	"last_usage" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid,
	"connection_id" uuid,
	"kind" text NOT NULL,
	"api_version" text NOT NULL,
	"window_start" date,
	"window_end" date,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"error_code" integer,
	"error_subcode" integer,
	"error_message" text,
	"job_id" bigint,
	CONSTRAINT "sync_runs_kind_check" CHECK ("sync_runs"."kind" in ('token_validation', 'discovery', 'entities', 'insights_incremental', 'insights_restatement', 'insights_backfill')),
	CONSTRAINT "sync_runs_status_check" CHECK ("sync_runs"."status" in ('running', 'succeeded', 'partial', 'failed', 'throttled'))
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "backfill_months" integer DEFAULT 13 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "last_discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "last_entities_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "last_insights_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adsets" ADD CONSTRAINT "adsets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adsets" ADD CONSTRAINT "adsets_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_daily" ADD CONSTRAINT "insights_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_daily" ADD CONSTRAINT "insights_daily_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenant_id_connection_id_meta_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."meta_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ads_account" ON "ads" USING btree ("tenant_id","ad_account_id");--> statement-breakpoint
CREATE INDEX "adsets_account" ON "adsets" USING btree ("tenant_id","ad_account_id");--> statement-breakpoint
CREATE INDEX "insights_daily_account_level_date" ON "insights_daily" USING btree ("tenant_id","ad_account_id","level","date");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_active" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("run_after") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "sync_runs_account_started" ON "sync_runs" USING btree ("tenant_id","ad_account_id","started_at");--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_backfill_check" CHECK ("ad_accounts"."backfill_months" between 0 and 37);
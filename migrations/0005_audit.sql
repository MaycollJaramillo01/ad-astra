CREATE TABLE "audit_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"config" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_configs_scope" UNIQUE NULLS NOT DISTINCT("tenant_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finding_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"audit_run_id" bigint,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_events_event_check" CHECK ("finding_events"."event" in ('opened', 'updated', 'resolved', 'reopened', 'decided')),
	CONSTRAINT "finding_events_actor_check" CHECK ("finding_events"."actor_type" in ('system', 'user'))
);
--> statement-breakpoint
CREATE TABLE "health_scores" (
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"entity_level" text NOT NULL,
	"entity_meta_id" text NOT NULL,
	"date" date NOT NULL,
	"formula_version" text NOT NULL,
	"profile" text NOT NULL,
	"window_days" integer NOT NULL,
	"score" numeric(5, 2),
	"grade" text NOT NULL,
	"confidence" numeric(4, 3),
	"coverage" numeric(4, 3) NOT NULL,
	"components" jsonb NOT NULL,
	"audit_run_id" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_scores_tenant_id_entity_level_entity_meta_id_date_formula_version_pk" PRIMARY KEY("tenant_id","entity_level","entity_meta_id","date","formula_version"),
	CONSTRAINT "health_scores_grade_check" CHECK ("health_scores"."grade" in ('excellent', 'good', 'attention', 'critical', 'insufficient')),
	CONSTRAINT "health_scores_score_check" CHECK ("health_scores"."score" is null or "health_scores"."score" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "as_of" date;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "recommendation_text" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "profile" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "explanation" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "window_start" date;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "window_end" date;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "last_audit_run_id" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "clear_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_configs" ADD CONSTRAINT "audit_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_configs" ADD CONSTRAINT "audit_configs_tenant_id_client_id_clients_tenant_id_id_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_tenant_id_finding_id_findings_tenant_id_id_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_events_finding" ON "finding_events" USING btree ("tenant_id","finding_id","at");--> statement-breakpoint
CREATE INDEX "health_scores_account_date" ON "health_scores" USING btree ("tenant_id","ad_account_id","date");
CREATE TABLE "action_followups" (
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"plan" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_followups_tenant_id_action_id_pk" PRIMARY KEY("tenant_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "monitoring_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"digest_key" text NOT NULL,
	"incident_ids" uuid[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"provider_id" text,
	"error" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_deliveries_digest" UNIQUE("tenant_id","ad_account_id","user_id","channel","digest_key"),
	CONSTRAINT "monitoring_deliveries_channel" CHECK ("monitoring_deliveries"."channel" in ('in_app', 'email')),
	CONSTRAINT "monitoring_deliveries_status" CHECK ("monitoring_deliveries"."status" in ('queued', 'sending', 'sent', 'cancelled', 'unknown', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "monitoring_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "monitoring_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"incident_id" uuid,
	"actor_id" uuid,
	"event" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitoring_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"entity_level" text NOT NULL,
	"entity_meta_id" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"episode" integer DEFAULT 1 NOT NULL,
	"policy_revision" integer NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"clear_count" integer DEFAULT 0 NOT NULL,
	"last_observation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"snoozed_until" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_incidents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "monitoring_incidents_fingerprint" UNIQUE("tenant_id","ad_account_id","fingerprint"),
	CONSTRAINT "monitoring_incidents_status" CHECK ("monitoring_incidents"."status" in ('pending', 'open', 'acknowledged', 'snoozed', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "monitoring_policies" (
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"authorized_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_policies_tenant_id_ad_account_id_pk" PRIMARY KEY("tenant_id","ad_account_id")
);
--> statement-breakpoint
CREATE TABLE "monitoring_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"period_key" text,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_reports_period" UNIQUE("tenant_id","ad_account_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "monitoring_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"policy_revision" integer NOT NULL,
	"input_hash" text NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_followups" ADD CONSTRAINT "action_followups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_followups" ADD CONSTRAINT "action_followups_tenant_id_action_id_actions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_followups" ADD CONSTRAINT "action_followups_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_deliveries" ADD CONSTRAINT "monitoring_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_deliveries" ADD CONSTRAINT "monitoring_deliveries_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_events" ADD CONSTRAINT "monitoring_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_events" ADD CONSTRAINT "monitoring_events_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_events" ADD CONSTRAINT "monitoring_events_tenant_id_incident_id_monitoring_incidents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."monitoring_incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_incidents" ADD CONSTRAINT "monitoring_incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_incidents" ADD CONSTRAINT "monitoring_incidents_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_policies" ADD CONSTRAINT "monitoring_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_policies" ADD CONSTRAINT "monitoring_policies_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_reports" ADD CONSTRAINT "monitoring_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_reports" ADD CONSTRAINT "monitoring_reports_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_runs" ADD CONSTRAINT "monitoring_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_runs" ADD CONSTRAINT "monitoring_runs_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitoring_deliveries_account" ON "monitoring_deliveries" USING btree ("tenant_id","ad_account_id","created_at");--> statement-breakpoint
CREATE INDEX "monitoring_incidents_account" ON "monitoring_incidents" USING btree ("tenant_id","ad_account_id","status");--> statement-breakpoint
CREATE INDEX "monitoring_runs_account" ON "monitoring_runs" USING btree ("tenant_id","ad_account_id","created_at");
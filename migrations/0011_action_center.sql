ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_id" UNIQUE("tenant_id","id");
--> statement-breakpoint
CREATE TABLE "action_approvals" (
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"preview_hash" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_approvals_action_id_preview_hash_user_id_pk" PRIMARY KEY("action_id","preview_hash","user_id")
);
--> statement-breakpoint
CREATE TABLE "action_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "action_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_policies" (
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"recommendation_id" uuid,
	"rollback_of" uuid,
	"entity_level" text NOT NULL,
	"entity_meta_id" text NOT NULL,
	"operation" text NOT NULL,
	"desired" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"proposed_by" uuid NOT NULL,
	"preview" jsonb,
	"after" jsonb,
	"result" text,
	"error" text,
	"dispatch_at" timestamp with time zone,
	"reserved_at" timestamp with time zone,
	"confirmed_write" boolean DEFAULT false NOT NULL,
	"verification_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "actions_idempotency" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "actions_state_check" CHECK ("actions"."state" in ('proposed', 'review', 'approved', 'executing', 'verifying', 'failed', 'closed')),
	CONSTRAINT "actions_operation_check" CHECK ("actions"."operation" in ('pause', 'activate', 'set_daily_budget', 'set_lifetime_budget')),
	CONSTRAINT "actions_level_check" CHECK ("actions"."entity_level" in ('campaign', 'adset', 'ad'))
);
--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_tenant_id_action_id_actions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_tenant_id_action_id_actions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_policies" ADD CONSTRAINT "action_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_policies" ADD CONSTRAINT "action_policies_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_recommendation_id_recommendations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","recommendation_id") REFERENCES "public"."recommendations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_rollback_of_actions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rollback_of") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_events_action" ON "action_events" USING btree ("tenant_id","action_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_recommendation" ON "actions" USING btree ("tenant_id","recommendation_id") WHERE "actions"."rollback_of" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "actions_rollback" ON "actions" USING btree ("tenant_id","rollback_of");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_one_pending_target" ON "actions" USING btree ("tenant_id","ad_account_id","entity_meta_id") WHERE "actions"."state" <> 'closed';--> statement-breakpoint

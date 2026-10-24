CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"client_id" uuid,
	"meta_account_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"timezone_name" text NOT NULL,
	"account_status" integer NOT NULL,
	"user_tasks" text[] DEFAULT '{}' NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ad_accounts_tenant_meta" UNIQUE("tenant_id","meta_account_id"),
	CONSTRAINT "ad_accounts_meta_id_check" CHECK ("ad_accounts"."meta_account_id" ~ '^act_[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "audit_log_actor_check" CHECK ("audit_log"."actor_type" in ('user', 'system', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "audit_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"data_as_of" timestamp with time zone NOT NULL,
	"engine_version" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "audit_runs_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "audit_runs_trigger_check" CHECK ("audit_runs"."trigger" in ('post_sync', 'manual', 'scheduled')),
	CONSTRAINT "audit_runs_status_check" CHECK ("audit_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"tenant_id" uuid NOT NULL,
	"meta_id" text NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"objective" text,
	"status" text,
	"effective_status" text,
	"daily_budget_minor" bigint,
	"lifetime_budget_minor" bigint,
	"advantage_state" text,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "campaigns_tenant_id_meta_id_pk" PRIMARY KEY("tenant_id","meta_id")
);
--> statement-breakpoint
CREATE TABLE "client_assignments" (
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "client_assignments_tenant_id_client_id_user_id_pk" PRIMARY KEY("tenant_id","client_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "client_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scope" text[] NOT NULL,
	"granted_by_name" text NOT NULL,
	"granted_by_email" text NOT NULL,
	"evidence_ref" text,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_consents_scope_check" CHECK ("client_consents"."scope" <@ array['read_insights','ai_processing','write_status','write_budget']::text[] and cardinality("client_consents"."scope") > 0)
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offboarded_at" timestamp with time zone,
	CONSTRAINT "clients_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "clients_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "clients_status_check" CHECK ("clients"."status" in ('active', 'paused', 'offboarded'))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"audit_run_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"entity_level" text NOT NULL,
	"entity_meta_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"priority" numeric NOT NULL,
	"impact" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"recommendation_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	CONSTRAINT "findings_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "findings_kind_check" CHECK ("findings"."kind" in ('audit', 'alert')),
	CONSTRAINT "findings_level_check" CHECK ("findings"."entity_level" in ('account', 'campaign', 'adset', 'ad')),
	CONSTRAINT "findings_severity_check" CHECK ("findings"."severity" in ('info', 'low', 'medium', 'high', 'critical')),
	CONSTRAINT "findings_status_check" CHECK ("findings"."status" in ('open', 'acknowledged', 'snoozed', 'dismissed', 'resolved')),
	CONSTRAINT "findings_confidence_check" CHECK ("findings"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role" in ('owner', 'admin', 'manager', 'analyst', 'viewer')),
	CONSTRAINT "invitations_email_lower" CHECK ("invitations"."email" = lower("invitations"."email"))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('owner', 'admin', 'manager', 'analyst', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "meta_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"meta_app_id" text NOT NULL,
	"meta_business_id" text,
	"token_ciphertext" "bytea" NOT NULL,
	"token_nonce" "bytea" NOT NULL,
	"token_key_version" integer NOT NULL,
	"token_fingerprint" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error_code" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_connections_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "meta_connections_kind_check" CHECK ("meta_connections"."kind" in ('system_user', 'user', 'business_integration')),
	CONSTRAINT "meta_connections_status_check" CHECK ("meta_connections"."status" in ('pending', 'active', 'invalid', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"finding_id" uuid,
	"entity_level" text NOT NULL,
	"entity_meta_id" text NOT NULL,
	"action_type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"expected_impact" jsonb,
	"source" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	CONSTRAINT "recommendations_action_check" CHECK ("recommendations"."action_type" in ('pause', 'activate', 'set_daily_budget', 'set_lifetime_budget', 'review')),
	CONSTRAINT "recommendations_source_check" CHECK ("recommendations"."source" in ('rule', 'ai', 'user')),
	CONSTRAINT "recommendations_status_check" CHECK ("recommendations"."status" in ('open', 'accepted', 'dismissed', 'applied', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_tenant_id_connection_id_meta_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."meta_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_tenant_id_client_id_clients_tenant_id_id_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_tenant_id_client_id_clients_tenant_id_id_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_tenant_id_user_id_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_tenant_id_client_id_clients_tenant_id_id_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_tenant_id_audit_run_id_audit_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","audit_run_id") REFERENCES "public"."audit_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_auth_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_ad_account_id_ad_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ad_account_id") REFERENCES "public"."ad_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_finding_id_findings_tenant_id_id_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "campaigns_account" ON "campaigns" USING btree ("tenant_id","ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_one_open" ON "findings" USING btree ("tenant_id","fingerprint") WHERE "findings"."status" in ('open', 'acknowledged', 'snoozed');--> statement-breakpoint
CREATE INDEX "findings_account_status" ON "findings" USING btree ("tenant_id","ad_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "recommendations_account_status" ON "recommendations" USING btree ("tenant_id","ad_account_id","status");
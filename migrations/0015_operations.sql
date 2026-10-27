CREATE TABLE "deployment_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"environment" text DEFAULT 'unbound' NOT NULL,
	"schema_version" integer DEFAULT 16 NOT NULL,
	"recovery_mode" boolean DEFAULT true NOT NULL,
	"worker_started_at" timestamp with time zone,
	"worker_finished_at" timestamp with time zone,
	"backup_at" timestamp with time zone,
	"restore_drill_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_singleton" CHECK ("deployment_state"."id"=1)
);
--> statement-breakpoint
CREATE TABLE "llm_budget_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_hold_positive" CHECK ("llm_budget_holds"."amount_usd">=0),
	CONSTRAINT "llm_hold_status" CHECK ("llm_budget_holds"."status" in ('reserved', 'settled', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "technical_incidents" (
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technical_incidents_tenant_id_code_pk" PRIMARY KEY("tenant_id","code"),
	CONSTRAINT "technical_incident_status" CHECK ("technical_incidents"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "access_hash" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_budget_holds" ADD CONSTRAINT "llm_budget_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_incidents" ADD CONSTRAINT "technical_incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_holds_tenant_status" ON "llm_budget_holds" USING btree ("tenant_id","status");
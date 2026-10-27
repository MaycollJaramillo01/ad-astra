ALTER TABLE "deployment_state" ALTER COLUMN "schema_version" SET DEFAULT 17;--> statement-breakpoint
ALTER TABLE "deployment_state" ADD COLUMN "read_only_mode" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "deployment_state" SET "schema_version"=17,"updated_at"=now() WHERE "id"=1;

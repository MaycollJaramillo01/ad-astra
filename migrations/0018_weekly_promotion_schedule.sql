ALTER TABLE "actions" DROP CONSTRAINT "actions_operation_check";--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_operation_check" CHECK ("actions"."operation" in ('pause', 'activate', 'set_daily_budget', 'set_lifetime_budget', 'set_weekly_schedule'));
--> statement-breakpoint
ALTER TABLE "deployment_state" ALTER COLUMN "schema_version" SET DEFAULT 18;
--> statement-breakpoint
UPDATE "deployment_state" SET "schema_version"=18,"updated_at"=now() WHERE "id"=1;

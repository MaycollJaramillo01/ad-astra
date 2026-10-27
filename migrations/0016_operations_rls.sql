ALTER TABLE llm_budget_holds ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE llm_budget_holds FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON llm_budget_holds USING (tenant_id=app_tenant_id()) WITH CHECK (tenant_id=app_tenant_id());--> statement-breakpoint
ALTER TABLE technical_incidents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE technical_incidents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON technical_incidents USING (tenant_id=app_tenant_id()) WITH CHECK (tenant_id=app_tenant_id());--> statement-breakpoint
INSERT INTO deployment_state(id,schema_version,environment,recovery_mode) VALUES(1,16,'unbound',true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON deployment_state FROM app_rw;--> statement-breakpoint
GRANT UPDATE(worker_started_at,worker_finished_at,updated_at) ON deployment_state TO app_rw;
--> statement-breakpoint
CREATE FUNCTION enforce_job_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='running' AND NEW.status<>'running' AND OLD.lease_id IS NOT NULL AND NEW.lease_id IS NOT NULL THEN
    RAISE EXCEPTION 'Lease must be acknowledged by the current worker' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER enforce_job_fence BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION enforce_job_fence();

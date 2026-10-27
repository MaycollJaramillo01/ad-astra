DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['monitoring_policies','monitoring_incidents','monitoring_events','monitoring_runs','monitoring_reports','monitoring_deliveries','action_followups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON monitoring_events, monitoring_runs, monitoring_reports FROM app_rw;--> statement-breakpoint
CREATE FUNCTION monitoring_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Monitoring history is immutable' USING ERRCODE = '42501'; END $$;--> statement-breakpoint
CREATE TRIGGER immutable_monitoring_events BEFORE UPDATE OR DELETE ON monitoring_events FOR EACH ROW EXECUTE FUNCTION monitoring_history_immutable();--> statement-breakpoint
CREATE TRIGGER immutable_monitoring_runs BEFORE UPDATE OR DELETE ON monitoring_runs FOR EACH ROW EXECUTE FUNCTION monitoring_history_immutable();--> statement-breakpoint
CREATE TRIGGER immutable_monitoring_reports BEFORE UPDATE OR DELETE ON monitoring_reports FOR EACH ROW EXECUTE FUNCTION monitoring_history_immutable();--> statement-breakpoint
CREATE FUNCTION followup_plan_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.plan IS DISTINCT FROM NEW.plan OR OLD.action_id IS DISTINCT FROM NEW.action_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.ad_account_id IS DISTINCT FROM NEW.ad_account_id OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Followup baseline is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER immutable_followup_plan BEFORE UPDATE ON action_followups FOR EACH ROW EXECUTE FUNCTION followup_plan_immutable();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON action_followups FROM app_rw;

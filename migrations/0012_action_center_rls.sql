-- Políticas de tenant y bitácoras solo de inserción (el propietario conserva DDL para mantenimiento).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['actions','action_policies','action_approvals','action_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON action_events, action_approvals FROM app_rw;--> statement-breakpoint
CREATE FUNCTION action_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Action history is immutable' USING ERRCODE = '42501'; END $$;--> statement-breakpoint
CREATE TRIGGER immutable_action_events BEFORE UPDATE OR DELETE ON action_events FOR EACH ROW EXECUTE FUNCTION action_history_immutable();--> statement-breakpoint
CREATE TRIGGER immutable_action_approvals BEFORE UPDATE OR DELETE ON action_approvals FOR EACH ROW EXECUTE FUNCTION action_history_immutable();

-- Aislamiento del motor de auditoría (ADR-007). Como app_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['health_scores', 'audit_configs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t
    );
  END LOOP;
END $$;--> statement-breakpoint

-- finding_events es un historial: se inserta y se lee, nunca se cambia ni se borra (como audit_log).
ALTER TABLE finding_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE finding_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY finding_events_select ON finding_events FOR SELECT USING (tenant_id = app_tenant_id());--> statement-breakpoint
CREATE POLICY finding_events_insert ON finding_events FOR INSERT WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON finding_events FROM app_rw;

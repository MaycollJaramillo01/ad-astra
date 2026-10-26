-- Aislamiento de los experimentos de presupuesto (ADR-007). Como app_owner. La API no los borra:
-- se cancelan y el diseño queda como registro.

ALTER TABLE budget_experiments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE budget_experiments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON budget_experiments
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

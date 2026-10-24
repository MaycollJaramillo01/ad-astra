-- Aislamiento multi-tenant (ADR-007, docs/DATABASE_SCHEMA.md §4). Se ejecuta como app_owner.
-- El contexto lo fija la aplicación por transacción (src/db/client.ts: withContext). Sin
-- contexto, las funciones devuelven null y ninguna política deja ver ni escribir filas.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user_email() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_email', true), '') $$;--> statement-breakpoint

-- Tablas de un tenant con la política estándar: solo filas del tenant del contexto.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clients', 'client_assignments', 'client_consents', 'meta_connections', 'ad_accounts',
    'campaigns', 'audit_runs', 'findings', 'recommendations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t
    );
  END LOOP;
END $$;--> statement-breakpoint

-- tenants: cada usuario ve las organizaciones de las que es miembro (para elegir la activa);
-- solo se crea o modifica la del contexto; no hay política de borrado.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenants_select ON tenants FOR SELECT
  USING (id = app_tenant_id() OR id IN (SELECT tenant_id FROM memberships WHERE user_id = app_user_id()));--> statement-breakpoint
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (id = app_tenant_id());--> statement-breakpoint
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());--> statement-breakpoint

-- memberships: gestión dentro del tenant; además cada usuario lee las suyas (en todos sus tenants).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
CREATE POLICY memberships_own ON memberships FOR SELECT USING (user_id = app_user_id());--> statement-breakpoint

-- invitations: gestión dentro del tenant; el invitado lee sus invitaciones pendientes al entrar.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
CREATE POLICY invitations_own ON invitations FOR SELECT
  USING (email = app_user_email() AND accepted_at IS NULL AND revoked_at IS NULL);--> statement-breakpoint

-- audit_log: solo inserción. Se lee el del tenant; los eventos de plataforma (tenant null)
-- no los lee nadie desde la aplicación.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (tenant_id = app_tenant_id());--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id IS NOT DISTINCT FROM app_tenant_id());--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_rw;

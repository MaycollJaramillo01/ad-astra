-- Aislamiento y particiones de la sincronización (ADR-007, ADR-009, ADR-022). Como app_owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['adsets', 'ads', 'sync_runs', 'insights_daily'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t
    );
  END LOOP;
END $$;--> statement-breakpoint

-- Particiones mensuales de insights_daily: de 2023-01 (37 meses de historia de Meta) a
-- 2028-12, más una por defecto para que ninguna fila falle. El RLS vive en la tabla madre: a las
-- particiones se les retiran los privilegios para que app_rw no pueda leerlas directamente.
-- ponytail: rango fijo; antes de 2028 añadir particiones en una migración (TD-14).
DO $$
DECLARE
  m date := date '2023-01-01';
  part text;
BEGIN
  WHILE m < date '2029-01-01' LOOP
    part := format('insights_daily_%s', to_char(m, 'YYYY_MM'));
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF insights_daily FOR VALUES FROM (%L) TO (%L)',
      part, m, (m + interval '1 month')::date
    );
    EXECUTE format('REVOKE ALL ON %I FROM app_rw', part);
    m := (m + interval '1 month')::date;
  END LOOP;
  CREATE TABLE insights_daily_default PARTITION OF insights_daily DEFAULT;
  REVOKE ALL ON insights_daily_default FROM app_rw;
END $$;

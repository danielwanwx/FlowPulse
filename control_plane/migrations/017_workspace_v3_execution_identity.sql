-- Stable public Incident identity and mutable current Temporal execution
-- pointer. Physical execution generations are append-only; only the pointer
-- advances through an application-level compare-and-swap transaction.

CREATE TABLE incident_execution_identities_v3 (
  tenant_id TEXT NOT NULL,
  incident_run_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  temporal_workflow_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, incident_run_id),
  UNIQUE (tenant_id, case_id),
  UNIQUE (tenant_id, temporal_workflow_id)
);

CREATE TABLE temporal_execution_generations_v3 (
  tenant_id TEXT NOT NULL,
  incident_run_id TEXT NOT NULL,
  temporal_generation INTEGER NOT NULL CHECK (temporal_generation > 0),
  temporal_workflow_id TEXT NOT NULL,
  temporal_run_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, incident_run_id, temporal_generation),
  UNIQUE (tenant_id, temporal_workflow_id, temporal_run_id),
  FOREIGN KEY (tenant_id, incident_run_id)
    REFERENCES incident_execution_identities_v3 (tenant_id, incident_run_id)
);

CREATE TABLE temporal_execution_pointers_v3 (
  tenant_id TEXT NOT NULL,
  incident_run_id TEXT NOT NULL,
  temporal_generation INTEGER NOT NULL CHECK (temporal_generation > 0),
  temporal_workflow_id TEXT NOT NULL,
  temporal_run_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, incident_run_id),
  UNIQUE (tenant_id, temporal_workflow_id),
  FOREIGN KEY (tenant_id, incident_run_id, temporal_generation)
    REFERENCES temporal_execution_generations_v3
      (tenant_id, incident_run_id, temporal_generation)
);

CREATE TRIGGER incident_execution_identities_v3_append_only
  BEFORE UPDATE OR DELETE ON incident_execution_identities_v3
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

CREATE TRIGGER temporal_execution_generations_v3_append_only
  BEFORE UPDATE OR DELETE ON temporal_execution_generations_v3
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'incident_execution_identities_v3',
    'temporal_execution_generations_v3',
    'temporal_execution_pointers_v3'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON incident_execution_identities_v3,
  temporal_execution_generations_v3 TO flowpulse_cp_app;
GRANT SELECT, INSERT, UPDATE ON temporal_execution_pointers_v3
  TO flowpulse_cp_app;

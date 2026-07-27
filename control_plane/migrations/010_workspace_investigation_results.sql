-- Temporal-owned Investigate synthesis/critic records and the atomic Decide
-- projection transition. Provider candidates are append-only records; only
-- the final transition table carries accepted lifecycle truth.

CREATE TABLE workspace_investigation_stage_records (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SYNTHESIS','CRITIC')),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, record_id),
  UNIQUE (tenant_id, workflow_run_id, record_id),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);

CREATE TABLE workspace_investigation_transitions (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  source_action_idempotency_key TEXT NOT NULL,
  result_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, transition_key),
  UNIQUE (tenant_id, result_id),
  UNIQUE (tenant_id, run_id, topology_revision, projection_revision),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id),
  FOREIGN KEY (tenant_id, case_id, source_action_idempotency_key)
    REFERENCES workspace_action_transitions (tenant_id, case_id, idempotency_key)
);

CREATE TRIGGER workspace_investigation_stage_records_append_only
  BEFORE UPDATE OR DELETE ON workspace_investigation_stage_records
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER workspace_investigation_transitions_append_only
  BEFORE UPDATE OR DELETE ON workspace_investigation_transitions
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_investigation_stage_records',
    'workspace_investigation_transitions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON workspace_investigation_stage_records,
  workspace_investigation_transitions TO flowpulse_cp_app;

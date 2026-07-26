-- Additive Incident Workspace projection schema. 001/002 remain immutable baselines.

CREATE TABLE incident_run_bindings (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, run_id, topology_revision),
  UNIQUE (tenant_id, case_id, workflow_id, workflow_run_id),
  UNIQUE (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id),
  FOREIGN KEY (tenant_id, case_id, case_revision)
    REFERENCES incident_cases (tenant_id, case_id, case_revision)
);

CREATE TABLE incident_projections (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, run_id, topology_revision, projection_revision),
  UNIQUE (tenant_id, run_id, topology_revision, sequence),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);

CREATE INDEX incident_projections_current_idx
  ON incident_projections (tenant_id, case_id, created_at DESC);

CREATE TABLE incident_projection_events (
  event_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, run_id, topology_revision, sequence),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);

CREATE INDEX incident_projection_events_resume_idx
  ON incident_projection_events (tenant_id, case_id, sequence);

CREATE TABLE node_explanations (
  explanation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  component_id TEXT NOT NULL,
  conversation_schema_version TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, run_id, projection_revision, component_id, conversation_schema_version),
  UNIQUE (tenant_id, selection_key),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);

CREATE TABLE workspace_evidence_bindings (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, topology_revision, evidence_id),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id),
  FOREIGN KEY (tenant_id, case_id, case_revision, evidence_id)
    REFERENCES evidence_envelopes (tenant_id, case_id, case_revision, evidence_id)
);

CREATE OR REPLACE FUNCTION incident_workspace_append_only() RETURNS trigger
SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'incident_workspace_records_are_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER incident_run_bindings_append_only
  BEFORE UPDATE OR DELETE ON incident_run_bindings
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER incident_projections_append_only
  BEFORE UPDATE OR DELETE ON incident_projections
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER incident_projection_events_append_only
  BEFORE UPDATE OR DELETE ON incident_projection_events
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER node_explanations_append_only
  BEFORE UPDATE OR DELETE ON node_explanations
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER workspace_evidence_bindings_append_only
  BEFORE UPDATE OR DELETE ON workspace_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'incident_run_bindings','incident_projections','incident_projection_events',
    'node_explanations','workspace_evidence_bindings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON incident_run_bindings, incident_projections, incident_projection_events,
  node_explanations, workspace_evidence_bindings TO flowpulse_cp_app;

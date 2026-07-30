-- Temporal-owned V2 read projections, ordered events, signals, pulses,
-- citations, and exact source-event transition receipts.

CREATE TABLE incident_realtime_projections (
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
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  connector_revision INTEGER NOT NULL CHECK (connector_revision > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, run_id, topology_revision, projection_revision),
  UNIQUE (tenant_id, run_id, topology_revision, sequence),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id,
               case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings
      (tenant_id, incident_id, run_id, topology_revision, case_id,
       case_revision, workflow_id, workflow_run_id)
);

CREATE INDEX incident_realtime_projections_current_idx
  ON incident_realtime_projections (tenant_id, case_id, projection_revision DESC);

CREATE TABLE incident_realtime_events (
  event_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, run_id, topology_revision, sequence),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id,
               case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings
      (tenant_id, incident_id, run_id, topology_revision, case_id,
       case_revision, workflow_id, workflow_run_id)
);

CREATE INDEX incident_realtime_events_resume_idx
  ON incident_realtime_events (tenant_id, case_id, sequence);

CREATE TABLE realtime_signal_records (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, record_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id)
);

CREATE TABLE realtime_graph_pulses (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, record_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id)
);

CREATE TABLE realtime_citations (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, record_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id)
);

CREATE TABLE incident_realtime_transitions (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, transition_key),
  UNIQUE (tenant_id, source_event_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id, run_id)
    REFERENCES connector_source_events
      (tenant_id, source_event_id, case_id, run_id),
  FOREIGN KEY (tenant_id, dispatch_id)
    REFERENCES connector_dispatch_outbox (tenant_id, dispatch_id)
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'incident_realtime_projections',
    'incident_realtime_events',
    'realtime_signal_records',
    'realtime_graph_pulses',
    'realtime_citations',
    'incident_realtime_transitions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only()',
      table_name || '_append_only', table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON incident_realtime_projections,
  incident_realtime_events, realtime_signal_records, realtime_graph_pulses,
  realtime_citations, incident_realtime_transitions TO flowpulse_cp_app;

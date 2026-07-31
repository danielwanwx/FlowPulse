-- V3 restart-safe OTel cursors, durable freshness timers, and typed metric
-- points. All rows are append-only; current state is the greatest revision.

CREATE TABLE otel_spool_cursors (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  cursor_revision INTEGER NOT NULL CHECK (cursor_revision > 0),
  byte_offset BIGINT NOT NULL CHECK (byte_offset >= 0),
  line_number BIGINT NOT NULL CHECK (line_number >= 0),
  file_identity TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, stream_id, cursor_revision),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id)
);

CREATE INDEX otel_spool_cursors_latest_idx
  ON otel_spool_cursors
  (tenant_id, connector_id, stream_id, cursor_revision DESC);

CREATE TABLE realtime_freshness_deadlines (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  deadline_revision INTEGER NOT NULL CHECK (deadline_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('ARMED','EXPIRED','RECOVERED')),
  deadline TIMESTAMPTZ NOT NULL,
  source_event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, connector_id, deadline_revision),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id)
);

CREATE INDEX realtime_freshness_deadlines_due_idx
  ON realtime_freshness_deadlines
  (tenant_id, state, deadline, deadline_revision DESC);

CREATE TABLE realtime_metric_points (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  point_sequence INTEGER NOT NULL CHECK (point_sequence > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  metric_key TEXT NOT NULL,
  component_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, series_id, source_event_id),
  UNIQUE (tenant_id, case_id, series_id, point_sequence),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id)
);

CREATE INDEX realtime_metric_points_series_idx
  ON realtime_metric_points
  (tenant_id, case_id, series_id, observed_at DESC);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'otel_spool_cursors',
    'realtime_freshness_deadlines',
    'realtime_metric_points'
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

GRANT SELECT, INSERT ON otel_spool_cursors,
  realtime_freshness_deadlines, realtime_metric_points TO flowpulse_cp_app;

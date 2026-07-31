-- Durable, append-only V3 guided workflow read model. Temporal owns command
-- ordering; this schema provides the transactional projection/event/idempotency
-- boundary and retains every attempt and stage-run revision for audit.

CREATE TABLE incident_workflow_projections_v3 (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, projection_revision),
  UNIQUE (tenant_id, case_id, sequence)
);

CREATE TABLE incident_workflow_attempt_revisions_v3 (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  parent_attempt_id TEXT,
  payload JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, attempt_id, projection_revision),
  FOREIGN KEY (tenant_id, case_id, projection_revision)
    REFERENCES incident_workflow_projections_v3
      (tenant_id, case_id, projection_revision)
);

CREATE TABLE incident_workflow_stage_run_revisions_v3 (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  run_number INTEGER NOT NULL CHECK (run_number > 0),
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  payload JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, stage_run_id, projection_revision),
  FOREIGN KEY (tenant_id, case_id, attempt_id, projection_revision)
    REFERENCES incident_workflow_attempt_revisions_v3
      (tenant_id, case_id, attempt_id, projection_revision)
);

CREATE TABLE incident_workflow_events_v3 (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  event_id TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, sequence),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, case_id, projection_revision)
    REFERENCES incident_workflow_projections_v3
      (tenant_id, case_id, projection_revision)
);

CREATE TABLE incident_workflow_commands_v3 (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_hash CHAR(64) NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  command_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, idempotency_key),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, case_id, projection_revision)
    REFERENCES incident_workflow_projections_v3
      (tenant_id, case_id, projection_revision)
);

CREATE TABLE incident_workflow_realtime_syncs_v3 (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sync_key TEXT NOT NULL,
  sync_hash CHAR(64) NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  payload JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, sync_key),
  FOREIGN KEY (tenant_id, case_id, projection_revision)
    REFERENCES incident_workflow_projections_v3
      (tenant_id, case_id, projection_revision)
);

CREATE TABLE incident_workflow_live_outbox_v3 (
  -- Live cursors are contiguous within a tenant. A global sequence would
  -- create tenant-visible gaps whenever another tenant emits an event.
  live_sequence BIGINT NOT NULL CHECK (live_sequence > 0),
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  payload JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, live_sequence),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, case_id, projection_revision)
    REFERENCES incident_workflow_projections_v3
      (tenant_id, case_id, projection_revision)
);

CREATE INDEX incident_workflow_events_v3_cursor_idx
  ON incident_workflow_events_v3 (tenant_id, case_id, sequence);
CREATE INDEX incident_workflow_attempt_v3_latest_idx
  ON incident_workflow_attempt_revisions_v3
    (tenant_id, case_id, attempt_id, projection_revision DESC);
CREATE INDEX incident_workflow_stage_run_v3_latest_idx
  ON incident_workflow_stage_run_revisions_v3
    (tenant_id, case_id, stage_run_id, projection_revision DESC);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'incident_workflow_projections_v3',
    'incident_workflow_attempt_revisions_v3',
    'incident_workflow_stage_run_revisions_v3',
    'incident_workflow_events_v3',
    'incident_workflow_commands_v3',
    'incident_workflow_realtime_syncs_v3',
    'incident_workflow_live_outbox_v3'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only()',
      table_name, table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON
  incident_workflow_projections_v3,
  incident_workflow_attempt_revisions_v3,
  incident_workflow_stage_run_revisions_v3,
  incident_workflow_events_v3,
  incident_workflow_commands_v3,
  incident_workflow_realtime_syncs_v3,
  incident_workflow_live_outbox_v3
TO flowpulse_cp_app;

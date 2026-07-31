-- One transactional outbox record for every Gate 1 action activity.
-- The payload binds the exact command hash and activity identity to the
-- projection, lease/cards, receipt, and ledger event that were committed.

CREATE TABLE workspace_action_transitions (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action_id TEXT NOT NULL,
  activity_identity TEXT NOT NULL,
  command_fingerprint CHAR(64) NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, idempotency_key),
  UNIQUE (tenant_id, workflow_run_id, activity_identity, command_fingerprint),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);

CREATE INDEX workspace_action_transitions_command_idx
  ON workspace_action_transitions (tenant_id, case_id, command_fingerprint);

CREATE TRIGGER workspace_action_transitions_append_only
  BEFORE UPDATE OR DELETE ON workspace_action_transitions
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

ALTER TABLE workspace_action_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_action_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_action_transitions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON workspace_action_transitions TO flowpulse_cp_app;

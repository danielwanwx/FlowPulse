-- Temporal-derived Gate 1 leases and server-generated action cards.
-- Records are append-only projections; no HTTP route may mutate them directly.

CREATE TABLE workspace_gate1_leases (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_revision INTEGER NOT NULL CHECK (lease_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','REVOKED','EXPIRED')),
  consumed_by_activity_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, lease_id, lease_revision),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);
CREATE INDEX workspace_gate1_leases_current_idx
  ON workspace_gate1_leases (tenant_id, case_id, lease_id, lease_revision DESC);

CREATE TABLE next_best_actions (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  card_version INTEGER NOT NULL CHECK (card_version > 0),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  action_revision INTEGER NOT NULL CHECK (action_revision > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, action_id, card_version),
  UNIQUE (tenant_id, action_id),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);
CREATE INDEX next_best_actions_case_idx ON next_best_actions (tenant_id, case_id, expires_at DESC);

CREATE TABLE workspace_action_receipts (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, idempotency_key),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
    REFERENCES incident_run_bindings (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id)
);

CREATE TRIGGER workspace_gate1_leases_append_only
  BEFORE UPDATE OR DELETE ON workspace_gate1_leases
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER next_best_actions_append_only
  BEFORE UPDATE OR DELETE ON next_best_actions
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER workspace_action_receipts_append_only
  BEFORE UPDATE OR DELETE ON workspace_action_receipts
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_gate1_leases','next_best_actions','workspace_action_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON workspace_gate1_leases, next_best_actions, workspace_action_receipts TO flowpulse_cp_app;

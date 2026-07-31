-- Append-only delivery state for the connector-to-Temporal outbox.  The base
-- outbox fact remains immutable; retries advance only by adding a revision.

CREATE TABLE connector_dispatch_revisions (
  tenant_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('PENDING','DISPATCHED','ACCEPTED','REJECTED')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  receipt_id TEXT,
  transition_key TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, dispatch_id, state_revision),
  FOREIGN KEY (tenant_id, dispatch_id)
    REFERENCES connector_dispatch_outbox (tenant_id, dispatch_id)
);

CREATE UNIQUE INDEX connector_dispatch_revisions_terminal_transition
  ON connector_dispatch_revisions (tenant_id, transition_key)
  WHERE transition_key IS NOT NULL;

CREATE TRIGGER connector_dispatch_revisions_append_only
  BEFORE UPDATE OR DELETE ON connector_dispatch_revisions
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

ALTER TABLE connector_dispatch_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_dispatch_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_dispatch_revisions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON connector_dispatch_revisions TO flowpulse_cp_app;

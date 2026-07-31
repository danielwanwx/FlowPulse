-- Immutable connector deliveries, normalized source facts, server cursors,
-- reconciliation records, and the durable Temporal dispatch outbox.

CREATE TABLE connector_delivery_receipts (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  raw_content_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED','DUPLICATE','CONFLICTED','REJECTED')),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, provider_event_id),
  UNIQUE (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id)
);

CREATE TABLE connector_source_events (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  normalization_hash CHAR(64) NOT NULL,
  raw_content_hash CHAR(64) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, source_event_id),
  UNIQUE (tenant_id, connector_id, provider_event_id),
  UNIQUE (tenant_id, normalization_hash),
  UNIQUE (tenant_id, source_event_id, case_id),
  UNIQUE (tenant_id, source_event_id, case_id, run_id),
  FOREIGN KEY (tenant_id, connector_id, provider_event_id)
    REFERENCES connector_delivery_receipts
      (tenant_id, connector_id, provider_event_id),
  FOREIGN KEY (tenant_id, binding_id, binding_revision)
    REFERENCES external_identity_bindings
      (tenant_id, binding_id, binding_revision),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id)
    REFERENCES incident_run_bindings
      (tenant_id, incident_id, run_id, topology_revision, case_id)
);

CREATE TABLE connector_poll_cursors (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  cursor_revision INTEGER NOT NULL CHECK (cursor_revision > 0),
  cursor_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, cursor_revision),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id)
);

CREATE TABLE connector_reconciliation_runs (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, reconciliation_id),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id)
);

CREATE TABLE connector_dispatch_outbox (
  tenant_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','DISPATCHED','ACCEPTED','REJECTED')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, dispatch_id),
  UNIQUE (tenant_id, source_event_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id, run_id)
    REFERENCES connector_source_events
      (tenant_id, source_event_id, case_id, run_id)
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connector_delivery_receipts',
    'connector_source_events',
    'connector_poll_cursors',
    'connector_reconciliation_runs',
    'connector_dispatch_outbox'
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

GRANT SELECT, INSERT ON connector_delivery_receipts, connector_source_events,
  connector_poll_cursors, connector_reconciliation_runs,
  connector_dispatch_outbox TO flowpulse_cp_app;

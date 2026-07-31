-- Phase 1A server-owned connector registrations, revisioned identity bindings,
-- and append-only health observations. Credentials and endpoint URLs are not
-- stored in these browser-readable records.

ALTER TABLE incident_run_bindings
  ADD CONSTRAINT incident_run_bindings_realtime_identity_unique
  UNIQUE (tenant_id, incident_id, run_id, topology_revision, case_id);

CREATE TABLE connector_registrations (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('PROMETHEUS','OTEL')),
  enabled BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, connector_id)
);

CREATE TABLE external_identity_bindings (
  tenant_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  connector_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('PROMETHEUS','OTEL')),
  case_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, binding_id, binding_revision),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id),
  FOREIGN KEY (tenant_id, incident_id, run_id, topology_revision, case_id)
    REFERENCES incident_run_bindings
      (tenant_id, incident_id, run_id, topology_revision, case_id)
);

CREATE TABLE connector_health_snapshots (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  health_revision INTEGER NOT NULL CHECK (health_revision > 0),
  state TEXT NOT NULL CHECK (
    state IN ('CONNECTED','DEGRADED','STALE','UNAVAILABLE','MISCONFIGURED','DISABLED')
  ),
  checked_at TIMESTAMPTZ NOT NULL,
  fresh_until TIMESTAMPTZ,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, connector_id, health_revision),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connector_registrations (tenant_id, connector_id)
);

CREATE TRIGGER connector_registrations_append_only
  BEFORE UPDATE OR DELETE ON connector_registrations
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER external_identity_bindings_append_only
  BEFORE UPDATE OR DELETE ON external_identity_bindings
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();
CREATE TRIGGER connector_health_snapshots_append_only
  BEFORE UPDATE OR DELETE ON connector_health_snapshots
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connector_registrations',
    'external_identity_bindings',
    'connector_health_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON connector_registrations, external_identity_bindings,
  connector_health_snapshots TO flowpulse_cp_app;

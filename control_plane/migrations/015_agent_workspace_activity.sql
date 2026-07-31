-- Append-only Monitor/Triage activity records. Phase 1 is read-only and
-- external_write_performed is rejected by the strict payload contract.

CREATE TABLE realtime_agent_activities (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL CHECK (
    COALESCE((payload->>'external_write_performed')::boolean, false) = false
  ),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, record_id),
  FOREIGN KEY (tenant_id, source_event_id, case_id)
    REFERENCES connector_source_events (tenant_id, source_event_id, case_id)
);

CREATE TRIGGER realtime_agent_activities_append_only
  BEFORE UPDATE OR DELETE ON realtime_agent_activities
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

ALTER TABLE realtime_agent_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_agent_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON realtime_agent_activities
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON realtime_agent_activities TO flowpulse_cp_app;

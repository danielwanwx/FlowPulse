-- Workspace command authorization is independent of evidence availability.
-- Only the Temporal initializer may append the creating subject's grant.

CREATE TABLE workspace_subject_grants (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, subject_id),
  FOREIGN KEY (tenant_id, case_id)
    REFERENCES incident_run_bindings (tenant_id, case_id)
);

CREATE TRIGGER workspace_subject_grants_append_only
  BEFORE UPDATE OR DELETE ON workspace_subject_grants
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

ALTER TABLE workspace_subject_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subject_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_subject_grants
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON workspace_subject_grants TO flowpulse_cp_app;

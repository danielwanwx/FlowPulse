-- Forward-only authorization schema. Safe to apply to an existing 001 volume.
CREATE TABLE IF NOT EXISTS auth_command_intents (
  intent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL,
  workflow_run_id TEXT NOT NULL,
  proposal_id TEXT,
  approval_id TEXT,
  subject_id TEXT NOT NULL,
  roles JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','MINTED')),
  expires_at TIMESTAMPTZ NOT NULL,
  minted_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id, case_revision)
    REFERENCES incident_cases (tenant_id, case_id, case_revision)
);

CREATE TABLE IF NOT EXISTS auth_assertion_consumptions (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  key_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL,
  workflow_run_id TEXT NOT NULL,
  proposal_id TEXT,
  approval_id TEXT,
  subject_id TEXT NOT NULL,
  roles JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id, case_revision)
    REFERENCES incident_cases (tenant_id, case_id, case_revision)
);

CREATE INDEX IF NOT EXISTS auth_command_intents_scope_idx
  ON auth_command_intents (tenant_id, case_id, workflow_run_id, status);

ALTER TABLE auth_command_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_command_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth_command_intents;
CREATE POLICY tenant_isolation ON auth_command_intents
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE auth_assertion_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_assertion_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth_assertion_consumptions;
CREATE POLICY tenant_isolation ON auth_assertion_consumptions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON auth_command_intents TO flowpulse_cp_app;
GRANT SELECT, INSERT ON auth_assertion_consumptions TO flowpulse_cp_app;

-- P0 durable projection schema. Temporal alone advances workflow state.
CREATE TABLE incident_cases (
  case_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, state TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, case_id, case_revision), UNIQUE (tenant_id, case_id)
);
CREATE TABLE case_events (
  event_id UUID PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, event_type TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL, activity_id TEXT NOT NULL, stage TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workflow_run_id, activity_id, stage, sequence),
  FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE TABLE evidence_envelopes (
  evidence_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, case_revision INTEGER NOT NULL,
  acl_subjects JSONB NOT NULL CHECK (jsonb_typeof(acl_subjects) = 'array' AND jsonb_array_length(acl_subjects) > 0),
  proof_scope TEXT NOT NULL CHECK (proof_scope IN ('CURRENT_OBSERVATION','REFERENCE_ONLY')),
  source_uri TEXT NOT NULL, source_anchor TEXT NOT NULL, content_hash CHAR(64) NOT NULL, independence_key TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (
    proof_scope <> 'CURRENT_OBSERVATION' OR (
      payload->>'freshness' = 'CURRENT' AND payload->>'authority' IN ('T0_AUTHORITATIVE_CURRENT','T1_DIRECT_CURRENT')
    )
  ), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_id, case_revision, evidence_id),
  FOREIGN KEY (tenant_id, case_id, case_revision) REFERENCES incident_cases (tenant_id, case_id, case_revision)
);
CREATE TABLE claim_records (
  claim_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, case_revision INTEGER NOT NULL,
  evidence_ids JSONB NOT NULL,
  status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_id, case_revision, claim_id),
  FOREIGN KEY (tenant_id, case_id, case_revision) REFERENCES incident_cases (tenant_id, case_id, case_revision)
);
CREATE TABLE claim_evidence_links (
  claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL,
  PRIMARY KEY (claim_id, evidence_id),
  FOREIGN KEY (tenant_id, case_id, case_revision, claim_id)
    REFERENCES claim_records (tenant_id, case_id, case_revision, claim_id),
  FOREIGN KEY (tenant_id, case_id, case_revision, evidence_id)
    REFERENCES evidence_envelopes (tenant_id, case_id, case_revision, evidence_id)
);
CREATE TABLE hypothesis_records (
  hypothesis_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE TABLE coverage_entries (
  entry_id UUID PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, field TEXT NOT NULL, status TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE TABLE conflict_records (
  conflict_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE TABLE investigator_assignments (
  assignment_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, payload JSONB NOT NULL,
  dispatched_at TIMESTAMPTZ NOT NULL, FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE TABLE tool_calls (
  tool_call_id UUID PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, activity_id TEXT NOT NULL,
  capability TEXT NOT NULL, status TEXT NOT NULL, request_hash CHAR(64) NOT NULL, response_artifact_key TEXT,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE TABLE knowledge_revisions (
  knowledge_revision_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
  supersedes_revision_id TEXT, status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_id, revision), UNIQUE (tenant_id, knowledge_revision_id),
  FOREIGN KEY (tenant_id, supersedes_revision_id) REFERENCES knowledge_revisions (tenant_id, knowledge_revision_id)
);
CREATE OR REPLACE FUNCTION knowledge_supersession_is_monotonic() RETURNS trigger AS $$
DECLARE prior_document TEXT; prior_revision INTEGER;
BEGIN
  IF NEW.supersedes_revision_id IS NOT NULL THEN
    SELECT document_id, revision INTO prior_document, prior_revision
      FROM knowledge_revisions WHERE tenant_id = NEW.tenant_id AND knowledge_revision_id = NEW.supersedes_revision_id;
    IF prior_document IS NULL OR prior_document <> NEW.document_id OR NEW.revision <= prior_revision THEN
      RAISE EXCEPTION 'knowledge_supersession_requires_same_document_and_increasing_revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_supersession_guard BEFORE INSERT OR UPDATE ON knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION knowledge_supersession_is_monotonic();
CREATE TABLE remediation_proposals (
  proposal_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, case_revision INTEGER NOT NULL,
  repair_contract_hash CHAR(64) NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id, case_revision) REFERENCES incident_cases (tenant_id, case_id, case_revision)
);
CREATE TABLE owner_approvals (
  approval_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL, repair_contract_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id, case_revision) REFERENCES incident_cases (tenant_id, case_id, case_revision)
);
CREATE TABLE verification_reports (
  verification_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, case_revision INTEGER NOT NULL,
  workflow_run_id TEXT NOT NULL, verifier_identity TEXT NOT NULL,
  decision TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id, case_revision) REFERENCES incident_cases (tenant_id, case_id, case_revision)
);
CREATE TABLE action_executions (
  execution_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
  repair_contract_hash CHAR(64) NOT NULL, idempotency_key TEXT NOT NULL, result TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A raw idempotency key may never be rebound to a different tenant/case/
  -- proposal/contract. The composite key makes the intended binding explicit.
  UNIQUE (idempotency_key),
  UNIQUE (tenant_id, case_id, proposal_id, repair_contract_hash, idempotency_key),
  FOREIGN KEY (tenant_id, case_id) REFERENCES incident_cases (tenant_id, case_id)
);
CREATE INDEX case_events_case_time_idx ON case_events (tenant_id, case_id, occurred_at);
CREATE INDEX evidence_case_tenant_idx ON evidence_envelopes (tenant_id, case_id, case_revision);

-- No tenant session value means deny. Every tenant-bearing table is FORCE RLS.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'incident_cases','case_events','evidence_envelopes','claim_records','claim_evidence_links','hypothesis_records',
    'coverage_entries','conflict_records','investigator_assignments','tool_calls','knowledge_revisions','remediation_proposals',
    'owner_approvals','verification_reports','action_executions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END $$;

-- Evidence read/write is additionally subject-scoped. Repository calls set
-- app.subject_id transaction-locally and still validate the same ACL in code.
DROP POLICY tenant_isolation ON evidence_envelopes;
CREATE POLICY evidence_tenant_subject_acl ON evidence_envelopes
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND acl_subjects ? current_setting('app.subject_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND acl_subjects ? current_setting('app.subject_id', true)
  );

-- The Compose application/worker use this non-owner role so FORCE RLS is
-- exercised in local integration runs as well as in deployment. The bootstrap
-- role remains available to Temporal only; it is never the control-plane
-- connection principal.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowpulse_cp_app') THEN
    CREATE ROLE flowpulse_cp_app LOGIN PASSWORD 'flowpulse-cp-local-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO flowpulse_cp_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO flowpulse_cp_app;

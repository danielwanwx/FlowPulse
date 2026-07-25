-- FlowPulse P0 Postgres durable projections. Temporal history remains the
-- sole workflow-transition authority; activities only persist audit records.
CREATE TABLE IF NOT EXISTS incident_cases (
  case_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  workflow_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, state TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, case_id, case_revision)
);
CREATE TABLE IF NOT EXISTS case_events (
  event_id UUID PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id),
  tenant_id TEXT NOT NULL, event_type TEXT NOT NULL, payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS case_events_case_time_idx ON case_events (tenant_id, case_id, occurred_at);
CREATE TABLE IF NOT EXISTS evidence_envelopes (
  evidence_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id),
  tenant_id TEXT NOT NULL, case_revision INTEGER NOT NULL,
  proof_scope TEXT NOT NULL CHECK (proof_scope IN ('CURRENT_OBSERVATION', 'REFERENCE_ONLY')),
  source_uri TEXT NOT NULL, source_anchor TEXT NOT NULL, content_hash CHAR(64) NOT NULL,
  independence_key TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_case_tenant_idx ON evidence_envelopes (tenant_id, case_id, case_revision);
CREATE TABLE IF NOT EXISTS claim_records (
  claim_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  evidence_ids JSONB NOT NULL, status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hypothesis_records (
  hypothesis_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS coverage_entries (
  case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  field TEXT NOT NULL, status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conflict_records (
  conflict_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS investigator_assignments (
  assignment_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL, dispatched_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id UUID PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  activity_id TEXT NOT NULL, capability TEXT NOT NULL, status TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
  response_artifact_key TEXT, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS knowledge_revisions (
  knowledge_revision_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL,
  revision INTEGER NOT NULL, status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_id, revision)
);
CREATE TABLE IF NOT EXISTS owner_approvals (
  approval_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  repair_contract_hash CHAR(64) NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_reports (
  verification_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  verifier_identity TEXT NOT NULL, decision TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS action_executions (
  execution_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES incident_cases(case_id), tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, result TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (tenant_id, idempotency_key)
);
ALTER TABLE incident_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_revisions ENABLE ROW LEVEL SECURITY;

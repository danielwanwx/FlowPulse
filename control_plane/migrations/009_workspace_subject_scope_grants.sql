-- 005 subject membership is immutable.  008 intentionally left legacy
-- memberships permissionless, so current trusted authorization must be
-- recorded as a revisioned successor rather than an UPDATE of that history.

CREATE TABLE workspace_subject_scope_grants (
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
  roles JSONB NOT NULL CHECK (jsonb_typeof(roles) = 'array'),
  permissions JSONB NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, case_id, subject_id, scope_revision),
  FOREIGN KEY (tenant_id, case_id, subject_id)
    REFERENCES workspace_subject_grants (tenant_id, case_id, subject_id)
);

CREATE FUNCTION workspace_subject_scope_grants_revision_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_revision INTEGER;
BEGIN
  -- The per-subject transaction lock makes the first revision and all later
  -- revisions contiguous even when two trusted activities arrive together.
  PERFORM pg_advisory_xact_lock(hashtext(
    'workspace-subject-scope:' || NEW.tenant_id || ':' || NEW.case_id || ':' || NEW.subject_id
  ));
  SELECT scope_revision INTO latest_revision
    FROM workspace_subject_scope_grants
   WHERE tenant_id = NEW.tenant_id
     AND case_id = NEW.case_id
     AND subject_id = NEW.subject_id
   ORDER BY scope_revision DESC
   LIMIT 1
   FOR UPDATE;
  IF NEW.scope_revision <> COALESCE(latest_revision, 0) + 1 THEN
    RAISE EXCEPTION 'workspace_subject_scope_revision_not_contiguous';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_subject_scope_grants_revision_guard
  BEFORE INSERT ON workspace_subject_scope_grants
  FOR EACH ROW EXECUTE FUNCTION workspace_subject_scope_grants_revision_guard();

CREATE TRIGGER workspace_subject_scope_grants_append_only
  BEFORE UPDATE OR DELETE ON workspace_subject_scope_grants
  FOR EACH ROW EXECUTE FUNCTION incident_workspace_append_only();

-- Preserve the only nonempty scopes that 008 itself had already recorded.
-- A genuine 001–007 membership has the 008 empty defaults and deliberately
-- receives no inferred authorization; the next trusted Temporal command must
-- append its scope through the application boundary.
INSERT INTO workspace_subject_scope_grants
  (tenant_id, case_id, subject_id, scope_revision, roles, permissions, created_at)
SELECT tenant_id, case_id, subject_id, 1, roles, permissions, created_at
  FROM workspace_subject_grants
 WHERE jsonb_array_length(roles) > 0
   AND jsonb_array_length(permissions) > 0
ON CONFLICT (tenant_id, case_id, subject_id, scope_revision) DO NOTHING;

ALTER TABLE workspace_subject_scope_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subject_scope_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_subject_scope_grants
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON workspace_subject_scope_grants TO flowpulse_cp_app;

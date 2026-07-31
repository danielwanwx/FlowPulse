-- The trigger already serializes each subject with a transaction advisory
-- lock.  FOR UPDATE was redundant and required UPDATE privilege on an
-- append-only table, preventing the SELECT/INSERT-only application role from
-- appending any scope revision.

CREATE OR REPLACE FUNCTION workspace_subject_scope_grants_revision_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_revision INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(
    'workspace-subject-scope:' || NEW.tenant_id || ':' || NEW.case_id || ':' || NEW.subject_id
  ));
  SELECT scope_revision INTO latest_revision
    FROM workspace_subject_scope_grants
   WHERE tenant_id = NEW.tenant_id
     AND case_id = NEW.case_id
     AND subject_id = NEW.subject_id
   ORDER BY scope_revision DESC
   LIMIT 1;
  IF NEW.scope_revision <> COALESCE(latest_revision, 0) + 1 THEN
    RAISE EXCEPTION 'workspace_subject_scope_revision_not_contiguous';
  END IF;
  RETURN NEW;
END $$;

-- Stable public/internal workspace identity mappings.  001--003 are immutable.
-- A public run selects exactly one topology and exactly one case/Temporal run.

ALTER TABLE incident_run_bindings
  ADD CONSTRAINT incident_run_bindings_public_run_unique
    UNIQUE (tenant_id, run_id),
  ADD CONSTRAINT incident_run_bindings_case_unique
    UNIQUE (tenant_id, case_id),
  ADD CONSTRAINT incident_run_bindings_temporal_run_unique
    UNIQUE (tenant_id, workflow_id, workflow_run_id);

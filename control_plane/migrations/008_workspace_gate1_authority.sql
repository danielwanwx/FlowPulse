-- Durable Gate 1 subject authority. Existing grants remain intentionally
-- permissionless after upgrade; a current Temporal initializer must append a
-- fully scoped grant before a fresh-read lease can be issued.

ALTER TABLE workspace_subject_grants
  ADD COLUMN roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE workspace_subject_grants
  ADD CONSTRAINT workspace_subject_grants_roles_array CHECK (jsonb_typeof(roles) = 'array'),
  ADD CONSTRAINT workspace_subject_grants_permissions_array CHECK (jsonb_typeof(permissions) = 'array');

#!/bin/sh
# Forward-only migration runner.  Every forward SQL file and its ledger record
# commit in one database transaction; a failed session leaves neither behind.
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-flowpulse}"
PGDATABASE="${PGDATABASE:-flowpulse}"
export PGHOST PGPORT PGUSER PGDATABASE

psql_run() {
  psql -v ON_ERROR_STOP=1 "$@"
}

psql_run <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

files=""
expected=1
for file in "$MIGRATIONS_DIR"/[0-9][0-9][0-9]_*.sql; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  version="${name%%_*}"
  numeric="$(printf '%s' "$version" | sed 's/^0*//')"
  numeric="${numeric:-0}"
  if [ "$numeric" -ne "$expected" ]; then
    echo "migration_source_gap_or_invalid_filename:$name" >&2
    exit 1
  fi
  files="${files}${file}
"
  expected=$((expected + 1))
done

if [ -z "$files" ]; then
  echo "migration_source_empty" >&2
  exit 1
fi

checksum_for() {
  sha256sum "$1" | awk '{print $1}'
}

# The only ledgerless 002 state that this runner may adopt is the reviewed
# Contract Core baseline.  These hashes are the exact 001/002 objects at
# b7541d17f9f662bc23912c9dbd55244a336274a7; every other unrecorded schema
# remains a fail-closed partial migration.
LEGACY_001_SHA256="3a883df931642d8377e95f0eafea350e3cf09f6ff4be69a8fab423c128dc3d8d"
LEGACY_002_SHA256="d502e572f2e1affe23f2f68da0b6be45cfe1f46ab3260ced5a7c703ec0a17b4b"
LEGACY_001_002_CATALOG_SHA256="30627845f0655e8939cb88b38d126ddf5b53a63bff318fcca91965f304ae5290"

file_for_name() {
  target="$1"
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$(basename "$candidate")" = "$target" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done <<EOF
$files
EOF
  return 1
}

ledger_checksum() {
  psql -Atq -c "SELECT checksum_sha256 FROM schema_migrations WHERE filename='$1'"
}

ledger_has() {
  [ -n "$(ledger_checksum "$1")" ]
}

adopt_exact_legacy_001_002() {
  legacy_001="$(file_for_name "001_control_plane.sql" || true)"
  legacy_002="$(file_for_name "002_authorization_intents.sql" || true)"
  if [ -z "$legacy_001" ] || [ -z "$legacy_002" ] || \
     [ "$(checksum_for "$legacy_001")" != "$LEGACY_001_SHA256" ] || \
     [ "$(checksum_for "$legacy_002")" != "$LEGACY_002_SHA256" ]; then
    echo "migration_legacy_001_002_checksum_mismatch" >&2
    exit 1
  fi

  # Verify the full migration-owned catalog, then lock and verify it again in
  # the same transaction that records 001/002.  The fingerprint includes all
  # public tables/columns/constraints/indexes/RLS flags/policies/triggers and
  # public functions.  Policy role/mode and trigger enabled-state are security
  # semantics, so the fingerprint covers them too; an incomplete or drifted
  # lookalike cannot be adopted.
  psql_run <<SQL
BEGIN;
LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE;
DO \$\$
DECLARE actual TEXT;
BEGIN
  WITH signature_rows AS (
    SELECT 'T|' || c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'C|' || c.relname || '|' || a.attnum || '|' || a.attname || '|' ||
           pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|' ||
           COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
       AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'K|' || c.relname || '|' || con.conname || '|' || con.contype::text || '|' ||
           pg_get_constraintdef(con.oid, true)
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'I|' || c.relname || '|' || ix.relname || '|' || pg_get_indexdef(i.indexrelid, 0, true)
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_class ix ON ix.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'P|' || c.relname || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' ||
           COALESCE((SELECT string_agg(role_name::text, ',' ORDER BY role_name::text)
                       FROM unnest(p.roles) AS role_names(role_name)), '') || '|' ||
           COALESCE(p.qual, '') || '|' || COALESCE(p.with_check, '')
      FROM pg_policies p JOIN pg_class c ON c.relname = p.tablename
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
     WHERE p.schemaname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'G|' || c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid, true)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'F|' || p.proname || '|' || pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  )
  SELECT encode(sha256(convert_to(string_agg(line, E'\\n' ORDER BY line), 'UTF8')), 'hex') INTO actual FROM signature_rows;
  IF actual IS DISTINCT FROM '$LEGACY_001_002_CATALOG_SHA256' THEN
    RAISE EXCEPTION 'migration_legacy_001_002_schema_not_exact';
  END IF;
END \$\$;
LOCK TABLE incident_cases, case_events, evidence_envelopes, claim_records, claim_evidence_links,
  hypothesis_records, coverage_entries, conflict_records, investigator_assignments, tool_calls,
  knowledge_revisions, remediation_proposals, owner_approvals, owner_approval_candidates,
  verification_reports, action_executions, auth_command_intents, auth_assertion_consumptions
  IN ACCESS EXCLUSIVE MODE;
DO \$\$
DECLARE actual TEXT;
BEGIN
  WITH signature_rows AS (
    SELECT 'T|' || c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'C|' || c.relname || '|' || a.attnum || '|' || a.attname || '|' ||
           pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|' ||
           COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
       AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'K|' || c.relname || '|' || con.conname || '|' || con.contype::text || '|' ||
           pg_get_constraintdef(con.oid, true)
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'I|' || c.relname || '|' || ix.relname || '|' || pg_get_indexdef(i.indexrelid, 0, true)
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_class ix ON ix.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'P|' || c.relname || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' ||
           COALESCE((SELECT string_agg(role_name::text, ',' ORDER BY role_name::text)
                       FROM unnest(p.roles) AS role_names(role_name)), '') || '|' ||
           COALESCE(p.qual, '') || '|' || COALESCE(p.with_check, '')
      FROM pg_policies p JOIN pg_class c ON c.relname = p.tablename
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
     WHERE p.schemaname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
    UNION ALL
    SELECT 'G|' || c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid, true)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'F|' || p.proname || '|' || pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  )
  SELECT encode(sha256(convert_to(string_agg(line, E'\\n' ORDER BY line), 'UTF8')), 'hex') INTO actual FROM signature_rows;
  IF actual IS DISTINCT FROM '$LEGACY_001_002_CATALOG_SHA256' THEN
    RAISE EXCEPTION 'migration_legacy_001_002_schema_not_exact';
  END IF;
END \$\$;
INSERT INTO schema_migrations (filename, checksum_sha256)
  VALUES ('001_control_plane.sql', '$LEGACY_001_SHA256'),
         ('002_authorization_intents.sql', '$LEGACY_002_SHA256');
COMMIT;
SQL
}

# Only the exact reviewed b754 001+002 baseline may be adopted without a
# ledger.  Later schema artifacts or every other 002 lookalike are unsafe.
ledger_entries="$(psql -Atq -c "SELECT count(*) FROM schema_migrations")"
legacy_auth_table="$(psql -Atq -c "SELECT to_regclass('public.auth_command_intents') IS NOT NULL OR to_regclass('public.auth_assertion_consumptions') IS NOT NULL")"
if ! ledger_has "002_authorization_intents.sql" && [ "$legacy_auth_table" = "t" ]; then
  if [ "$ledger_entries" = "0" ]; then
    adopt_exact_legacy_001_002
  else
    echo "migration_partial_schema_unrecorded:002_authorization_intents.sql" >&2
    exit 1
  fi
fi

if ! ledger_has "002_authorization_intents.sql" && \
  [ "$(psql -Atq -c "SELECT to_regclass('public.auth_assertion_consumptions') IS NOT NULL")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:002_authorization_intents.sql" >&2
  exit 1
fi
if ! ledger_has "003_incident_workspace_projection.sql" && \
  [ "$(psql -Atq -c "SELECT to_regclass('public.incident_run_bindings') IS NOT NULL")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:003_incident_workspace_projection.sql" >&2
  exit 1
fi
if ! ledger_has "004_workspace_binding_integrity.sql" && \
  [ "$(psql -Atq -c "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incident_run_bindings_public_run_unique')")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:004_workspace_binding_integrity.sql" >&2
  exit 1
fi
if ! ledger_has "005_workspace_subject_grants.sql" && \
  [ "$(psql -Atq -c "SELECT to_regclass('public.workspace_subject_grants') IS NOT NULL")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:005_workspace_subject_grants.sql" >&2
  exit 1
fi
if ! ledger_has "006_workspace_gate1_actions.sql" && \
  [ "$(psql -Atq -c "SELECT to_regclass('public.workspace_gate1_leases') IS NOT NULL OR to_regclass('public.next_best_actions') IS NOT NULL OR to_regclass('public.workspace_action_receipts') IS NOT NULL")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:006_workspace_gate1_actions.sql" >&2
  exit 1
fi
if ! ledger_has "007_workspace_action_transitions.sql" && \
  [ "$(psql -Atq -c "SELECT to_regclass('public.workspace_action_transitions') IS NOT NULL")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:007_workspace_action_transitions.sql" >&2
  exit 1
fi
if ! ledger_has "008_workspace_gate1_authority.sql" && \
  [ "$(psql -Atq -c "SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='workspace_subject_grants'
          AND column_name IN ('roles', 'permissions')
     )")" = "t" ]; then
  echo "migration_partial_schema_unrecorded:008_workspace_gate1_authority.sql" >&2
  exit 1
fi

# Ledger entries must name the exact contiguous source sequence.  This rejects
# checksum drift, unsupported future versions, and a partially edited ledger.
last=0
for line in $(psql -Atq -F '|' -c "SELECT filename || '|' || checksum_sha256 FROM schema_migrations ORDER BY filename"); do
  name="${line%%|*}"
  recorded="${line#*|}"
  file="$(file_for_name "$name" || true)"
  if [ -z "$file" ]; then
    echo "migration_unsupported_ledger_version:$name" >&2
    exit 1
  fi
  version="${name%%_*}"
  numeric="$(printf '%s' "$version" | sed 's/^0*//')"
  numeric="${numeric:-0}"
  if [ "$numeric" -ne $((last + 1)) ]; then
    echo "migration_ledger_gap:$name" >&2
    exit 1
  fi
  expected_checksum="$(checksum_for "$file")"
  if [ "$recorded" != "$expected_checksum" ]; then
    echo "migration_checksum_mismatch:$name" >&2
    exit 1
  fi
  last="$numeric"
done

record_baseline() {
  file="$1"
  name="$(basename "$file")"
  checksum="$(checksum_for "$file")"
  psql_run <<SQL
BEGIN;
LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE;
DO \$\$
DECLARE recorded TEXT;
BEGIN
  SELECT checksum_sha256 INTO recorded FROM schema_migrations WHERE filename = '$name';
  IF recorded IS NULL THEN
    INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ('$name', '$checksum');
  ELSIF recorded <> '$checksum' THEN
    RAISE EXCEPTION 'migration_checksum_mismatch:$name';
  END IF;
END \$\$;
COMMIT;
SQL
}

apply_forward_file() {
  file="$1"
  name="$(basename "$file")"
  checksum="$(checksum_for "$file")"
  {
    printf '%s\n' 'BEGIN;' 'LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE;'
    cat "$file"
    printf '%s\n' "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ('$name', '$checksum') ON CONFLICT (filename) DO NOTHING;"
    printf '%s\n' "DO \$\$ DECLARE recorded TEXT; BEGIN SELECT checksum_sha256 INTO recorded FROM schema_migrations WHERE filename = '$name'; IF recorded <> '$checksum' THEN RAISE EXCEPTION 'migration_checksum_mismatch:$name'; END IF; END \$\$;"
    printf '%s\n' 'COMMIT;'
  } | psql_run
}

baseline="$(file_for_name "001_control_plane.sql" || true)"
if [ -z "$baseline" ]; then
  echo "migration_baseline_missing" >&2
  exit 1
fi
record_baseline "$baseline"

while IFS= read -r file; do
  [ -n "$file" ] || continue
  name="$(basename "$file")"
  [ "$name" = "001_control_plane.sql" ] && continue
  existing="$(ledger_checksum "$name")"
  if [ -n "$existing" ]; then
    continue
  fi
  apply_forward_file "$file"
done <<EOF
$files
EOF

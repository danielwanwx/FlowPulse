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

# A legacy 001 volume has no ledger by design.  Later schema artifacts without
# their ledger entry prove an interrupted/non-runner migration and are unsafe to
# guess at.  Stop before making the partial schema more divergent.
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

#!/bin/sh
# Forward-only local migration runner. The Postgres init hook owns the immutable 001 baseline.
set -eu

psql -h postgres -U flowpulse -d flowpulse -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

record_baseline() {
  file="$1"
  checksum="$(sha256sum "$file" | awk '{print $1}')"
  existing="$(psql -h postgres -U flowpulse -d flowpulse -Atqc "SELECT checksum_sha256 FROM schema_migrations WHERE filename='$(basename "$file")'")"
  if [ -n "$existing" ] && [ "$existing" != "$checksum" ]; then
    echo "migration_checksum_mismatch:$(basename "$file")" >&2
    exit 1
  fi
  if [ -z "$existing" ]; then
    psql -h postgres -U flowpulse -d flowpulse -v ON_ERROR_STOP=1 \
      -c "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ('$(basename "$file")', '$checksum')"
  fi
}

record_baseline /migrations/001_control_plane.sql
for file in /migrations/002_*.sql /migrations/003_*.sql /migrations/004_*.sql /migrations/005_*.sql; do
  [ -f "$file" ] || continue
  checksum="$(sha256sum "$file" | awk '{print $1}')"
  existing="$(psql -h postgres -U flowpulse -d flowpulse -Atqc "SELECT checksum_sha256 FROM schema_migrations WHERE filename='$(basename "$file")'")"
  if [ -n "$existing" ]; then
    if [ "$existing" != "$checksum" ]; then
      echo "migration_checksum_mismatch:$(basename "$file")" >&2
      exit 1
    fi
    continue
  fi
  psql -h postgres -U flowpulse -d flowpulse -v ON_ERROR_STOP=1 -f "$file"
  psql -h postgres -U flowpulse -d flowpulse -v ON_ERROR_STOP=1 \
    -c "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ('$(basename "$file")', '$checksum')"
done

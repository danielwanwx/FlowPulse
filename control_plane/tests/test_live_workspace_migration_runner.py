"""Exercise the shipped Compose migration runner against an actual Postgres database."""

import asyncio
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import asyncpg


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_MIGRATION_RUNNER") == "1",
    "requires local Compose Postgres and Docker Compose",
)
class LiveWorkspaceMigrationRunnerTests(unittest.TestCase):
    admin_dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_ADMIN_DSN",
        "postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres",
    )

    def _runner(self, database: str, migration_dir: Path) -> subprocess.CompletedProcess:
        environment = dict(os.environ)
        environment.setdefault("FLOWPULSE_TEST_OWNER_TOKEN", "workspace-contract-core-local-token")
        return subprocess.run(
            [
                "docker", "compose", "run", "--rm", "--no-deps",
                "-e", "PGHOST=postgres", "-e", "PGPORT=5432", "-e", "PGUSER=flowpulse",
                "-e", "PGPASSWORD=flowpulse", "-e", "PGDATABASE={}".format(database),
                "-e", "MIGRATIONS_DIR=/runner-migrations",
                "-v", "{}:/runner-migrations:ro".format(migration_dir), "migrate",
            ],
            cwd=ROOT, env=environment, text=True, capture_output=True, timeout=90,
        )

    def test_actual_runner_upgrades_legacy_001_and_crash_recovery_never_records_partial_005(self):
        async def run():
            database = "flowpulse_runner_{}".format(uuid4().hex)
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            admin = await asyncpg.connect(self.admin_dsn)
            try:
                await admin.execute("CREATE DATABASE " + database)
                legacy = await asyncpg.connect(target_admin_dsn)
                try:
                    await legacy.execute((MIGRATIONS / "001_control_plane.sql").read_text(encoding="utf-8"))
                finally:
                    await legacy.close()

                with tempfile.TemporaryDirectory(prefix="flowpulse-migrations-") as directory:
                    copied = Path(directory)
                    for source in MIGRATIONS.iterdir():
                        if source.is_file():
                            shutil.copy2(source, copied / source.name)

                    upgraded = self._runner(database, copied)
                    self.assertEqual(0, upgraded.returncode, upgraded.stderr + upgraded.stdout)
                    check = await asyncpg.connect(target_admin_dsn)
                    try:
                        rows = await check.fetch("SELECT filename FROM schema_migrations ORDER BY filename")
                        self.assertEqual(
                            [
                                "001_control_plane.sql", "002_authorization_intents.sql",
                                "003_incident_workspace_projection.sql", "004_workspace_binding_integrity.sql",
                            ],
                            [row["filename"] for row in rows],
                        )
                    finally:
                        await check.close()

                    crash = copied / "005_runner_crash_recovery.sql"
                    crash.write_text(
                        "CREATE TABLE runner_crash_marker (id integer PRIMARY KEY);\nSELECT 1 / 0;\n",
                        encoding="utf-8",
                    )
                    failed = self._runner(database, copied)
                    self.assertNotEqual(0, failed.returncode, failed.stdout)
                    check = await asyncpg.connect(target_admin_dsn)
                    try:
                        self.assertIsNone(await check.fetchval("SELECT to_regclass('public.runner_crash_marker')"))
                        self.assertIsNone(await check.fetchval(
                            "SELECT checksum_sha256 FROM schema_migrations WHERE filename='005_runner_crash_recovery.sql'"
                        ))
                    finally:
                        await check.close()

                    crash.write_text("CREATE TABLE runner_crash_marker (id integer PRIMARY KEY);\n", encoding="utf-8")
                    recovered = self._runner(database, copied)
                    self.assertEqual(0, recovered.returncode, recovered.stderr + recovered.stdout)
                    check = await asyncpg.connect(target_admin_dsn)
                    try:
                        self.assertEqual("runner_crash_marker", await check.fetchval(
                            "SELECT to_regclass('public.runner_crash_marker')::text"
                        ))
                        self.assertIsNotNone(await check.fetchval(
                            "SELECT checksum_sha256 FROM schema_migrations WHERE filename='005_runner_crash_recovery.sql'"
                        ))
                    finally:
                        await check.close()
            finally:
                await admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database)
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()
        asyncio.run(run())

    def test_actual_runner_rejects_newer_gapped_checksum_drift_and_unrecorded_schema(self):
        async def run():
            database = "flowpulse_runner_negative_{}".format(uuid4().hex)
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            admin = await asyncpg.connect(self.admin_dsn)
            try:
                await admin.execute("CREATE DATABASE " + database)
                legacy = await asyncpg.connect(target_admin_dsn)
                try:
                    await legacy.execute((MIGRATIONS / "001_control_plane.sql").read_text(encoding="utf-8"))
                finally:
                    await legacy.close()
                with tempfile.TemporaryDirectory(prefix="flowpulse-migrations-negative-") as directory:
                    copied = Path(directory)
                    for source in MIGRATIONS.iterdir():
                        if source.is_file():
                            shutil.copy2(source, copied / source.name)
                    self.assertEqual(0, self._runner(database, copied).returncode)

                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        await connection.execute(
                            "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ('999_future.sql', repeat('0', 64))"
                        )
                    finally:
                        await connection.close()
                    newer = self._runner(database, copied)
                    self.assertNotEqual(0, newer.returncode)
                    self.assertIn("migration_unsupported_ledger_version:999_future.sql", newer.stderr + newer.stdout)

                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        await connection.execute("DELETE FROM schema_migrations WHERE filename='999_future.sql'")
                    finally:
                        await connection.close()
                    changed = copied / "004_workspace_binding_integrity.sql"
                    changed.write_text(changed.read_text(encoding="utf-8") + "-- checksum drift\n", encoding="utf-8")
                    drift = self._runner(database, copied)
                    self.assertNotEqual(0, drift.returncode)
                    self.assertIn("migration_checksum_mismatch:004_workspace_binding_integrity.sql", drift.stderr + drift.stdout)

                    changed.write_text((MIGRATIONS / changed.name).read_text(encoding="utf-8"), encoding="utf-8")
                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        await connection.execute("DELETE FROM schema_migrations WHERE filename='003_incident_workspace_projection.sql'")
                    finally:
                        await connection.close()
                    partial = self._runner(database, copied)
                    self.assertNotEqual(0, partial.returncode)
                    self.assertIn(
                        "migration_partial_schema_unrecorded:003_incident_workspace_projection.sql",
                        partial.stderr + partial.stdout,
                    )
            finally:
                await admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database)
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()
        asyncio.run(run())

    def test_actual_runner_rejects_a_checksum_valid_ledger_gap_before_any_migration_runs(self):
        async def run():
            database = "flowpulse_runner_gap_{}".format(uuid4().hex)
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            admin = await asyncpg.connect(self.admin_dsn)
            try:
                await admin.execute("CREATE DATABASE " + database)
                connection = await asyncpg.connect(target_admin_dsn)
                try:
                    await connection.execute(
                        """CREATE TABLE schema_migrations (
                             filename TEXT PRIMARY KEY, checksum_sha256 CHAR(64) NOT NULL,
                             applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
                    )
                    for name in ["001_control_plane.sql", "003_incident_workspace_projection.sql"]:
                        checksum = hashlib.sha256((MIGRATIONS / name).read_bytes()).hexdigest()
                        await connection.execute(
                            "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1,$2)", name, checksum,
                        )
                finally:
                    await connection.close()
                with tempfile.TemporaryDirectory(prefix="flowpulse-migrations-gap-") as directory:
                    copied = Path(directory)
                    for source in MIGRATIONS.iterdir():
                        if source.is_file():
                            shutil.copy2(source, copied / source.name)
                    result = self._runner(database, copied)
                    self.assertNotEqual(0, result.returncode)
                    self.assertIn("migration_ledger_gap:003_incident_workspace_projection.sql", result.stderr + result.stdout)
            finally:
                await admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database)
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

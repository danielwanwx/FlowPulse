"""Exercise the shipped Compose migration runner against an actual Postgres database."""

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import asyncpg

from flowpulse_cp.capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityName,
    CapabilityRegistry,
    CapabilityResult,
    EmptyCapabilityInput,
)
from flowpulse_cp.models import IncidentCase
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_actions import (
    ActionInvocationCommand,
    NextBestActionGenerator,
    WorkspaceActionPacket,
)
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
    WorkspaceActivityPacket,
)


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
SUPPORTED_001_002_BASELINE_SHA = "b7541d17f9f662bc23912c9dbd55244a336274a7"


class LegacyScopeAdapter:
    """Bound adapter only for proving a post-upgrade Gate 1 grant."""

    descriptor = CapabilityDescriptor(
        capability=CapabilityName.METRICS, version="legacy-scope-metrics.v1",
        fresh_read=True, enabled=True, audiences=[CapabilityAudience.USER_QA],
        data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.GATE1, input_schema="legacy-scope-metrics-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="not used by Gate 1 grant")


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_MIGRATION_RUNNER") == "1",
    "requires local Compose Postgres and Docker Compose",
)
class LiveWorkspaceMigrationRunnerTests(unittest.TestCase):
    admin_dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_ADMIN_DSN",
        "postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres",
    )

    def _exact_baseline_sql(self, filename: str) -> str:
        """Read the supported 001/002 baseline from its immutable Git object."""
        return subprocess.check_output(
            ["git", "-C", str(ROOT.parent), "show", "{}:control_plane/migrations/{}".format(
                SUPPORTED_001_002_BASELINE_SHA, filename,
            )],
            text=True,
        )

    async def _create_exact_001_002_database(self, database: str) -> str:
        target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
        admin = await asyncpg.connect(self.admin_dsn)
        try:
            await admin.execute("CREATE DATABASE " + database)
        finally:
            await admin.close()
        connection = await asyncpg.connect(target_admin_dsn)
        try:
            await connection.execute(self._exact_baseline_sql("001_control_plane.sql"))
            await connection.execute(self._exact_baseline_sql("002_authorization_intents.sql"))
            self.assertIsNone(await connection.fetchval("SELECT to_regclass('public.schema_migrations')"))
        finally:
            await connection.close()
        return target_admin_dsn

    async def _drop_database(self, database: str) -> None:
        admin = await asyncpg.connect(self.admin_dsn)
        try:
            await admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database)
            await admin.execute("DROP DATABASE IF EXISTS " + database)
        finally:
            await admin.close()

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

    def test_actual_runner_upgrades_legacy_001_and_crash_recovery_never_records_partial_010(self):
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
                                "005_workspace_subject_grants.sql", "006_workspace_gate1_actions.sql",
                                "007_workspace_action_transitions.sql", "008_workspace_gate1_authority.sql",
                                "009_workspace_subject_scope_grants.sql",
                            ],
                            [row["filename"] for row in rows],
                        )
                    finally:
                        await check.close()

                    # 009 is an established workspace migration.  The
                    # temporary crash/recovery fixture must be the next
                    # contiguous migration, not a competing 009 prefix.
                    crash = copied / "010_runner_crash_recovery.sql"
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
                            "SELECT checksum_sha256 FROM schema_migrations WHERE filename='010_runner_crash_recovery.sql'"
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
                            "SELECT checksum_sha256 FROM schema_migrations WHERE filename='010_runner_crash_recovery.sql'"
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
                        await connection.execute("DELETE FROM schema_migrations WHERE filename='008_workspace_gate1_authority.sql'")
                    finally:
                        await connection.close()
                    unrecorded_gate_authority = self._runner(database, copied)
                    self.assertNotEqual(0, unrecorded_gate_authority.returncode)
                    self.assertIn(
                        "migration_partial_schema_unrecorded:008_workspace_gate1_authority.sql",
                        unrecorded_gate_authority.stderr + unrecorded_gate_authority.stdout,
                    )

                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        await connection.execute(
                            "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1,$2)",
                            "008_workspace_gate1_authority.sql",
                            hashlib.sha256((MIGRATIONS / "008_workspace_gate1_authority.sql").read_bytes()).hexdigest(),
                        )
                        await connection.execute("DELETE FROM schema_migrations WHERE filename='009_workspace_subject_scope_grants.sql'")
                    finally:
                        await connection.close()
                    unrecorded_subject_scope = self._runner(database, copied)
                    self.assertNotEqual(0, unrecorded_subject_scope.returncode)
                    self.assertIn(
                        "migration_partial_schema_unrecorded:009_workspace_subject_scope_grants.sql",
                        unrecorded_subject_scope.stderr + unrecorded_subject_scope.stdout,
                    )

                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        await connection.execute(
                            "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1,$2)",
                            "009_workspace_subject_scope_grants.sql",
                            hashlib.sha256((MIGRATIONS / "009_workspace_subject_scope_grants.sql").read_bytes()).hexdigest(),
                        )
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

    def test_actual_runner_upgrades_legacy_001_007_subject_grant_to_append_only_scope_then_authorizes_gate1(self):
        """A 005 membership survives 008/009 and gains only a trusted successor scope."""
        async def run():
            database = "flowpulse_runner_legacy_scope_{}".format(uuid4().hex)
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            target_app_dsn = (
                "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/" + database
            )
            now = datetime.now(timezone.utc)
            suffix = uuid4().hex
            tenant = "tenant-legacy-scope-{}".format(suffix)
            subject = "legacy-subject-{}".format(suffix)
            binding = IncidentRunBinding(
                tenant_id=tenant, incident_id="legacy-incident-{}".format(suffix),
                run_id="legacy-run-public-{}".format(suffix), topology_revision="topology-v1",
                case_id="legacy-case-{}".format(suffix), case_revision=1,
                workflow_id="legacy-workflow-{}".format(suffix), workflow_run_id="legacy-temporal-{}".format(suffix),
                created_at=now,
            )
            case = IncidentCase(
                case_id=binding.case_id, tenant_id=tenant, case_revision=1,
                workflow_id=binding.workflow_id, workflow_run_id=binding.workflow_run_id,
                public_incident_id=binding.incident_id, public_run_id=binding.run_id,
                public_topology_revision=binding.topology_revision,
                severity="SEV2", environment="legacy", affected_entities=["checkout"],
                created_at=now, updated_at=now,
            )
            projection = IncidentProjection(
                **binding.dict(), projection_revision=1, sequence=1,
                lifecycle_state=ProjectionState.DEGRADED, status="provider_unavailable", generated_at=now,
                graph=IncidentGraph(nodes=[IncidentGraphNode(
                    component_id="checkout", canonical_identity="service:checkout",
                    membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
                )]), evidence_revision=1, gate_revision=1, action_revision=1,
            )
            admin = await asyncpg.connect(self.admin_dsn)
            try:
                await admin.execute("CREATE DATABASE " + database)
            finally:
                await admin.close()
            try:
                connection = await asyncpg.connect(target_admin_dsn)
                try:
                    legacy_names = [
                        "001_control_plane.sql", "002_authorization_intents.sql",
                        "003_incident_workspace_projection.sql", "004_workspace_binding_integrity.sql",
                        "005_workspace_subject_grants.sql", "006_workspace_gate1_actions.sql",
                        "007_workspace_action_transitions.sql",
                    ]
                    for name in legacy_names:
                        await connection.execute((MIGRATIONS / name).read_text(encoding="utf-8"))
                    await connection.execute(
                        """CREATE TABLE schema_migrations (
                             filename TEXT PRIMARY KEY, checksum_sha256 CHAR(64) NOT NULL,
                             applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
                    )
                    for name in legacy_names:
                        await connection.execute(
                            "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1,$2)",
                            name, hashlib.sha256((MIGRATIONS / name).read_bytes()).hexdigest(),
                        )
                    await connection.execute(
                        """INSERT INTO incident_cases
                           (case_id, tenant_id, case_revision, workflow_id, workflow_run_id, state, payload, created_at, updated_at)
                           VALUES ($1,$2,$3,$4,$5,'RECEIVED',$6::jsonb,$7,$7)""",
                        case.case_id, case.tenant_id, case.case_revision, case.workflow_id, case.workflow_run_id,
                        case.json(), now,
                    )
                    await connection.execute(
                        """INSERT INTO incident_run_bindings
                           (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision,
                            workflow_id, workflow_run_id, created_at, payload)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)""",
                        binding.tenant_id, binding.incident_id, binding.run_id, binding.topology_revision,
                        binding.case_id, binding.case_revision, binding.workflow_id, binding.workflow_run_id,
                        binding.created_at, binding.json(),
                    )
                    await connection.execute(
                        """INSERT INTO incident_projections
                           (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision,
                            workflow_id, workflow_run_id, projection_revision, sequence, payload, created_at)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)""",
                        binding.tenant_id, binding.incident_id, binding.run_id, binding.topology_revision,
                        binding.case_id, binding.case_revision, binding.workflow_id, binding.workflow_run_id,
                        projection.projection_revision, projection.sequence, projection.json(), projection.generated_at,
                    )
                    await connection.execute(
                        """INSERT INTO workspace_subject_grants (tenant_id, case_id, subject_id, created_at)
                           VALUES ($1,$2,$3,$4)""",
                        tenant, binding.case_id, subject, now,
                    )
                finally:
                    await connection.close()

                with tempfile.TemporaryDirectory(prefix="flowpulse-legacy-scope-migrations-") as directory:
                    copied = Path(directory)
                    for source in MIGRATIONS.iterdir():
                        if source.is_file():
                            shutil.copy2(source, copied / source.name)
                    self.assertEqual(0, self._runner(database, copied).returncode)
                    self.assertEqual(0, self._runner(database, copied).returncode)

                check = await asyncpg.connect(target_admin_dsn)
                try:
                    legacy = await check.fetchrow(
                        """SELECT roles, permissions FROM workspace_subject_grants
                           WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3""",
                        tenant, binding.case_id, subject,
                    )
                    self.assertEqual([], json.loads(legacy["roles"]) if isinstance(legacy["roles"], str) else legacy["roles"])
                    self.assertEqual(
                        [], json.loads(legacy["permissions"])
                        if isinstance(legacy["permissions"], str) else legacy["permissions"],
                    )
                    self.assertEqual(0, await check.fetchval(
                        """SELECT count(*) FROM workspace_subject_scope_grants
                           WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3""",
                        tenant, binding.case_id, subject,
                    ))
                finally:
                    await check.close()

                registry = CapabilityRegistry(
                    descriptors=[LegacyScopeAdapter.descriptor],
                    adapters={CapabilityName.METRICS: LegacyScopeAdapter()},
                )
                repository = PostgresCaseRepository(target_app_dsn)
                repository.configure_workspace_capability_registry(registry)
                await repository.connect()
                try:
                    await repository.grant_workspace_subject(binding, subject, ["viewer"], ["incident:read"])
                    await repository.grant_workspace_subject(binding, subject, ["owner"], ["incident:read"])
                    scoped = await repository.workspace_subject_grant(tenant, binding.case_id, subject)
                    self.assertEqual((2, ["owner"], ["incident:read"]), (
                        scoped.scope_revision, scoped.roles, scoped.permissions,
                    ))
                    gate_card = NextBestActionGenerator(registry).generate(projection, now)[0]
                    await repository.append_next_best_action(gate_card)
                    command = ActionInvocationCommand(
                        incident_id=binding.incident_id, run_id=binding.run_id,
                        topology_revision=binding.topology_revision,
                        projection_revision=projection.projection_revision,
                        action_id=gate_card.action_id, idempotency_key="legacy-scope-gate-{}".format(suffix),
                    )
                    outcome = await WorkspaceActivityDispatcher(
                        repository, capability_registry=registry,
                    ).dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
                        **binding.dict(), projection=projection, event_sequence=2, command=command,
                        actor_tenant_id=tenant, actor_subject_id=subject, actor_roles=["owner"],
                    ).dict())
                    self.assertEqual("GATE1_GRANTED", outcome["receipt"]["status"])
                    self.assertTrue(await repository.workspace_subject_authorized(tenant, binding.case_id, subject))
                finally:
                    await repository.close()

                check = await asyncpg.connect(target_admin_dsn)
                try:
                    revisions = await check.fetch(
                        """SELECT scope_revision, roles, permissions FROM workspace_subject_scope_grants
                           WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3 ORDER BY scope_revision""",
                        tenant, binding.case_id, subject,
                    )
                    self.assertEqual([(1, ["viewer"], ["incident:read"]), (2, ["owner"], ["incident:read"])], [
                        (
                            row["scope_revision"],
                            json.loads(row["roles"]) if isinstance(row["roles"], str) else row["roles"],
                            json.loads(row["permissions"])
                            if isinstance(row["permissions"], str) else row["permissions"],
                        ) for row in revisions
                    ])
                    with self.assertRaisesRegex(asyncpg.exceptions.RaiseError, "append_only"):
                        await check.execute(
                            "UPDATE workspace_subject_scope_grants SET roles='[]'::jsonb WHERE tenant_id=$1",
                            tenant,
                        )
                finally:
                    await check.close()
            finally:
                await self._drop_database(database)
        asyncio.run(run())

    def test_actual_runner_adopts_exact_b754_001_002_with_data_and_retry_idempotency(self):
        async def run():
            database = "flowpulse_runner_b754_{}".format(uuid4().hex)
            target_admin_dsn = await self._create_exact_001_002_database(database)
            target_app_dsn = (
                "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/" + database
            )
            try:
                connection = await asyncpg.connect(target_admin_dsn)
                try:
                    now = datetime.now(timezone.utc)
                    suffix = uuid4().hex
                    case_payload = {
                        "case_id": "legacy-case-{}".format(suffix), "tenant_id": "tenant-legacy",
                        "case_revision": 1, "workflow_id": "legacy-workflow-{}".format(suffix),
                        "workflow_run_id": "legacy-run-{}".format(suffix), "state": "RECEIVED",
                        "severity": "SEV2", "environment": "local", "affected_entities": ["checkout"],
                        "created_at": now.isoformat(), "updated_at": now.isoformat(),
                        "blocker_code": None, "human_question": None,
                    }
                    await connection.execute(
                        """INSERT INTO incident_cases
                           (case_id, tenant_id, case_revision, workflow_id, workflow_run_id, state, payload, created_at, updated_at)
                           VALUES ($1,$2,1,$3,$4,'RECEIVED',$5::jsonb,$6,$6)""",
                        case_payload["case_id"], case_payload["tenant_id"], case_payload["workflow_id"],
                        case_payload["workflow_run_id"], json.dumps(case_payload), now,
                    )
                    await connection.execute(
                        """INSERT INTO auth_command_intents
                           (intent_id, tenant_id, case_id, case_revision, workflow_run_id, subject_id, roles,
                            status, expires_at, payload)
                           VALUES ($1,$2,$3,1,$4,'owner-legacy','[\"owner\"]'::jsonb,'PENDING',$5,$6::jsonb)""",
                        "legacy-intent-{}".format(suffix), case_payload["tenant_id"], case_payload["case_id"],
                        case_payload["workflow_run_id"], now, json.dumps({"legacy": True}),
                    )
                finally:
                    await connection.close()

                with tempfile.TemporaryDirectory(prefix="flowpulse-b754-migrations-") as directory:
                    copied = Path(directory)
                    for source in MIGRATIONS.iterdir():
                        if source.is_file():
                            shutil.copy2(source, copied / source.name)
                    first = self._runner(database, copied)
                    self.assertEqual(0, first.returncode, first.stderr + first.stdout)
                    second = self._runner(database, copied)
                    self.assertEqual(0, second.returncode, second.stderr + second.stdout)

                connection = await asyncpg.connect(target_admin_dsn)
                try:
                    rows = await connection.fetch("SELECT filename, checksum_sha256 FROM schema_migrations ORDER BY filename")
                    self.assertEqual(
                        [
                            "001_control_plane.sql", "002_authorization_intents.sql",
                            "003_incident_workspace_projection.sql", "004_workspace_binding_integrity.sql",
                            "005_workspace_subject_grants.sql", "006_workspace_gate1_actions.sql",
                            "007_workspace_action_transitions.sql", "008_workspace_gate1_authority.sql",
                            "009_workspace_subject_scope_grants.sql",
                        ],
                        [row["filename"] for row in rows],
                    )
                    self.assertEqual(
                        [hashlib.sha256((MIGRATIONS / row["filename"]).read_bytes()).hexdigest() for row in rows],
                        [row["checksum_sha256"] for row in rows],
                    )
                    self.assertEqual(1, await connection.fetchval("SELECT count(*) FROM incident_cases WHERE tenant_id='tenant-legacy'"))
                    self.assertEqual(1, await connection.fetchval("SELECT count(*) FROM auth_command_intents WHERE tenant_id='tenant-legacy'"))
                finally:
                    await connection.close()

                repository = PostgresCaseRepository(target_app_dsn)
                await repository.connect()
                try:
                    binding = IncidentRunBinding(
                        tenant_id=case_payload["tenant_id"], incident_id="legacy-incident-{}".format(suffix),
                        run_id="legacy-public-run-{}".format(suffix), topology_revision="legacy-topology-{}".format(suffix),
                        case_id=case_payload["case_id"], case_revision=1,
                        workflow_id=case_payload["workflow_id"], workflow_run_id=case_payload["workflow_run_id"],
                        created_at=now,
                    )
                    projection = IncidentProjection(
                        **binding.dict(), projection_revision=1, sequence=1,
                        lifecycle_state=ProjectionState.DEGRADED, status="provider_unavailable", generated_at=now,
                        graph=IncidentGraph(nodes=[IncidentGraphNode(
                            component_id="checkout", canonical_identity="service:checkout",
                            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
                        )]),
                        evidence_revision=1, gate_revision=1, action_revision=1,
                        evidence_refs=[], degraded_code="provider_unavailable",
                    )
                    packet = WorkspaceActivityPacket(
                        **binding.dict(), stage="workspace_initialize", projection=projection, event_sequence=1,
                    )
                    dispatcher = WorkspaceActivityDispatcher(repository)
                    self.assertEqual(
                        await dispatcher.dispatch("workspace_initialize_activity", packet.dict()),
                        await dispatcher.dispatch("workspace_initialize_activity", packet.dict()),
                    )

                    async def retry_counts(connection):
                        return await connection.fetchrow(
                            """SELECT
                                 (SELECT count(*) FROM incident_projections WHERE tenant_id=$1 AND case_id=$2) AS projections,
                                 (SELECT count(*) FROM incident_projection_events WHERE tenant_id=$1 AND case_id=$2) AS events""",
                            binding.tenant_id, binding.case_id,
                        )
                    self.assertEqual((1, 1), tuple(await repository._tenant(binding.tenant_id, retry_counts)))
                finally:
                    await repository.close()
            finally:
                await self._drop_database(database)
        asyncio.run(run())

    def test_actual_runner_rejects_incomplete_or_security_drifted_b754_001_002_lookalikes(self):
        async def run():
            for mutation in (
                "DROP TABLE auth_assertion_consumptions",
                "DROP POLICY tenant_isolation ON auth_command_intents",
                # Exact reviewer regressions: the ledgerless-adoption
                # fingerprint must distinguish role, policy-mode, and enabled
                # trigger state from the supported b754 schema.
                "ALTER POLICY tenant_isolation ON auth_command_intents TO flowpulse_cp_app",
                """
                DROP POLICY tenant_isolation ON auth_command_intents;
                CREATE POLICY tenant_isolation ON auth_command_intents AS RESTRICTIVE
                  USING (tenant_id = current_setting('app.tenant_id', true))
                  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
                """,
                "ALTER TABLE knowledge_revisions DISABLE TRIGGER knowledge_supersession_guard",
            ):
                database = "flowpulse_runner_b754_bad_{}".format(uuid4().hex)
                target_admin_dsn = await self._create_exact_001_002_database(database)
                try:
                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        await connection.execute(mutation)
                    finally:
                        await connection.close()
                    with tempfile.TemporaryDirectory(prefix="flowpulse-b754-invalid-") as directory:
                        copied = Path(directory)
                        for source in MIGRATIONS.iterdir():
                            if source.is_file():
                                shutil.copy2(source, copied / source.name)
                        result = self._runner(database, copied)
                    self.assertNotEqual(0, result.returncode)
                    self.assertIn("migration_legacy_001_002_schema_not_exact", result.stderr + result.stdout)
                    connection = await asyncpg.connect(target_admin_dsn)
                    try:
                        self.assertEqual(0, await connection.fetchval("SELECT count(*) FROM schema_migrations"))
                    finally:
                        await connection.close()
                finally:
                    await self._drop_database(database)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

"""Opt-in Postgres proof for retry-safe append-only activity/action records."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.authorization import AssertionReplayRepository, HmacAuthorizationAuthority
from flowpulse_cp.models import AuthContext, DryRunReceipt, IncidentCase, TemporalActivityPacket
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.postgres import PostgresCaseRepository


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_POSTGRES") == "1", "requires the local Compose Postgres")
class LivePostgresIdempotencyTests(unittest.TestCase):
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )
    admin_dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_ADMIN_DSN",
        "postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres",
    )

    def test_legacy_001_volume_upgrades_with_002_without_losing_case_or_verify_consume(self):
        async def run():
            database = "flowpulse_legacy_{}".format(uuid4().hex)
            target_dsn = self.dsn.rsplit("/", 1)[0] + "/" + database
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            base = (Path(__file__).resolve().parents[1] / "migrations" / "001_control_plane.sql").read_text()
            forward = (Path(__file__).resolve().parents[1] / "migrations" / "002_authorization_intents.sql").read_text()
            admin = await asyncpg.connect(self.admin_dsn)
            try:
                await admin.execute("CREATE DATABASE " + database)
                legacy = await asyncpg.connect(target_admin_dsn)
                try:
                    await legacy.execute(base)
                finally:
                    await legacy.close()

                repository = PostgresCaseRepository(target_dsn)
                await repository.connect()
                now = datetime.now(timezone.utc)
                case = IncidentCase(
                    case_id="case-legacy-{}".format(uuid4().hex), tenant_id="tenant-legacy",
                    workflow_id="workflow-legacy", workflow_run_id="run-legacy", severity="SEV2",
                    environment="prod", affected_entities=["checkout"], created_at=now, updated_at=now,
                )
                try:
                    await repository.put_case(case)
                    migration = await asyncpg.connect(target_admin_dsn)
                    try:
                        # The Compose migration runner can repeat this safely on
                        # an initialized volume after the 001 entrypoint has run.
                        await migration.execute(forward)
                        await migration.execute(forward)
                    finally:
                        await migration.close()
                    self.assertEqual(case, await repository.get_case(case.tenant_id, case.case_id))

                    authority = HmacAuthorizationAuthority("legacy-upgrade-test-key")
                    assertion = authority.issue(
                        AuthContext(tenant_id=case.tenant_id, subject_id="owner-legacy", roles=["owner"]), case,
                    )
                    self.assertEqual("owner-legacy", authority.resolve(assertion, case).subject_id)
                    replay = AssertionReplayRepository(target_dsn)
                    await replay.connect()
                    try:
                        await replay.consume(assertion)
                    finally:
                        await replay.close()
                    async def counts(connection):
                        return await connection.fetchval("SELECT count(*) FROM auth_assertion_consumptions")
                    self.assertEqual(1, await repository._tenant(case.tenant_id, counts))
                finally:
                    await repository.close()
            finally:
                await admin.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database,
                )
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()
        asyncio.run(run())

    def test_activity_retry_and_cross_tenant_idempotency_key_reuse_fail_closed(self):
        async def run():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                now = datetime.now(timezone.utc)
                suffix = uuid4().hex
                tenant = "tenant-retry-a"
                case = IncidentCase(
                    case_id="case-retry-{}".format(suffix), tenant_id=tenant,
                    workflow_id="workflow-retry-{}".format(suffix), workflow_run_id="run-retry-{}".format(suffix),
                    severity="SEV2", environment="prod", affected_entities=["checkout"],
                    created_at=now, updated_at=now,
                )
                await repository.put_case(case)
                packet = TemporalActivityPacket(
                    case_id=case.case_id, case_revision=case.case_revision, tenant_id=tenant,
                    workflow_id=case.workflow_id, workflow_run_id=case.workflow_run_id,
                    actor_subject_id="owner-retry", severity=case.severity, environment=case.environment,
                    affected_entities=case.affected_entities, stage="route_case", sequence=1,
                )
                # First commit succeeds but its caller loses the response; the
                # retried activity must leave one durable event only.
                await repository.append_activity_event(packet, "activity-1", {"decision": "PASS"}, "tenant-retry-a/sha256/" + "a" * 64)
                await repository.append_activity_event(packet, "activity-1", {"decision": "PASS"}, "tenant-retry-a/sha256/" + "a" * 64)
                async def count_events(connection):
                    return await connection.fetchval(
                        "SELECT count(*) FROM case_events WHERE case_id=$1", case.case_id
                    )
                self.assertEqual(1, await repository._tenant(tenant, count_events))

                key = "idem-retry-{}".format(suffix)
                first = DryRunReceipt(
                    tenant_id=tenant, case_id=case.case_id, proposal_id="proposal-a-{}".format(suffix),
                    repair_contract_hash="b" * 64, idempotency_key=key, reason="test",
                )
                self.assertEqual(first, await repository.record_dry_run(first))
                other_case = case.copy(update={
                    "case_id": "case-retry-b-{}".format(suffix), "tenant_id": "tenant-retry-b",
                    "workflow_id": "workflow-retry-b-{}".format(suffix), "workflow_run_id": "run-retry-b-{}".format(suffix),
                })
                await repository.put_case(other_case)
                cross_tenant = DryRunReceipt(
                    tenant_id=other_case.tenant_id, case_id=other_case.case_id,
                    proposal_id="proposal-b-{}".format(suffix), repair_contract_hash="b" * 64,
                    idempotency_key=key, reason="test",
                )
                with self.assertRaisesRegex(PolicyViolation, "idempotency_key_reuse"):
                    await repository.record_dry_run(cross_tenant)
            finally:
                await repository.close()
        asyncio.run(run())

    def test_knowledge_trigger_atomically_supersedes_one_active_revision(self):
        async def run():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                suffix = uuid4().hex
                tenant = "tenant-kb-{}".format(suffix)
                document = "runbook-{}".format(suffix)
                first = "kb-first-{}".format(suffix)
                second = "kb-second-{}".format(suffix)

                async def operation(connection):
                    await connection.execute(
                        """INSERT INTO knowledge_revisions
                           (knowledge_revision_id, tenant_id, document_id, revision, supersedes_revision_id, status, payload)
                           VALUES ($1,$2,$3,1,NULL,'ACTIVE','{}'::jsonb)""",
                        first, tenant, document,
                    )
                    await connection.execute(
                        """INSERT INTO knowledge_revisions
                           (knowledge_revision_id, tenant_id, document_id, revision, supersedes_revision_id, status, payload)
                           VALUES ($1,$2,$3,2,$4,'ACTIVE','{}'::jsonb)""",
                        second, tenant, document, first,
                    )
                    statuses = await connection.fetch(
                        "SELECT knowledge_revision_id, status FROM knowledge_revisions WHERE document_id=$1 ORDER BY revision",
                        document,
                    )
                    return [(row["knowledge_revision_id"], row["status"]) for row in statuses]

                self.assertEqual([(first, "SUPERSEDED"), (second, "ACTIVE")], await repository._tenant(tenant, operation))
            finally:
                await repository.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

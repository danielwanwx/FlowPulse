"""Opt-in proof for the additive workspace schema, RLS, and append-only map."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.models import IncidentCase
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentEvent,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
)


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_INCIDENT_WORKSPACE") == "1",
    "requires the local Compose Postgres",
)
class LiveIncidentWorkspacePostgresTests(unittest.TestCase):
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )
    admin_dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_ADMIN_DSN",
        "postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres",
    )

    def test_001_002_volume_upgrades_to_workspace_mapping_with_rls_and_append_only_records(self):
        async def run():
            database = "flowpulse_workspace_{}".format(uuid4().hex)
            target_dsn = self.dsn.rsplit("/", 1)[0] + "/" + database
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            migration_dir = Path(__file__).resolve().parents[1] / "migrations"
            admin = await asyncpg.connect(self.admin_dsn)
            try:
                await admin.execute("CREATE DATABASE " + database)
                bootstrap = await asyncpg.connect(target_admin_dsn)
                try:
                    for name in ["001_control_plane.sql", "002_authorization_intents.sql", "003_incident_workspace_projection.sql"]:
                        await bootstrap.execute((migration_dir / name).read_text(encoding="utf-8"))
                finally:
                    await bootstrap.close()
                repository = PostgresCaseRepository(target_dsn)
                await repository.connect()
                try:
                    now = datetime.now(timezone.utc)
                    suffix = uuid4().hex
                    case = IncidentCase(
                        case_id="workspace-case-{}".format(suffix), tenant_id="tenant-workspace-a",
                        workflow_id="flowpulse.incident-workspace:tenant-workspace-a:run-{}".format(suffix),
                        workflow_run_id="temporal-run-{}".format(suffix), severity="SEV2", environment="local",
                        affected_entities=["checkout"], created_at=now, updated_at=now,
                    )
                    await repository.put_case(case)
                    binding = IncidentRunBinding(
                        tenant_id=case.tenant_id, incident_id="incident-{}".format(suffix),
                        run_id="run-{}".format(suffix), topology_revision="topology-v1-{}".format(suffix),
                        case_id=case.case_id, case_revision=case.case_revision, workflow_id=case.workflow_id,
                        workflow_run_id=case.workflow_run_id, created_at=now,
                    )
                    projection = IncidentProjection(
                        **binding.dict(), projection_revision=1, sequence=1,
                        lifecycle_state=ProjectionState.DEGRADED, status="provider_unavailable", generated_at=now,
                        graph=IncidentGraph(nodes=[IncidentGraphNode(
                            component_id="checkout", canonical_identity="service:checkout",
                            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
                        )]), evidence_revision=1, gate_revision=1, action_revision=1,
                        evidence_refs=[], degraded_code="provider_unavailable",
                    )
                    await repository.put_workspace_binding(binding)
                    await repository.put_workspace_projection(projection)
                    event = IncidentEvent(
                        **binding.dict(), projection_revision=1, sequence=1, event_type="workspace.initialized",
                        occurred_at=now, payload={"state": "provider_unavailable"}, evidence_refs=[],
                    )
                    await repository.append_workspace_event(event)
                    self.assertEqual(projection, await repository.workspace_projection(case.tenant_id, case.case_id))
                    self.assertEqual([1], [item.sequence for item in await repository.workspace_events_after(
                        case.tenant_id, case.case_id, 0,
                    )])
                    self.assertIsNone(await repository.workspace_projection("tenant-workspace-b", case.case_id))
                    with self.assertRaisesRegex(PolicyViolation, "workspace_public_internal_binding_mismatch"):
                        await repository.put_workspace_binding(binding.copy(update={"workflow_run_id": "forged-run"}))

                    async def mutate(connection):
                        await connection.execute(
                            "UPDATE incident_run_bindings SET incident_id='forged' WHERE tenant_id=$1 AND run_id=$2",
                            case.tenant_id, binding.run_id,
                        )
                    with self.assertRaises(asyncpg.PostgresError):
                        await repository._tenant(case.tenant_id, mutate)
                finally:
                    await repository.close()
            finally:
                await admin.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database,
                )
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

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
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentEvent,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
    WorkspaceActivityPacket,
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
                    for name in [
                        "001_control_plane.sql", "002_authorization_intents.sql",
                        "003_incident_workspace_projection.sql", "004_workspace_binding_integrity.sql",
                    ]:
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

    def test_workspace_initialize_retry_is_idempotent_and_cross_key_rebinding_is_database_rejected(self):
        async def run():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                now = datetime.now(timezone.utc)
                suffix = uuid4().hex
                tenant = "tenant-workspace-retry-{}".format(suffix)
                case = IncidentCase(
                    case_id="workspace-case-retry-{}".format(suffix), tenant_id=tenant,
                    workflow_id="workspace-workflow-{}".format(suffix),
                    workflow_run_id="workspace-temporal-{}".format(suffix), severity="SEV2", environment="local",
                    affected_entities=["checkout"], created_at=now, updated_at=now,
                )
                binding = IncidentRunBinding(
                    tenant_id=tenant, incident_id="workspace-incident-{}".format(suffix),
                    run_id="workspace-run-{}".format(suffix), topology_revision="topology-v1-{}".format(suffix),
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
                packet = WorkspaceActivityPacket(
                    **binding.dict(), stage="workspace_initialize", projection=projection, event_sequence=1,
                )
                dispatcher = WorkspaceActivityDispatcher(repository)
                # Model a lost worker completion acknowledgement: the exact
                # activity packet is delivered twice after its first commit.
                self.assertEqual(
                    await dispatcher.dispatch("workspace_initialize_activity", packet.dict()),
                    await dispatcher.dispatch("workspace_initialize_activity", packet.dict()),
                )
                async def counts(connection):
                    return await connection.fetchrow(
                        """SELECT
                             (SELECT count(*) FROM incident_projections WHERE tenant_id=$1 AND case_id=$2) AS projections,
                             (SELECT count(*) FROM incident_projection_events WHERE tenant_id=$1 AND case_id=$2) AS events""",
                        tenant, case.case_id,
                    )
                self.assertEqual((1, 1), tuple(await repository._tenant(tenant, counts)))

                race_case = case.copy(update={
                    "case_id": "workspace-case-race-{}".format(suffix),
                    "workflow_id": "workspace-workflow-race-{}".format(suffix),
                    "workflow_run_id": "workspace-temporal-race-{}".format(suffix),
                })
                await repository.put_case(race_case)
                race_binding = binding.copy(update={
                    "case_id": race_case.case_id, "workflow_id": race_case.workflow_id,
                    "workflow_run_id": race_case.workflow_run_id,
                    "run_id": "workspace-race-run-{}".format(suffix),
                    "topology_revision": "topology-v1-race-{}".format(suffix),
                })
                contender = race_binding.copy(update={
                    "run_id": "workspace-other-run-{}".format(suffix),
                    "topology_revision": "topology-v1-other-{}".format(suffix),
                    "workflow_id": "workspace-other-workflow-{}".format(suffix),
                    "workflow_run_id": "workspace-other-temporal-{}".format(suffix),
                })

                async def attempt(value):
                    try:
                        await repository.put_workspace_binding(value)
                        return "accepted"
                    except PolicyViolation as error:
                        return str(error)

                outcomes = await asyncio.gather(attempt(race_binding), attempt(contender))
                self.assertEqual(1, outcomes.count("accepted"), outcomes)
                self.assertIn("workspace_case_rebound_to_different_temporal_run", outcomes)

                async def raw_rebinds(connection):
                    run_rebound = binding.copy(update={"topology_revision": "topology-v1-forged-{}".format(suffix)})
                    with self.assertRaises(asyncpg.UniqueViolationError):
                        await connection.execute(
                            """INSERT INTO incident_run_bindings
                               (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision,
                                workflow_id, workflow_run_id, created_at, payload)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)""",
                            run_rebound.tenant_id, run_rebound.incident_id, run_rebound.run_id,
                            run_rebound.topology_revision, run_rebound.case_id, run_rebound.case_revision,
                            run_rebound.workflow_id, run_rebound.workflow_run_id, run_rebound.created_at,
                            run_rebound.json(),
                        )
                await repository._tenant(tenant, raw_rebinds)

                constraint_case = case.copy(update={
                    "case_id": "workspace-case-constraint-{}".format(suffix),
                    "workflow_id": "workspace-workflow-constraint-{}".format(suffix),
                    "workflow_run_id": "workspace-temporal-constraint-{}".format(suffix),
                })
                await repository.put_case(constraint_case)
                constraint_binding = binding.copy(update={
                    "case_id": constraint_case.case_id, "workflow_id": constraint_case.workflow_id,
                    "workflow_run_id": constraint_case.workflow_run_id,
                    "run_id": "workspace-run-constraint-{}".format(suffix),
                    "topology_revision": "topology-v1-constraint-{}".format(suffix),
                })
                await repository.put_workspace_binding(constraint_binding)
                temporal_case = constraint_case.copy(update={"case_id": "workspace-case-temporal-{}".format(suffix)})
                await repository.put_case(temporal_case)

                async def raw_case_and_temporal_rebinds(connection):
                    async def expect_unique(*values):
                        try:
                            # The repository's tenant transaction stays valid
                            # after each expected database constraint failure.
                            async with connection.transaction():
                                await connection.execute(
                                    """INSERT INTO incident_run_bindings
                                       (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision,
                                        workflow_id, workflow_run_id, created_at, payload)
                                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)""",
                                    *values,
                                )
                        except asyncpg.UniqueViolationError:
                            return
                        self.fail("database accepted immutable workspace rebinding")

                    case_rebound = constraint_binding.copy(update={
                        "run_id": "workspace-run-case-forged-{}".format(suffix),
                        "topology_revision": "topology-v1-case-forged-{}".format(suffix),
                        "workflow_id": "workspace-workflow-case-forged-{}".format(suffix),
                        "workflow_run_id": "workspace-temporal-case-forged-{}".format(suffix),
                    })
                    await expect_unique(
                        case_rebound.tenant_id, case_rebound.incident_id, case_rebound.run_id,
                        case_rebound.topology_revision, case_rebound.case_id, case_rebound.case_revision,
                        case_rebound.workflow_id, case_rebound.workflow_run_id, case_rebound.created_at,
                        case_rebound.json(),
                    )
                    temporal_rebound = constraint_binding.copy(update={
                        "case_id": temporal_case.case_id,
                        "run_id": "workspace-run-temporal-forged-{}".format(suffix),
                        "topology_revision": "topology-v1-temporal-forged-{}".format(suffix),
                    })
                    await expect_unique(
                        temporal_rebound.tenant_id, temporal_rebound.incident_id, temporal_rebound.run_id,
                        temporal_rebound.topology_revision, temporal_rebound.case_id, temporal_rebound.case_revision,
                        temporal_rebound.workflow_id, temporal_rebound.workflow_run_id, temporal_rebound.created_at,
                        temporal_rebound.json(),
                    )
                await repository._tenant(tenant, raw_case_and_temporal_rebinds)
            finally:
                await repository.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

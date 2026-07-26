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

from flowpulse_cp.models import (
    ClaimRecord,
    CoverageEntry,
    CoverageStatus,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    IncidentCase,
    ProofScope,
    SourceKind,
    TemporalActivityPacket,
)
from flowpulse_cp.capability_adapters import CurrentEvidenceCapabilityAdapter, DomainEvidenceAdmission
from flowpulse_cp.integrity import FrozenSourceReadback
from flowpulse_cp.capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityInvocationContext,
    CapabilityName,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityScope,
    ToolCallBudget,
)
from flowpulse_cp.capability_adapters import RecordedContextCapabilityAdapter
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.postgres import PostgresCapabilityScopeAuthority, PostgresCaseRepository
from flowpulse_cp.temporal_runtime import DomainActivityEngine
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

    def test_autonomous_current_evidence_uses_production_registry_admission_then_durable_audit(self):
        class ControlledAcquirer:
            def __init__(self, result):
                self.result = result
                self.calls = 0

            def acquire(self, case, subject_id):
                self.calls += 1
                return self.result

        async def run():
            database = "flowpulse_capability_{}".format(uuid4().hex)
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
                        case_id="capability-case-{}".format(suffix), tenant_id="tenant-capability",
                        workflow_id="diagnosis-workflow-{}".format(suffix), workflow_run_id="temporal-{}".format(suffix),
                        public_incident_id="incident-{}".format(suffix), public_run_id="run-{}".format(suffix),
                        public_topology_revision="topology-v1-{}".format(suffix), severity="SEV2", environment="local",
                        affected_entities=["checkout"], created_at=now, updated_at=now,
                    )
                    await repository.put_case(case)
                    evidence = EvidenceEnvelope(
                        evidence_id="capability-evidence-{}".format(suffix), tenant_id=case.tenant_id,
                        case_id=case.case_id, case_revision=case.case_revision, acl_subjects=["owner-capability"],
                        source_kind=SourceKind.METRIC, source_uri="metric://checkout/latency", source_anchor="sample:1",
                        observed_at=now, effective_at=now, source_version="v1", content_hash="b" * 64,
                        authority=EvidenceAuthority.T0, freshness=FreshnessStatus.CURRENT,
                        independence_key="capability-metric", schema_binding="metric.v1",
                        proof_scope=ProofScope.CURRENT_OBSERVATION,
                    )
                    acquired = type("Acquisition", (), {
                        "evidence": [evidence], "claims": [ClaimRecord(
                            claim_id="capability-claim-{}".format(suffix), tenant_id=case.tenant_id,
                            case_id=case.case_id, case_revision=case.case_revision, claim_type="root",
                            statement="Current controlled source.", evidence_ids=[evidence.evidence_id], created_by="primary",
                        )], "coverage": [CoverageEntry(
                            tenant_id=case.tenant_id, case_id=case.case_id, field="telemetry_symptom",
                            status=CoverageStatus.FILLED,
                        )],
                    })()
                    acquirer = ControlledAcquirer(acquired)
                    registry = CapabilityRegistry(
                        descriptors=[CurrentEvidenceCapabilityAdapter.descriptor],
                        adapters={
                            CapabilityName.CURRENT_EVIDENCE: CurrentEvidenceCapabilityAdapter(acquirer),
                        },
                        audit_sink=repository, scope_authority=PostgresCapabilityScopeAuthority(repository),
                    )
                    packet = TemporalActivityPacket(
                        case_id=case.case_id, case_revision=case.case_revision, tenant_id=case.tenant_id,
                        workflow_id=case.workflow_id, workflow_run_id=case.workflow_run_id,
                        public_incident_id=case.public_incident_id, public_run_id=case.public_run_id,
                        public_topology_revision=case.public_topology_revision, capability_scope_created_at=case.created_at,
                        actor_subject_id="owner-capability", actor_roles=["owner"], severity=case.severity,
                        environment=case.environment, affected_entities=case.affected_entities,
                        stage="acquire_current_evidence", sequence=1,
                    )
                    engine = DomainActivityEngine(
                        FrozenSourceReadback([]), authorization=None, evidence_acquirer=acquirer,
                        capability_registry=registry,
                    )
                    outcome = await engine.execute_async(packet, DomainEvidenceAdmission(repository, "owner-capability"))
                    self.assertEqual("PASS", outcome.decision.value)
                    self.assertEqual("capability:current-evidence:v1", outcome.identity)
                    # A lost activity-completion acknowledgement can redeliver
                    # the exact packet: admission/audit remain append-only.
                    retry = await engine.execute_async(packet, DomainEvidenceAdmission(repository, "owner-capability"))
                    self.assertEqual("PASS", retry.decision.value)
                    self.assertEqual(2, acquirer.calls)
                    async def counts(connection):
                        return await connection.fetchrow(
                            """SELECT
                                 (SELECT count(*) FROM evidence_envelopes WHERE case_id=$1) AS evidence,
                                 (SELECT count(*) FROM claim_records WHERE case_id=$1) AS claims,
                                 (SELECT count(*) FROM tool_calls WHERE case_id=$1 AND status='COMPLETED') AS audits""",
                            case.case_id,
                        )
                    count = await repository._tenant(case.tenant_id, counts, subject_id="owner-capability")
                    self.assertEqual((1, 1, 1), (count["evidence"], count["claims"], count["audits"]))
                finally:
                    await repository.close()
            finally:
                await admin.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", database,
                )
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()
        asyncio.run(run())

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
                    evidence = EvidenceEnvelope(
                        evidence_id="workspace-evidence-{}".format(suffix), tenant_id=case.tenant_id,
                        case_id=case.case_id, case_revision=case.case_revision,
                        acl_subjects=["workspace-owner"], source_kind=SourceKind.METRIC,
                        source_uri="metric://checkout/latency", source_anchor="sample:1", observed_at=now,
                        effective_at=now, source_version="v1", content_hash="a" * 64,
                        authority=EvidenceAuthority.T0, freshness=FreshnessStatus.CURRENT,
                        independence_key="workspace-metric", schema_binding="metric.v1",
                        proof_scope=ProofScope.CURRENT_OBSERVATION,
                    )
                    await repository.put_evidence(evidence, "workspace-owner")
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
                        evidence_refs=[evidence.evidence_id], degraded_code="provider_unavailable",
                    )
                    await repository.put_workspace_binding(binding)
                    await repository.put_workspace_projection(projection)
                    invocation = CapabilityInvocationContext(
                        **binding.dict(), projection_revision=projection.projection_revision,
                        evidence_revision=projection.evidence_revision,
                        component_ids=["checkout"], activity_id="workspace-capability-audit",
                        scope=CapabilityScope.USER_QA, subject_id="workspace-owner", subject_roles=["owner"],
                        authorized_subjects=["workspace-owner"], data_class=CapabilityDataClass.RECORDED_CONTEXT,
                        recorded_evidence_ids=[evidence.evidence_id], gate1_authorized=False, system_authorized=False,
                    )
                    registry = CapabilityRegistry(
                        descriptors=[RecordedContextCapabilityAdapter.descriptor],
                        adapters={CapabilityName.RECORDED_CONTEXT: RecordedContextCapabilityAdapter()},
                        audit_sink=repository, scope_authority=PostgresCapabilityScopeAuthority(repository),
                    )
                    capability_result = await registry.invoke(
                        CapabilityAudience.USER_QA, invocation,
                        CapabilityRequest(
                            capability=CapabilityName.RECORDED_CONTEXT,
                            component_id="checkout", data_class=CapabilityDataClass.RECORDED_CONTEXT,
                            parameters={"evidence_ids": [evidence.evidence_id]},
                        ),
                        ToolCallBudget(max_calls=1),
                    )
                    # The retry uses the same immutable audit identity and is
                    # accepted without replacing the original ledger record.
                    await registry.invoke(
                        CapabilityAudience.USER_QA, invocation,
                        CapabilityRequest(
                            capability=CapabilityName.RECORDED_CONTEXT,
                            component_id="checkout", data_class=CapabilityDataClass.RECORDED_CONTEXT,
                            parameters={"evidence_ids": [evidence.evidence_id]},
                        ),
                        ToolCallBudget(max_calls=1),
                    )
                    async def audit_count(connection):
                        return await connection.fetchval(
                            "SELECT count(*) FROM tool_calls WHERE tenant_id=$1 AND tool_call_id=$2",
                            case.tenant_id, capability_result.audit.audit_id,
                        )
                    self.assertEqual(1, await repository._tenant(case.tenant_id, audit_count))
                    with self.assertRaisesRegex(
                        PolicyViolation, "capability_scope_recorded_evidence_acl_or_lineage_denied",
                    ):
                        await registry.invoke(
                            CapabilityAudience.USER_QA,
                            invocation.copy(update={
                                "subject_id": "workspace-intruder",
                                "authorized_subjects": ["workspace-intruder"],
                            }),
                            CapabilityRequest(
                                capability=CapabilityName.RECORDED_CONTEXT,
                                component_id="checkout", data_class=CapabilityDataClass.RECORDED_CONTEXT,
                                parameters={"evidence_ids": [evidence.evidence_id]},
                            ),
                            ToolCallBudget(max_calls=1),
                        )
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

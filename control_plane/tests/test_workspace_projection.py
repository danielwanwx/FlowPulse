"""Projection/event seams: they are append-only and tenant scoped."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_models import (
    ExplanationEventStatus,
    GraphMembership,
    IncidentEvent,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    ProjectionState,
    WorkspaceActivityPacket,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.models import AuthContext


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def binding(tenant="tenant-a"):
    return IncidentRunBinding(
        tenant_id=tenant, incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:incident-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )


def projection(item, revision=1, sequence=1):
    return IncidentProjection(
        schema_version="flowpulse.incident-projection.v1", **item.dict(),
        projection_revision=revision, sequence=sequence, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=NOW,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            membership=GraphMembership.CLASSIFIED, classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        )], edges=[]), impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )


class WorkspaceProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_projection_and_sse_resume_are_tenant_scoped_and_strictly_after(self):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        await repository.put_binding(item)
        await repository.put_projection(projection(item))
        first = IncidentEvent(
            **item.dict(), projection_revision=1, sequence=1, event_type="workspace.initialized",
            occurred_at=NOW, payload={"state": "provider_unavailable"},
        )
        second = first.copy(update={"sequence": 2, "event_type": "node_explanation.degraded"})
        await repository.append_event(first)
        await repository.append_event(second)
        self.assertEqual([2], [event.sequence for event in await repository.events_after("tenant-a", "case-a", 1)])
        self.assertEqual([], await repository.events_after("tenant-a", "case-a", 2))
        self.assertIsNone(await repository.get_projection("tenant-b", "case-a"))

    async def test_projection_or_event_cannot_rebind_public_run_to_other_temporal_run(self):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        await repository.put_binding(item)
        forged = item.copy(update={"workflow_run_id": "temporal-run-attacker"})
        with self.assertRaisesRegex(PolicyViolation, "workspace_public_internal_binding_mismatch"):
            await repository.put_projection(projection(forged))

    async def test_workspace_initialize_lost_ack_retries_exact_projection_and_event_once(self):
        """A Temporal retry may repeat all writes after a committed activity response is lost."""
        repository = InMemoryWorkspaceRepository()
        item = binding()
        packet = WorkspaceActivityPacket(
            **item.dict(), stage="workspace_initialize", projection=projection(item), event_sequence=1,
        )
        dispatcher = WorkspaceActivityDispatcher(repository)

        first = await dispatcher.dispatch("workspace_initialize_activity", packet.dict())
        retried = await dispatcher.dispatch("workspace_initialize_activity", packet.dict())

        self.assertEqual(first, retried)
        self.assertEqual(1, len(repository.projections[(item.tenant_id, item.run_id, item.topology_revision)]))
        self.assertEqual(1, len(repository.events[(item.tenant_id, item.run_id, item.topology_revision)]))

    async def test_exact_projection_duplicate_is_idempotent_but_conflicting_duplicate_fails_closed(self):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        current = projection(item)
        await repository.put_binding(item)
        self.assertEqual(current, await repository.put_projection(current))
        self.assertEqual(current, await repository.put_projection(current))
        conflicting = current.copy(update={"status": "forged"})
        with self.assertRaisesRegex(PolicyViolation, "workspace_projection_revision_or_sequence_not_monotonic"):
            await repository.put_projection(conflicting)

    async def test_pre_gate_node_explanation_is_durable_degraded_without_fresh_read_or_diagnosis(self):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        current = projection(item)
        dispatcher = WorkspaceActivityDispatcher(repository)
        initialized = WorkspaceActivityPacket(
            **item.dict(), stage="workspace_initialize", projection=current, event_sequence=1,
            actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
        )
        await dispatcher.dispatch("workspace_initialize_activity", initialized.dict())
        command = NodeExplanationStart(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, component_id="checkout", idempotency_key="click-a",
        )
        packet = initialized.copy(update={
            "stage": "workspace_node_explanation", "event_sequence": 2, "node_explanation": command,
        })
        outcome = await dispatcher.dispatch("workspace_node_explanation_activity", packet.dict())
        self.assertEqual("DEGRADED", outcome["explanation"]["state"])
        self.assertFalse(outcome["explanation"]["fresh_read_performed"])
        self.assertFalse(outcome["explanation"]["fresh_diagnosis_claimed"])
        self.assertEqual(1, len(outcome["explanation"]["conversation_items"]))
        item_record = outcome["explanation"]["conversation_items"][0]
        self.assertEqual(3, item_record["sequence"])
        self.assertEqual("UNKNOWN", item_record["knowledge_state"])
        self.assertEqual("checkout", item_record["component_id"])
        self.assertEqual(outcome["explanation"]["explanation_id"], item_record["explanation_id"])
        public_projection = await repository.workspace_public_projection("tenant-a", "case-a")
        self.assertEqual([item_record], [item.dict() for item in public_projection.conversation_items])
        forged_item = dict(item_record)
        forged_item["run_id"] = "run-attacker"
        with self.assertRaisesRegex(
            Exception, "conversation_item_projection_binding_mismatch",
        ):
            IncidentProjection.parse_obj({
                **public_projection.dict(),
                "conversation_items": [forged_item],
            })
        events = await repository.events_after("tenant-a", "case-a", 1)
        self.assertEqual(
            [("node_explanation.started", ExplanationEventStatus.STARTED),
             ("node_explanation.degraded", ExplanationEventStatus.DEGRADED)],
            [(event.event_type, event.explanation_status) for event in events],
        )
        self.assertEqual(
            item_record["item_id"],
            events[-1].payload["conversation_item_ids"],
        )
        self.assertNotIn(outcome["explanation"]["summary"], [event.payload for event in events])
        duplicate = await dispatcher.dispatch("workspace_node_explanation_activity", packet.dict())
        self.assertEqual(outcome["explanation"]["explanation_id"], duplicate["explanation"]["explanation_id"])
        self.assertEqual(
            [item_record],
            [item.dict() for item in (
                await repository.workspace_public_projection("tenant-a", "case-a")
            ).conversation_items],
        )


if __name__ == "__main__":
    unittest.main()

"""Server-issued Next Best Actions have fixed meaning and bounded scope."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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
from flowpulse_cp.workspace_actions import (
    ActionInvocationCommand,
    NextBestAction,
    NextBestActionCta,
    NextBestActionGenerator,
    NextBestActionTaxonomy,
    validate_current_action_card,
)
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
)


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


class MetricsAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True, enabled=True,
        audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.GATE1, input_schema="metrics-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="test")


class RecordedAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.RECORDED_CONTEXT, version="recorded.v1", fresh_read=False, enabled=True,
        audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.RECORDED_CONTEXT],
        required_gate=CapabilityGate.NONE, input_schema="recorded-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="test")


def projection():
    binding = IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a", topology_revision="topology-a",
        case_id="case-a", case_revision=1, workflow_id="workspace-a", workflow_run_id="temporal-a", created_at=NOW,
    )
    return IncidentProjection(
        **binding.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="degraded", generated_at=NOW, graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CONNECTED,
            runtime_status="unknown", impact_status="unknown",
        )]), evidence_revision=1, gate_revision=1, action_revision=1,
    )


class NextBestActionTests(unittest.TestCase):
    def test_fixed_taxonomy_capability_binding_and_maximum_are_server_generated(self):
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor, RecordedAdapter.descriptor],
            adapters={CapabilityName.METRICS: MetricsAdapter(), CapabilityName.RECORDED_CONTEXT: RecordedAdapter()},
        )
        cards = NextBestActionGenerator(registry).generate(projection(), NOW)
        self.assertEqual(2, len(cards))
        self.assertEqual(1, sum(card.recommended for card in cards))
        self.assertEqual([1, 2], [card.display_order for card in cards])
        self.assertEqual(NextBestActionTaxonomy.FIND_CAUSE, cards[0].taxonomy)
        self.assertEqual("Find Cause", cards[0].title)
        self.assertEqual(NextBestActionCta.REQUEST_GATE1, cards[0].cta)
        self.assertEqual(CapabilityName.METRICS.value, cards[0].capability)
        self.assertEqual("metrics-input.v1", cards[0].tool_schema_version)
        forged = cards[0].dict()
        forged["title"] = "Caller Override"
        with self.assertRaisesRegex(ValueError, "next_best_action_taxonomy_mapping_invalid"):
            NextBestAction(**forged)

        command = ActionInvocationCommand(
            incident_id=cards[0].incident_id, run_id=cards[0].run_id,
            topology_revision=cards[0].topology_revision,
            projection_revision=cards[0].projection_revision,
            action_id=cards[0].action_id, idempotency_key="card-reload-a",
        )
        with self.assertRaisesRegex(PolicyViolation, "workspace_action_precondition_stale"):
            validate_current_action_card(
                cards[0].copy(update={"precondition_hash": "f" * 64}), projection(), command,
                ["incident:read"], NOW,
            )


if __name__ == "__main__":
    unittest.main()

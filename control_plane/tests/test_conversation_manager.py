"""Temporal-activity conversation-manager seam with pinned context and bounded roles."""

import asyncio
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.capabilities import CapabilityName, CapabilityRegistry
from flowpulse_cp.capability_adapters import RecordedContextCapabilityAdapter
from flowpulse_cp.models import AuthContext
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.conversation_manager import ConversationManager
from flowpulse_cp.provider_gateway import ProviderGatewayResult
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.workspace_models import (
    ConversationProviderOutput,
    ConversationRole,
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    ProjectionState,
    ProviderTruthLabel,
    WorkspaceActivityPacket,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def binding():
    return IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )


def projection(item):
    return IncidentProjection(
        schema_version="flowpulse.incident-projection.v1", **item.dict(),
        projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=NOW,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
        )]), impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=["evidence-current"], degraded_code="provider_unavailable",
    )


class RecordingProvider:
    def __init__(self, evidence_refs=None):
        self.requests = []
        self.evidence_refs = evidence_refs if evidence_refs is not None else ["evidence-current"]

    async def complete(self, request):
        self.requests.append(request)
        return ProviderGatewayResult(
            truth_label=ProviderTruthLabel.TEST_DETERMINISTIC,
            provider_id="recording-test-provider", model_id="test-model",
            output=ConversationProviderOutput(
                summary="Recorded context supports a bounded explanation.", evidence_refs=self.evidence_refs,
            ),
        )


class UntrustedRawOutputProvider:
    async def complete(self, request):
        # The gateway result boundary is intentionally tested with malformed
        # provider material: its output must be parsed before projection.
        return ProviderGatewayResult(
            truth_label=ProviderTruthLabel.TEST_DETERMINISTIC,
            provider_id="untrusted-test-provider", model_id="test-model",
            output={
                "summary": "Attempted role takeover.", "evidence_refs": ["evidence-current"],
                "role": "OWNER", "tool": "SAFE_ACTION",
            },
        )


class BoundScopeAuthority:
    async def assert_scope(self, context):
        if context.tenant_id != "tenant-a" or context.subject_id != "subject-a":
            raise PolicyViolation("workspace_subject_scope_denied")


def registry():
    return CapabilityRegistry(
        descriptors=[RecordedContextCapabilityAdapter.descriptor],
        adapters={CapabilityName.RECORDED_CONTEXT: RecordedContextCapabilityAdapter()},
        scope_authority=BoundScopeAuthority(),
    )


class ConversationManagerTests(unittest.IsolatedAsyncioTestCase):
    async def _explanation(self, manager):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        current = projection(item)
        dispatcher = WorkspaceActivityDispatcher(repository, conversation_manager=manager)
        initial = WorkspaceActivityPacket(
            **item.dict(), stage="workspace_initialize", projection=current, event_sequence=1,
            actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
        )
        await dispatcher.dispatch("workspace_initialize_activity", initial.dict())
        command = NodeExplanationStart(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, component_id="checkout", idempotency_key="click-a",
        )
        outcome = await dispatcher.dispatch("workspace_node_explanation_activity", initial.copy(update={
            "stage": "workspace_node_explanation", "event_sequence": 2, "node_explanation": command,
        }).dict())
        stored = next(iter(repository.explanations.values()))
        self.assertEqual(outcome["explanation"], stored.dict())
        return outcome["explanation"]

    async def test_prompt_layers_context_hash_and_roles_are_server_pinned_and_bounded(self):
        provider = RecordingProvider()
        manager = ConversationManager(
            provider, registry(),
            specialist_roles=[ConversationRole.EVIDENCE_SPECIALIST, ConversationRole.TOPOLOGY_SPECIALIST],
        )
        explanation = await self._explanation(manager)
        self.assertEqual("COMPLETED", explanation["state"])
        self.assertEqual("TEST_DETERMINISTIC", explanation["truth_label"])
        trace = explanation["conversation_trace"]
        self.assertEqual("flowpulse.version-bundle.v1", trace["version_bundle"]["schema_version"])
        self.assertEqual(64, len(trace["context_hash"]))
        self.assertEqual(["RECORDED_CONTEXT"], trace["available_capabilities"])
        self.assertEqual(0, trace["tool_calls"])
        self.assertFalse(explanation["fresh_read_performed"])
        self.assertFalse(explanation["fresh_diagnosis_claimed"])
        self.assertEqual(
            [
                ConversationRole.CONVERSATION_MANAGER,
                ConversationRole.EVIDENCE_SPECIALIST,
                ConversationRole.TOPOLOGY_SPECIALIST,
            ],
            [request.role for request in provider.requests],
        )
        self.assertTrue(all(request.context.run_id == "run-public-a" for request in provider.requests))
        self.assertTrue(all(request.context.component.component_id == "checkout" for request in provider.requests))

    async def test_provider_citation_outside_recorded_context_degrades_before_projection(self):
        manager = ConversationManager(RecordingProvider(evidence_refs=["forged-evidence"]), registry())
        explanation = await self._explanation(manager)
        self.assertEqual("DEGRADED", explanation["state"])
        self.assertEqual("provider_output_evidence_not_in_context", explanation["degraded_code"])
        self.assertEqual("DEGRADED", explanation["truth_label"])

    async def test_provider_output_schema_is_validated_before_projection(self):
        explanation = await self._explanation(ConversationManager(UntrustedRawOutputProvider(), registry()))
        self.assertEqual("DEGRADED", explanation["state"])
        self.assertEqual("provider_output_schema_invalid", explanation["degraded_code"])
        self.assertFalse(explanation["fresh_read_performed"])
        self.assertFalse(explanation["fresh_diagnosis_claimed"])

    def test_specialist_cap_is_server_enforced_before_any_provider_call(self):
        with self.assertRaisesRegex(ValueError, "conversation_specialist_cap_exceeded"):
            ConversationManager(
                RecordingProvider(), CapabilityRegistry(),
                specialist_roles=[
                    ConversationRole.EVIDENCE_SPECIALIST,
                    ConversationRole.TOPOLOGY_SPECIALIST,
                    ConversationRole.EVIDENCE_SPECIALIST,
                ],
            )

    async def test_missing_or_cross_tenant_actor_cannot_reach_provider(self):
        provider = RecordingProvider()
        manager = ConversationManager(provider, registry())
        item = binding()
        current = projection(item)
        command = NodeExplanationStart(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, component_id="checkout", idempotency_key="click-a",
        )
        with self.assertRaisesRegex(PolicyViolation, "actor_required"):
            await manager.explain(item, current, command)
        with self.assertRaisesRegex(PolicyViolation, "actor_tenant_mismatch"):
            await manager.explain(
                item, current, command,
                actor=AuthContext(tenant_id="tenant-b", subject_id="subject-a", roles=["viewer"]),
            )
        self.assertEqual([], provider.requests)


if __name__ == "__main__":
    unittest.main()

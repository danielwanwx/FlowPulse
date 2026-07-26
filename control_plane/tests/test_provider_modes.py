"""Provider truth-mode seams: no implicit fake or external default exists."""

import asyncio
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.provider_gateway import (
    DeterministicConversationProvider,
    ProviderConfigurationError,
    ProviderMode,
    ProviderSettings,
    ProviderTruthLabel,
    build_conversation_provider,
)
from flowpulse_cp.workspace_models import (
    ConversationContext,
    ConversationProviderOutput,
    ConversationProviderRequest,
    ConversationRole,
    IncidentGraph,
    IncidentGraphNode,
    IncidentRunBinding,
    GraphMembership,
)


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def request():
    binding = IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )
    context = ConversationContext(
        **binding.dict(), projection_revision=1, component=IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
        ), graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
        )]), recorded_evidence_refs=["evidence-current"], knowledge_prior_refs=[],
        available_capabilities=[], max_tool_calls=0,
    )
    return ConversationProviderRequest(
        role=ConversationRole.CONVERSATION_MANAGER,
        context=context,
        prompt_bundle_version="flowpulse.prompt-bundle.v1",
        prompt_hash="a" * 64,
        context_hash=context.canonical_hash(),
        max_output_tokens=128,
    )


class ProviderModeTests(unittest.TestCase):
    def test_standard_mode_is_typed_degraded_and_cannot_construct_a_deterministic_provider(self):
        fake = DeterministicConversationProvider()
        with self.assertRaisesRegex(ProviderConfigurationError, "deterministic_provider_requires_explicit_test_mode"):
            build_conversation_provider(ProviderSettings(mode=ProviderMode.STANDARD), deterministic_provider=fake)

        result = asyncio.run(build_conversation_provider(ProviderSettings(mode=ProviderMode.STANDARD)).complete(request()))
        self.assertEqual(ProviderTruthLabel.DEGRADED, result.truth_label)
        self.assertIsNone(result.output)
        self.assertEqual("provider_unavailable", result.degraded_code)

    def test_deterministic_provider_requires_explicit_test_injection_and_is_truthfully_labeled(self):
        unavailable = build_conversation_provider(ProviderSettings(mode=ProviderMode.TEST))
        self.assertEqual(ProviderTruthLabel.DEGRADED, asyncio.run(unavailable.complete(request())).truth_label)

        provider = build_conversation_provider(
            ProviderSettings(mode=ProviderMode.TEST), deterministic_provider=DeterministicConversationProvider(),
        )
        result = asyncio.run(provider.complete(request()))
        self.assertEqual(ProviderTruthLabel.TEST_DETERMINISTIC, result.truth_label)
        self.assertIsNotNone(result.output)
        self.assertEqual(["evidence-current"], result.output.evidence_refs)

    def test_provider_output_has_no_model_controlled_identity_role_or_tool_fields(self):
        with self.assertRaises(ValidationError):
            ConversationProviderOutput.parse_obj({
                "summary": "Attempted authority takeover.", "evidence_refs": [],
                "role": "owner", "run_id": "forged", "tool": "safe_action",
            })

    def test_local_open_source_mode_requires_an_explicit_local_endpoint_and_model(self):
        with self.assertRaisesRegex(ProviderConfigurationError, "local_open_source_endpoint_must_be_loopback"):
            ProviderSettings(
                mode=ProviderMode.LOCAL_OPEN_SOURCE,
                base_url="https://api.openai.com", model="not-local",
            ).validate()
        with self.assertRaisesRegex(ProviderConfigurationError, "provider_endpoint_or_model_missing"):
            ProviderSettings(mode=ProviderMode.LOCAL_OPEN_SOURCE).validate()


if __name__ == "__main__":
    unittest.main()

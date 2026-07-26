"""Opt-in local-only OpenAI-compatible smoke; it never has a default endpoint."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.provider_gateway import (
    ProviderMode,
    ProviderSettings,
    ProviderTruthLabel,
    build_conversation_provider,
)
from flowpulse_cp.workspace_models import (
    ConversationContext,
    ConversationProviderRequest,
    ConversationRole,
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentRunBinding,
)


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def local_request():
    binding = IncidentRunBinding(
        tenant_id="tenant-local-provider", incident_id="incident-local-provider", run_id="run-local-provider",
        topology_revision="topology-local-provider", case_id="case-local-provider", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-local-provider:run-local-provider",
        workflow_run_id="temporal-local-provider", created_at=NOW,
    )
    component = IncidentGraphNode(
        component_id="checkout", canonical_identity="service:checkout",
        membership=GraphMembership.CLASSIFIED, classification_reason="Relationship unavailable",
        runtime_status="unknown", impact_status="unknown",
    )
    context = ConversationContext(
        **binding.dict(), projection_revision=1, component=component,
        graph=IncidentGraph(nodes=[component], edges=[]),
        recorded_evidence_refs=["evidence-local-provider"], knowledge_prior_refs=[], available_capabilities=[], max_tool_calls=0,
    )
    return ConversationProviderRequest(
        role=ConversationRole.CONVERSATION_MANAGER, context=context,
        prompt_bundle_version="flowpulse.prompt-bundle.v1", prompt_hash="a" * 64,
        context_hash=context.canonical_hash(), max_output_tokens=64,
    )


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_PROVIDER_SMOKE") == "1"
    and os.environ.get("FLOWPULSE_PROVIDER_MODE") == ProviderMode.LOCAL_OPEN_SOURCE.value
    and os.environ.get("FLOWPULSE_OPENAI_COMPATIBLE_BASE_URL")
    and os.environ.get("FLOWPULSE_OPENAI_COMPATIBLE_MODEL"),
    "requires an intentionally configured local OpenAI-compatible endpoint",
)
class LocalOpenSourceProviderSmokeTests(unittest.TestCase):
    def test_local_open_source_provider_returns_schema_valid_live_label(self):
        settings = ProviderSettings.from_environment()
        self.assertEqual(ProviderMode.LOCAL_OPEN_SOURCE, settings.mode)
        result = asyncio.run(build_conversation_provider(settings).complete(local_request()))
        self.assertEqual(ProviderTruthLabel.LIVE, result.truth_label)
        self.assertIsNotNone(result.output)


if __name__ == "__main__":
    unittest.main()

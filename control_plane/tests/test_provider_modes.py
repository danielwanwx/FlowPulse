"""Provider truth-mode seams: no implicit fake or external default exists."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.provider_gateway import (
    DeterministicConversationProvider,
    ProviderConfigurationError,
    ProviderMode,
    ProviderSettings,
    ProviderTruthLabel,
    build_conversation_provider,
    build_investigation_providers,
)
from flowpulse_cp.config import WorkerSettings
from flowpulse_cp.temporal_runtime import resolve_worker_provider_dependencies
from flowpulse_cp.workspace_investigation import (
    DeterministicInvestigationCritic,
    DeterministicInvestigationSynthesizer,
    UnavailableInvestigationCritic,
    UnavailableInvestigationSynthesizer,
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


def worker_environment(mode=None, deterministic_switch=None):
    environment = {
        "FLOWPULSE_TEMPORAL_ADDRESS": "temporal:7233",
        "FLOWPULSE_POSTGRES_DSN": "postgresql://local",
        "FLOWPULSE_OBJECT_STORE_ENDPOINT": "http://minio:9000",
        "FLOWPULSE_OBJECT_STORE_BUCKET": "evidence",
        "FLOWPULSE_OBJECT_STORE_ACCESS_KEY": "writer",
        "FLOWPULSE_OBJECT_STORE_SECRET_KEY": "writer-local-only",
        "FLOWPULSE_SOURCE_READ_ENDPOINT": "http://minio:9000",
        "FLOWPULSE_SOURCE_READ_BUCKET": "sources",
        "FLOWPULSE_SOURCE_READ_PREFIX": "controlled",
        "FLOWPULSE_SOURCE_READ_TENANT_ID": "tenant-a",
        "FLOWPULSE_SOURCE_READ_ACCESS_KEY": "reader",
        "FLOWPULSE_SOURCE_READ_SECRET_KEY": "reader-local-only",
        "FLOWPULSE_AUTHORIZATION_SERVICE_URL": "http://authz:8091",
        "FLOWPULSE_AUTHORIZATION_SERVICE_TOKEN": "worker-authz-local-only",
        "FLOWPULSE_TEMPORAL_TASK_QUEUE": "test-queue",
    }
    if mode is not None:
        environment["FLOWPULSE_PROVIDER_MODE"] = mode
    if deterministic_switch is not None:
        environment["FLOWPULSE_ENABLE_DETERMINISTIC_TEST_PROVIDERS"] = deterministic_switch
    return environment


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
            membership=GraphMembership.CLASSIFIED, classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        ), graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            membership=GraphMembership.CLASSIFIED, classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        )], edges=[]), recorded_evidence_refs=["evidence-current"], knowledge_prior_refs=[],
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
    def test_worker_explicit_test_opt_in_resolves_all_deterministic_roles(self):
        with patch.dict(os.environ, worker_environment("test", "1"), clear=True):
            settings = WorkerSettings.from_environment()
        self.assertTrue(settings.deterministic_test_providers_enabled)

        conversation, synthesis, critic = resolve_worker_provider_dependencies(
            settings.provider_settings,
            settings.deterministic_test_providers_enabled,
        )
        result = asyncio.run(conversation.complete(request()))
        self.assertEqual(ProviderTruthLabel.TEST_DETERMINISTIC, result.truth_label)
        self.assertEqual("deterministic-test-provider", result.provider_id)
        self.assertIsInstance(synthesis, DeterministicInvestigationSynthesizer)
        self.assertEqual(ProviderTruthLabel.TEST_DETERMINISTIC, synthesis.truth_label)
        self.assertIsInstance(critic, DeterministicInvestigationCritic)
        self.assertNotEqual(synthesis.provider_id, critic.identity)

    def test_worker_test_mode_without_opt_in_remains_unavailable(self):
        with patch.dict(os.environ, worker_environment("test"), clear=True):
            settings = WorkerSettings.from_environment()
        self.assertFalse(settings.deterministic_test_providers_enabled)

        conversation, synthesis, critic = resolve_worker_provider_dependencies(
            settings.provider_settings,
            settings.deterministic_test_providers_enabled,
        )
        self.assertEqual(
            ProviderTruthLabel.DEGRADED,
            asyncio.run(conversation.complete(request())).truth_label,
        )
        self.assertIsInstance(synthesis, UnavailableInvestigationSynthesizer)
        self.assertIsInstance(critic, UnavailableInvestigationCritic)

    def test_worker_default_mode_remains_standard_and_unavailable(self):
        with patch.dict(os.environ, worker_environment(), clear=True):
            settings = WorkerSettings.from_environment()
        self.assertEqual(ProviderMode.STANDARD, settings.provider_settings.mode)
        self.assertFalse(settings.deterministic_test_providers_enabled)

        conversation, synthesis, critic = resolve_worker_provider_dependencies(
            settings.provider_settings,
            settings.deterministic_test_providers_enabled,
        )
        self.assertEqual(
            "provider_unavailable",
            asyncio.run(conversation.complete(request())).degraded_code,
        )
        self.assertIsInstance(synthesis, UnavailableInvestigationSynthesizer)
        self.assertIsInstance(critic, UnavailableInvestigationCritic)

    def test_worker_deterministic_switch_is_rejected_outside_test_mode(self):
        for mode in ("standard", "demo"):
            with self.subTest(mode=mode), patch.dict(
                os.environ, worker_environment(mode, "1"), clear=True,
            ):
                with self.assertRaisesRegex(
                    ProviderConfigurationError,
                    "deterministic_test_providers_require_explicit_test_mode",
                ):
                    WorkerSettings.from_environment()

        valid_non_test_settings = (
            ProviderSettings(mode=ProviderMode.STANDARD),
            ProviderSettings(mode=ProviderMode.DEMO),
            ProviderSettings(
                mode=ProviderMode.LOCAL_OPEN_SOURCE,
                base_url="http://127.0.0.1:11434/v1",
                model="local-model",
            ),
            ProviderSettings(
                mode=ProviderMode.OPENAI_COMPATIBLE,
                base_url="https://provider.invalid/v1",
                model="configured-model",
                api_key="test-only-key",
            ),
        )
        for settings in valid_non_test_settings:
            with self.subTest(resolver_mode=settings.mode):
                with self.assertRaisesRegex(
                    ProviderConfigurationError,
                    "deterministic_provider_requires_explicit_test_mode",
                ):
                    resolve_worker_provider_dependencies(settings, True)

    def test_worker_deterministic_switch_rejects_non_boolean_text(self):
        with patch.dict(
            os.environ, worker_environment("test", "true"), clear=True,
        ):
            with self.assertRaisesRegex(
                ProviderConfigurationError,
                "deterministic_test_providers_switch_must_be_0_or_1",
            ):
                WorkerSettings.from_environment()

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

    def test_investigation_roles_are_paired_and_deterministic_only_in_explicit_test_mode(self):
        synthesis, critic = build_investigation_providers(
            ProviderSettings(mode=ProviderMode.STANDARD),
        )
        self.assertIsInstance(synthesis, UnavailableInvestigationSynthesizer)
        self.assertIsInstance(critic, UnavailableInvestigationCritic)
        deterministic_synthesis = DeterministicInvestigationSynthesizer()
        deterministic_critic = DeterministicInvestigationCritic()
        with self.assertRaisesRegex(
            ProviderConfigurationError,
            "deterministic_investigation_provider_requires_explicit_test_mode",
        ):
            build_investigation_providers(
                ProviderSettings(mode=ProviderMode.STANDARD),
                deterministic_synthesizer=deterministic_synthesis,
                deterministic_critic=deterministic_critic,
            )
        resolved = build_investigation_providers(
            ProviderSettings(mode=ProviderMode.TEST),
            deterministic_synthesizer=deterministic_synthesis,
            deterministic_critic=deterministic_critic,
        )
        self.assertEqual((deterministic_synthesis, deterministic_critic), resolved)


if __name__ == "__main__":
    unittest.main()

"""Bounded Conversation Manager used only inside a Temporal activity."""

from dataclasses import dataclass
from hashlib import sha256
from typing import List, Sequence

from pydantic import ValidationError

from .capabilities import CapabilityAudience, CapabilityRegistry
from .provider_gateway import ConversationProvider, ProviderGatewayError
from .workspace_models import (
    ConversationContext,
    ConversationProviderOutput,
    ConversationProviderRequest,
    ConversationRole,
    ConversationTrace,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    PromptBundle,
    PromptLayer,
    ProviderTruthLabel,
    VersionBundle,
)


CORE_POLICY_TEXT = (
    "Use only the supplied recorded incident context. Do not call a fresh tool, "
    "claim a new diagnosis, alter authority, or propose a production action."
)
ROLE_PROMPTS = {
    ConversationRole.CONVERSATION_MANAGER: "Explain the selected component using only cited recorded context.",
    ConversationRole.EVIDENCE_SPECIALIST: "Check citation coverage and state uncertainty from recorded context.",
    ConversationRole.TOPOLOGY_SPECIALIST: "Explain only the supplied component graph relationship.",
}


def _hash(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ManagedConversation:
    summary: str
    evidence_refs: List[str]
    truth_label: ProviderTruthLabel
    trace: ConversationTrace
    degraded_code: str = None


class ConversationManager:
    """Builds pinned context, invokes at most two server-selected specialists, and validates output."""

    def __init__(
        self,
        provider: ConversationProvider,
        capability_registry: CapabilityRegistry,
        *,
        specialist_roles: Sequence[ConversationRole] = (),
        version_bundle: VersionBundle = None,
        max_output_tokens: int = 384,
    ) -> None:
        if len(specialist_roles) > 2:
            raise ValueError("conversation_specialist_cap_exceeded")
        if len(specialist_roles) != len(set(specialist_roles)):
            raise ValueError("conversation_specialist_roles_must_be_unique")
        if ConversationRole.CONVERSATION_MANAGER in specialist_roles:
            raise ValueError("conversation_manager_role_must_not_be_specialist")
        if not isinstance(max_output_tokens, int) or isinstance(max_output_tokens, bool) or not 1 <= max_output_tokens <= 2048:
            raise ValueError("conversation_output_token_budget_invalid")
        self.provider = provider
        self.capability_registry = capability_registry
        self.specialist_roles = list(specialist_roles)
        self.version_bundle = version_bundle or VersionBundle(policy_version=capability_registry.policy_version)
        self.max_output_tokens = max_output_tokens

    def _context(
        self, binding: IncidentRunBinding, projection: IncidentProjection, command: NodeExplanationStart,
    ) -> ConversationContext:
        component = next(node for node in projection.graph.nodes if node.component_id == command.component_id)
        capabilities = [
            descriptor.capability.value
            for descriptor in self.capability_registry.available(CapabilityAudience.USER_QA)
        ]
        return ConversationContext(
            **binding.dict(), projection_revision=projection.projection_revision,
            component=component, graph=projection.graph,
            recorded_evidence_refs=list(projection.evidence_refs), knowledge_prior_refs=[],
            available_capabilities=capabilities, max_tool_calls=0,
        )
    def _prompt_bundle(self, role: ConversationRole) -> PromptBundle:
        layers = [
            PromptLayer(layer="core_policy", version=self.version_bundle.core_policy_version, content_hash=_hash(CORE_POLICY_TEXT)),
            PromptLayer(
                layer="role_prompt", version=self.version_bundle.role_prompt_version,
                content_hash=_hash(ROLE_PROMPTS[role]),
            ),
        ]
        combined = "|".join("{}:{}:{}".format(layer.layer, layer.version, layer.content_hash) for layer in layers)
        return PromptBundle(role=role, layers=layers, prompt_hash=_hash(combined))

    def _trace(
        self,
        *,
        truth_label: ProviderTruthLabel,
        provider_id: str,
        model_id: str,
        context: ConversationContext,
        prompt_bundles: List[PromptBundle],
        provider_calls: int,
        input_tokens: int,
        output_tokens: int,
    ) -> ConversationTrace:
        return ConversationTrace(
            truth_label=truth_label, provider_id=provider_id, model_id=model_id,
            version_bundle=self.version_bundle, prompt_bundles=prompt_bundles,
            context_hash=context.canonical_hash(), provider_call_count=provider_calls,
            specialist_roles=self.specialist_roles,
            available_capabilities=list(context.available_capabilities), tool_calls=0,
            input_tokens=input_tokens, output_tokens=output_tokens,
        )

    def _degraded(
        self,
        code: str,
        context: ConversationContext,
        prompt_bundles: List[PromptBundle],
        provider_id: str = "unconfigured-provider",
        model_id: str = None,
        provider_calls: int = 0,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> ManagedConversation:
        return ManagedConversation(
            summary="Provider output is unavailable; no fresh read or diagnosis was performed.",
            evidence_refs=list(context.recorded_evidence_refs),
            truth_label=ProviderTruthLabel.DEGRADED,
            trace=self._trace(
                truth_label=ProviderTruthLabel.DEGRADED, provider_id=provider_id, model_id=model_id,
                context=context, prompt_bundles=prompt_bundles, provider_calls=provider_calls,
                input_tokens=input_tokens, output_tokens=output_tokens,
            ),
            degraded_code=code,
        )

    async def explain(
        self, binding: IncidentRunBinding, projection: IncidentProjection, command: NodeExplanationStart,
    ) -> ManagedConversation:
        """Run only server-selected roles. No capability call can occur before Gate 1."""
        context = self._context(binding, projection, command)
        allowed_evidence = set(context.recorded_evidence_refs).union(context.knowledge_prior_refs)
        prompt_bundles: List[PromptBundle] = []
        outputs: List[ConversationProviderOutput] = []
        truth_label = None
        provider_id = "unconfigured-provider"
        model_id = None
        input_tokens = 0
        output_tokens = 0
        for role in [ConversationRole.CONVERSATION_MANAGER] + self.specialist_roles:
            prompt = self._prompt_bundle(role)
            prompt_bundles.append(prompt)
            request = ConversationProviderRequest(
                role=role, context=context, prompt_bundle_version=prompt.schema_version,
                prompt_hash=prompt.prompt_hash, context_hash=context.canonical_hash(),
                max_output_tokens=self.max_output_tokens,
            )
            try:
                result = await self.provider.complete(request)
            except ProviderGatewayError:
                return self._degraded("provider_request_failed", context, prompt_bundles, provider_calls=len(outputs))
            provider_id = result.provider_id
            model_id = result.model_id
            input_tokens += result.input_tokens
            output_tokens += result.output_tokens
            if result.truth_label == ProviderTruthLabel.DEGRADED or result.output is None:
                return self._degraded(
                    result.degraded_code or "provider_unavailable", context, prompt_bundles,
                    provider_id=provider_id, model_id=model_id, provider_calls=len(outputs),
                    input_tokens=input_tokens, output_tokens=output_tokens,
                )
            try:
                output = ConversationProviderOutput.parse_obj(result.output)
            except ValidationError:
                return self._degraded(
                    "provider_output_schema_invalid", context, prompt_bundles,
                    provider_id=provider_id, model_id=model_id, provider_calls=len(outputs) + 1,
                    input_tokens=input_tokens, output_tokens=output_tokens,
                )
            if not set(output.evidence_refs).issubset(allowed_evidence):
                return self._degraded(
                    "provider_output_evidence_not_in_context", context, prompt_bundles,
                    provider_id=provider_id, model_id=model_id, provider_calls=len(outputs) + 1,
                    input_tokens=input_tokens, output_tokens=output_tokens,
                )
            if truth_label is not None and result.truth_label != truth_label:
                return self._degraded(
                    "provider_truth_label_inconsistent", context, prompt_bundles,
                    provider_id=provider_id, model_id=model_id, provider_calls=len(outputs) + 1,
                    input_tokens=input_tokens, output_tokens=output_tokens,
                )
            truth_label = result.truth_label
            outputs.append(output)
        evidence_refs = []
        for output in outputs:
            for evidence_id in output.evidence_refs:
                if evidence_id not in evidence_refs:
                    evidence_refs.append(evidence_id)
        return ManagedConversation(
            summary=" ".join(output.summary for output in outputs),
            evidence_refs=evidence_refs,
            truth_label=truth_label or ProviderTruthLabel.DEGRADED,
            trace=self._trace(
                truth_label=truth_label or ProviderTruthLabel.DEGRADED,
                provider_id=provider_id, model_id=model_id, context=context, prompt_bundles=prompt_bundles,
                provider_calls=len(outputs), input_tokens=input_tokens, output_tokens=output_tokens,
            ),
        )

"""Typed, opt-in conversation-provider boundary for Temporal activities.

No provider endpoint, credential, or deterministic fallback is selected by
default.  The caller must explicitly inject the deterministic provider in
``test`` mode, or explicitly configure an OpenAI-compatible endpoint.
"""

import asyncio
from dataclasses import dataclass
from enum import Enum
import json
import os
from typing import Any, Dict, Optional, Protocol
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from pydantic import ValidationError

from .workspace_models import (
    ConversationProviderOutput,
    ConversationProviderRequest,
    ProviderTruthLabel,
)
from .workspace_investigation import (
    DeterministicInvestigationCritic,
    DeterministicInvestigationSynthesizer,
    InvestigationCriticOutput,
    InvestigationCriticRequest,
    InvestigationSynthesisOutput,
    InvestigationSynthesisRequest,
    UnavailableInvestigationCritic,
    UnavailableInvestigationSynthesizer,
)


class ProviderConfigurationError(RuntimeError):
    pass


class ProviderGatewayError(RuntimeError):
    pass


class ProviderMode(str, Enum):
    STANDARD = "standard"
    TEST = "test"
    DEMO = "demo"
    LOCAL_OPEN_SOURCE = "local-open-source"
    OPENAI_COMPATIBLE = "openai-compatible"


@dataclass(frozen=True)
class ProviderSettings:
    """Configuration is inert until an explicit non-standard mode is selected."""

    mode: ProviderMode = ProviderMode.STANDARD
    base_url: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    timeout_seconds: int = 10
    max_output_tokens: int = 384

    @classmethod
    def from_environment(cls) -> "ProviderSettings":
        raw_mode = os.environ.get("FLOWPULSE_PROVIDER_MODE", ProviderMode.STANDARD.value)
        try:
            mode = ProviderMode(raw_mode)
        except ValueError as error:
            raise ProviderConfigurationError("provider_mode_invalid") from error
        if mode not in {ProviderMode.LOCAL_OPEN_SOURCE, ProviderMode.OPENAI_COMPATIBLE}:
            return cls(mode=mode).validate()
        base_url = os.environ.get("FLOWPULSE_OPENAI_COMPATIBLE_BASE_URL")
        model = os.environ.get("FLOWPULSE_OPENAI_COMPATIBLE_MODEL")
        api_key = (
            os.environ.get("FLOWPULSE_OPENAI_COMPATIBLE_API_KEY")
            if mode == ProviderMode.OPENAI_COMPATIBLE else os.environ.get("FLOWPULSE_LOCAL_OPENAI_COMPATIBLE_API_KEY")
        )
        timeout_text = os.environ.get("FLOWPULSE_PROVIDER_TIMEOUT_SECONDS", "10")
        tokens_text = os.environ.get("FLOWPULSE_PROVIDER_MAX_OUTPUT_TOKENS", "384")
        try:
            settings = cls(
                mode=mode, base_url=base_url, model=model, api_key=api_key,
                timeout_seconds=int(timeout_text), max_output_tokens=int(tokens_text),
            )
        except ValueError as error:
            raise ProviderConfigurationError("provider_budget_configuration_invalid") from error
        return settings.validate()

    def validate(self) -> "ProviderSettings":
        if self.timeout_seconds < 1 or self.timeout_seconds > 60:
            raise ProviderConfigurationError("provider_timeout_out_of_range")
        if self.max_output_tokens < 1 or self.max_output_tokens > 2048:
            raise ProviderConfigurationError("provider_output_token_budget_out_of_range")
        if self.mode in {ProviderMode.STANDARD, ProviderMode.TEST, ProviderMode.DEMO}:
            if self.base_url or self.model or self.api_key:
                raise ProviderConfigurationError("provider_endpoint_forbidden_for_selected_mode")
            return self
        if not self.base_url or not self.model:
            raise ProviderConfigurationError("provider_endpoint_or_model_missing")
        parsed = urlparse(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ProviderConfigurationError("provider_endpoint_invalid")
        if self.mode == ProviderMode.LOCAL_OPEN_SOURCE and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ProviderConfigurationError("local_open_source_endpoint_must_be_loopback")
        if self.mode == ProviderMode.OPENAI_COMPATIBLE and not self.api_key:
            raise ProviderConfigurationError("openai_compatible_api_key_required")
        return self


@dataclass(frozen=True)
class ProviderGatewayResult:
    truth_label: ProviderTruthLabel
    provider_id: str
    model_id: Optional[str]
    output: Optional[ConversationProviderOutput]
    degraded_code: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0


class ConversationProvider(Protocol):
    async def complete(self, request: ConversationProviderRequest) -> ProviderGatewayResult:
        """Return only a schema-validated output or a truthful degraded result."""


class UnavailableConversationProvider:
    async def complete(self, request: ConversationProviderRequest) -> ProviderGatewayResult:
        return ProviderGatewayResult(
            truth_label=ProviderTruthLabel.DEGRADED,
            provider_id="unconfigured-provider",
            model_id=None,
            output=None,
            degraded_code="provider_unavailable",
        )


class DeterministicConversationProvider:
    """No-network test double; factory injection is forbidden outside test mode."""

    async def complete(self, request: ConversationProviderRequest) -> ProviderGatewayResult:
        references = list(request.context.recorded_evidence_refs[:1])
        return ProviderGatewayResult(
            truth_label=ProviderTruthLabel.TEST_DETERMINISTIC,
            provider_id="deterministic-test-provider",
            model_id="deterministic-test-v1",
            output=ConversationProviderOutput(
                summary="Test-only explanation assembled from recorded incident context.",
                evidence_refs=references,
                abstained=False,
            ),
            input_tokens=0,
            output_tokens=0,
        )


class OpenAICompatibleConversationProvider:
    """Explicit OpenAI-compatible HTTP client; it has no default endpoint."""

    def __init__(self, settings: ProviderSettings) -> None:
        self.settings = settings.validate()
        if self.settings.mode not in {ProviderMode.LOCAL_OPEN_SOURCE, ProviderMode.OPENAI_COMPATIBLE}:
            raise ProviderConfigurationError("openai_compatible_provider_mode_required")

    def _endpoint(self) -> str:
        base = (self.settings.base_url or "").rstrip("/")
        return base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")

    def _payload(self, request: ConversationProviderRequest) -> Dict[str, Any]:
        return {
            "model": self.settings.model,
            "temperature": 0,
            "max_tokens": request.max_output_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return a JSON object with only summary, evidence_refs, and abstained. "
                        "Do not claim a fresh diagnosis or request a tool."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({
                        "role": request.role.value,
                        "context": request.context.dict(),
                        "prompt_bundle_version": request.prompt_bundle_version,
                        "prompt_hash": request.prompt_hash,
                        "context_hash": request.context_hash,
                    }, sort_keys=True, default=str),
                },
            ],
        }

    def _request_sync(self, request: ConversationProviderRequest) -> ProviderGatewayResult:
        headers = {"content-type": "application/json"}
        if self.settings.api_key:
            headers["authorization"] = "Bearer " + self.settings.api_key
        body = json.dumps(self._payload(request), separators=(",", ":")).encode("utf-8")
        try:
            with urlopen(Request(self._endpoint(), data=body, headers=headers, method="POST"), timeout=self.settings.timeout_seconds) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except Exception as error:
            raise ProviderGatewayError("provider_request_failed") from error
        try:
            content = decoded["choices"][0]["message"]["content"]
            output = ConversationProviderOutput.parse_obj(json.loads(content))
        except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValidationError) as error:
            raise ProviderGatewayError("provider_output_schema_invalid") from error
        usage = decoded.get("usage", {}) if isinstance(decoded, dict) else {}
        return ProviderGatewayResult(
            truth_label=ProviderTruthLabel.LIVE,
            provider_id="openai-compatible",
            model_id=self.settings.model,
            output=output,
            input_tokens=int(usage.get("prompt_tokens", 0)),
            output_tokens=int(usage.get("completion_tokens", 0)),
        )

    async def complete(self, request: ConversationProviderRequest) -> ProviderGatewayResult:
        return await asyncio.to_thread(self._request_sync, request)


def _openai_compatible_json(
    settings: ProviderSettings,
    *,
    system_prompt: str,
    input_payload: Dict[str, Any],
) -> Dict[str, Any]:
    base = (settings.base_url or "").rstrip("/")
    endpoint = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
    headers = {"content-type": "application/json"}
    if settings.api_key:
        headers["authorization"] = "Bearer " + settings.api_key
    payload = {
        "model": settings.model,
        "temperature": 0,
        "max_tokens": settings.max_output_tokens,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(input_payload, sort_keys=True, default=str)},
        ],
    }
    try:
        with urlopen(
            Request(
                endpoint,
                data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                headers=headers,
                method="POST",
            ),
            timeout=settings.timeout_seconds,
        ) as response:
            decoded = json.loads(response.read().decode("utf-8"))
        return json.loads(decoded["choices"][0]["message"]["content"])
    except Exception as error:
        raise ProviderGatewayError("provider_request_or_output_failed") from error


class OpenAICompatibleInvestigationSynthesizer:
    """Opt-in provider for candidates only; the workflow still owns acceptance."""

    truth_label = ProviderTruthLabel.LIVE
    provider_id = "openai-compatible-investigation-synthesizer"

    def __init__(self, settings: ProviderSettings) -> None:
        self.settings = settings.validate()
        if self.settings.mode not in {ProviderMode.LOCAL_OPEN_SOURCE, ProviderMode.OPENAI_COMPATIBLE}:
            raise ProviderConfigurationError("openai_compatible_provider_mode_required")
        self.model_id = self.settings.model

    def _synthesize_sync(self, request: InvestigationSynthesisRequest) -> InvestigationSynthesisOutput:
        payload = {
            "component_id": request.component_id,
            "observations": [
                {
                    "claim_type": item.claim_type,
                    "statement": item.statement,
                    "evidence_refs": item.evidence_ids,
                }
                for item in request.observations
            ],
            "evidence": [
                {
                    "evidence_id": item.evidence_id,
                    "source_kind": item.source_kind.value,
                    "observed_at": item.observed_at.isoformat(),
                    "freshness": item.freshness.value,
                    "authority": item.authority.value,
                    "proof_scope": item.proof_scope.value,
                    "parent_evidence_refs": item.parent_evidence_ids,
                }
                for item in request.evidence
            ],
        }
        raw = _openai_compatible_json(
            self.settings,
            system_prompt=(
                "Return a JSON object with only summary, hypotheses, and abstained. "
                "Each hypothesis has only statement and evidence_refs. Cite only supplied evidence IDs. "
                "Do not emit lifecycle, authority, tool, action, tenant, run, or component fields."
            ),
            input_payload=payload,
        )
        try:
            return InvestigationSynthesisOutput.parse_obj(raw)
        except ValidationError as error:
            raise ProviderGatewayError("investigation_provider_output_schema_invalid") from error

    async def synthesize(self, request: InvestigationSynthesisRequest) -> InvestigationSynthesisOutput:
        return await asyncio.to_thread(self._synthesize_sync, request)


class OpenAICompatibleInvestigationCritic:
    """Separate provider role and activity identity for evidence-bound criticism."""

    def __init__(self, settings: ProviderSettings) -> None:
        self.settings = settings.validate()
        if self.settings.mode not in {ProviderMode.LOCAL_OPEN_SOURCE, ProviderMode.OPENAI_COMPATIBLE}:
            raise ProviderConfigurationError("openai_compatible_provider_mode_required")
        self.identity = "openai-compatible-independent-critic:{}".format(self.settings.model)

    def _critique_sync(self, request: InvestigationCriticRequest) -> InvestigationCriticOutput:
        payload = {
            "component_id": request.component_id,
            "candidate": {
                "summary": request.synthesis.summary,
                "hypotheses": [item.dict() for item in request.synthesis.hypotheses],
                "evidence_refs": request.synthesis.evidence_refs,
            },
            "observations": [
                {
                    "claim_type": item.claim_type,
                    "statement": item.statement,
                    "evidence_refs": item.evidence_ids,
                }
                for item in request.observations
            ],
            "evidence": [
                {
                    "evidence_id": item.evidence_id,
                    "freshness": item.freshness.value,
                    "authority": item.authority.value,
                    "proof_scope": item.proof_scope.value,
                }
                for item in request.evidence
            ],
        }
        raw = _openai_compatible_json(
            self.settings,
            system_prompt=(
                "Independently evaluate whether every candidate claim is supported by supplied current evidence. "
                "Return a JSON object with only decision (PASS, FAIL, or AMBIGUOUS) and reason_codes."
            ),
            input_payload=payload,
        )
        try:
            return InvestigationCriticOutput.parse_obj(raw)
        except ValidationError as error:
            raise ProviderGatewayError("investigation_critic_output_schema_invalid") from error

    async def critique(self, request: InvestigationCriticRequest) -> InvestigationCriticOutput:
        return await asyncio.to_thread(self._critique_sync, request)


def build_conversation_provider(
    settings: ProviderSettings, *, deterministic_provider: Optional[DeterministicConversationProvider] = None,
) -> ConversationProvider:
    """Build an explicit provider without silently substituting deterministic output."""

    settings.validate()
    if deterministic_provider is not None:
        if settings.mode != ProviderMode.TEST:
            raise ProviderConfigurationError("deterministic_provider_requires_explicit_test_mode")
        return deterministic_provider
    if settings.mode in {ProviderMode.LOCAL_OPEN_SOURCE, ProviderMode.OPENAI_COMPATIBLE}:
        return OpenAICompatibleConversationProvider(settings)
    return UnavailableConversationProvider()


def build_investigation_providers(
    settings: ProviderSettings,
    *,
    deterministic_synthesizer: Optional[DeterministicInvestigationSynthesizer] = None,
    deterministic_critic: Optional[DeterministicInvestigationCritic] = None,
):
    """Resolve both roles together so no accepted path can silently use a fake."""

    settings.validate()
    if (deterministic_synthesizer is None) != (deterministic_critic is None):
        raise ProviderConfigurationError("deterministic_investigation_provider_pair_required")
    if deterministic_synthesizer is not None:
        if settings.mode != ProviderMode.TEST:
            raise ProviderConfigurationError(
                "deterministic_investigation_provider_requires_explicit_test_mode",
            )
        return deterministic_synthesizer, deterministic_critic
    if settings.mode in {ProviderMode.LOCAL_OPEN_SOURCE, ProviderMode.OPENAI_COMPATIBLE}:
        return (
            OpenAICompatibleInvestigationSynthesizer(settings),
            OpenAICompatibleInvestigationCritic(settings),
        )
    return UnavailableInvestigationSynthesizer(), UnavailableInvestigationCritic()

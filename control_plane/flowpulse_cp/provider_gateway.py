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

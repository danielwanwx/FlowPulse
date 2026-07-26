"""Shared, fail-closed capability registry for autonomous and user Q&A paths."""

import inspect
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Mapping, Optional, Protocol
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import Field, StrictBool, StrictStr, validator

from .models import Hash, NonEmpty, NonNegativeInt, StrictModel
from .policy import PolicyViolation
from .workspace_models import IncidentRunBinding


class CapabilityAudience(str, Enum):
    AUTONOMOUS_DIAGNOSIS = "AUTONOMOUS_DIAGNOSIS"
    USER_QA = "USER_QA"


class CapabilityName(str, Enum):
    RECORDED_CONTEXT = "RECORDED_CONTEXT"
    METRICS = "METRICS"
    LOGS = "LOGS"
    TRACES = "TRACES"
    TOPOLOGY = "TOPOLOGY"
    DEPLOY_CONFIG = "DEPLOY_CONFIG"
    KAFKA = "KAFKA"
    GITHUB_TICKETING = "GITHUB_TICKETING"
    SAFE_ACTION = "SAFE_ACTION"


class CapabilityDescriptor(StrictModel):
    capability: CapabilityName
    version: NonEmpty
    fresh_read: StrictBool
    enabled: StrictBool
    audiences: List[CapabilityAudience] = Field(min_items=1)

    @validator("audiences", allow_reuse=True)
    def audiences_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("capability_audiences_must_be_unique")
        return value


class CapabilityInvocationContext(IncidentRunBinding):
    projection_revision: NonNegativeInt
    component_ids: List[NonEmpty] = Field(min_items=1)
    activity_id: NonEmpty
    gate1_authorized: StrictBool = False

    @validator("component_ids", allow_reuse=True)
    def component_ids_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("capability_component_ids_must_be_unique")
        return value


class CapabilityRequest(StrictModel):
    capability: CapabilityName
    component_id: NonEmpty
    parameters: Dict[NonEmpty, StrictStr] = Field(default_factory=dict)

    @validator("parameters", allow_reuse=True)
    def parameters_are_bounded(cls, value):
        if len(value) > 8:
            raise ValueError("capability_parameters_too_many")
        return value


class CapabilityResult(StrictModel):
    summary: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list)


class CapabilityAuditRecord(IncidentRunBinding):
    audit_id: UUID
    projection_revision: NonNegativeInt
    activity_id: NonEmpty
    audience: CapabilityAudience
    capability: CapabilityName
    capability_version: NonEmpty
    policy_version: NonEmpty
    request_hash: Hash
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    status: NonEmpty = "COMPLETED"
    created_at: datetime


class CapabilityAdapter(Protocol):
    descriptor: CapabilityDescriptor

    async def invoke(
        self, request: CapabilityRequest, invocation_context: CapabilityInvocationContext,
    ) -> CapabilityResult:
        """Run one bounded adapter call after registry policy validation."""


class CapabilityAuditSink(Protocol):
    async def append_workspace_capability_audit(self, audit: CapabilityAuditRecord) -> CapabilityAuditRecord:
        """Durably append the audit record; no update/replacement is allowed."""


class ToolCallBudget:
    """Mutable execution-local counter; the authoritative maximum is in the packet/context."""

    def __init__(self, max_calls: int) -> None:
        if not isinstance(max_calls, int) or isinstance(max_calls, bool) or max_calls < 0:
            raise ValueError("capability_tool_budget_invalid")
        self.max_calls = max_calls
        self.used_calls = 0

    def consume(self) -> None:
        if self.used_calls >= self.max_calls:
            raise PolicyViolation("capability_tool_budget_exhausted")
        self.used_calls += 1


@dataclass(frozen=True)
class CapabilityInvocationResult:
    result: CapabilityResult
    audit: CapabilityAuditRecord


class CapabilityRegistry:
    """One policy and audit format across autonomous and conversational callers."""

    def __init__(
        self,
        descriptors: Iterable[CapabilityDescriptor] = (),
        adapters: Mapping[CapabilityName, CapabilityAdapter] = None,
        *,
        policy_version: str = "capability-policy.v1",
        audit_sink: Optional[CapabilityAuditSink] = None,
    ) -> None:
        self._descriptors = {}
        for descriptor in descriptors:
            if descriptor.capability in self._descriptors:
                raise ValueError("capability_descriptor_duplicate")
            self._descriptors[descriptor.capability] = descriptor
        self._adapters = dict(adapters or {})
        for capability, adapter in self._adapters.items():
            descriptor = self._descriptors.get(capability)
            if descriptor is None or adapter.descriptor != descriptor:
                raise ValueError("capability_adapter_descriptor_mismatch")
        if not policy_version:
            raise ValueError("capability_policy_version_required")
        self.policy_version = policy_version
        self.audit_sink = audit_sink
        self.audit_records: List[CapabilityAuditRecord] = []

    def available(self, audience: CapabilityAudience) -> List[CapabilityDescriptor]:
        """Return only enabled, bound capabilities; unbound is never decorative."""
        return [
            descriptor for capability, descriptor in sorted(self._descriptors.items(), key=lambda item: item[0].value)
            if descriptor.enabled and capability in self._adapters and audience in descriptor.audiences
        ]

    async def invoke(
        self,
        audience: CapabilityAudience,
        invocation_context: CapabilityInvocationContext,
        request: CapabilityRequest,
        budget: ToolCallBudget,
    ) -> CapabilityInvocationResult:
        descriptor = next(
            (item for item in self.available(audience) if item.capability == request.capability), None,
        )
        if descriptor is None:
            raise PolicyViolation("capability_unavailable")
        if request.component_id not in invocation_context.component_ids:
            raise PolicyViolation("capability_component_not_canonical")
        if descriptor.fresh_read and not invocation_context.gate1_authorized:
            raise PolicyViolation("capability_gate1_required")
        budget.consume()
        adapter = self._adapters[request.capability]
        raw_result = adapter.invoke(request, invocation_context)
        result = await raw_result if inspect.isawaitable(raw_result) else raw_result
        try:
            result = CapabilityResult.parse_obj(result)
        except Exception as error:
            raise PolicyViolation("capability_result_schema_invalid") from error
        request_hash = sha256(request.json(sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        audit = CapabilityAuditRecord(
            **{
                field: getattr(invocation_context, field)
                for field in IncidentRunBinding.__fields__ if field != "created_at"
            },
            audit_id=uuid5(
                NAMESPACE_URL,
                "capability:{}:{}:{}:{}:{}:{}".format(
                    invocation_context.tenant_id, invocation_context.run_id, invocation_context.activity_id,
                    audience.value, request.capability.value, request_hash,
                ),
            ),
            projection_revision=invocation_context.projection_revision,
            activity_id=invocation_context.activity_id,
            audience=audience,
            capability=request.capability,
            capability_version=descriptor.version,
            policy_version=self.policy_version,
            request_hash=request_hash,
            evidence_refs=list(result.evidence_refs),
            # The activity packet's Temporal-owned binding time makes an exact
            # retry byte-identical instead of creating a replacement audit.
            created_at=invocation_context.created_at,
        )
        self.audit_records.append(audit)
        if self.audit_sink is not None:
            persisted = self.audit_sink.append_workspace_capability_audit(audit)
            if inspect.isawaitable(persisted):
                await persisted
        return CapabilityInvocationResult(result=result, audit=audit)

"""One strict capability boundary for diagnosis and user Q&A.

Adapters never receive a browser-shaped dictionary.  The registry validates a
server-issued scope, resolves the capability-specific input model, admits any
returned evidence through the existing evidence boundary, then appends one
immutable audit record.  An unavailable adapter is absent from the registry.
"""

import inspect
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Mapping, Optional, Protocol, Type
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import Field, StrictBool, StrictStr, root_validator, validator

from .models import ClaimRecord, CoverageEntry, EvidenceEnvelope, Hash, NonEmpty, NonNegativeInt, StrictModel
from .policy import PolicyViolation
from .workspace_models import IncidentRunBinding


class CapabilityAudience(str, Enum):
    AUTONOMOUS_DIAGNOSIS = "AUTONOMOUS_DIAGNOSIS"
    USER_QA = "USER_QA"


class CapabilityScope(str, Enum):
    AUTONOMOUS_DIAGNOSIS = "AUTONOMOUS_DIAGNOSIS"
    USER_QA = "USER_QA"


class CapabilityDataClass(str, Enum):
    CURRENT_INCIDENT = "CURRENT_INCIDENT"
    RECORDED_CONTEXT = "RECORDED_CONTEXT"
    KNOWLEDGE_REFERENCE = "KNOWLEDGE_REFERENCE"


class CapabilityGate(str, Enum):
    NONE = "NONE"
    SYSTEM_DIAGNOSIS = "SYSTEM_DIAGNOSIS"
    GATE1 = "GATE1"


class CapabilityName(str, Enum):
    RECORDED_CONTEXT = "RECORDED_CONTEXT"
    CURRENT_EVIDENCE = "CURRENT_EVIDENCE"
    GATE1_CURRENT_EVIDENCE = "GATE1_CURRENT_EVIDENCE"
    METRICS = "METRICS"
    LOGS = "LOGS"
    TRACES = "TRACES"
    TOPOLOGY = "TOPOLOGY"
    DEPLOY_CONFIG = "DEPLOY_CONFIG"
    KAFKA = "KAFKA"
    GITHUB_TICKETING = "GITHUB_TICKETING"
    SAFE_ACTION = "SAFE_ACTION"


class EmptyCapabilityInput(StrictModel):
    """A capability with no caller-selectable parameters."""


class RecordedContextInput(StrictModel):
    """Explicitly selects only already-recorded evidence identifiers."""

    evidence_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)

    @validator("evidence_ids", allow_reuse=True)
    def evidence_ids_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("capability_input_evidence_ids_must_be_unique")
        return value


class CapabilityDescriptor(StrictModel):
    capability: CapabilityName
    version: NonEmpty
    fresh_read: StrictBool
    enabled: StrictBool
    audiences: List[CapabilityAudience] = Field(min_items=1)
    data_classes: List[CapabilityDataClass] = Field(min_items=1)
    required_gate: CapabilityGate
    input_schema: NonEmpty

    @validator("audiences", "data_classes", allow_reuse=True)
    def values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("capability_descriptor_values_must_be_unique")
        return value

    @root_validator(allow_reuse=True)
    def fresh_reads_require_a_gate(cls, values):
        if values.get("fresh_read") and values.get("required_gate") == CapabilityGate.NONE:
            raise ValueError("fresh_capability_requires_gate")
        return values


class CapabilityInvocationContext(IncidentRunBinding):
    """Server-issued authorization scope, never a browser or model payload."""

    projection_revision: NonNegativeInt
    evidence_revision: NonNegativeInt
    component_ids: List[NonEmpty] = Field(min_items=1)
    activity_id: NonEmpty
    scope: CapabilityScope
    subject_id: NonEmpty
    subject_roles: List[NonEmpty] = Field(default_factory=list)
    subject_permissions: List[NonEmpty] = Field(default_factory=list)
    authorized_subjects: List[NonEmpty] = Field(min_items=1)
    data_class: CapabilityDataClass
    recorded_evidence_ids: List[NonEmpty] = Field(default_factory=list, max_items=64)
    max_tool_calls: NonNegativeInt = 1
    capability_registry_revision: NonEmpty = "capability-registry.v2"
    precondition_version: NonEmpty = "workspace-precondition.v1"
    precondition_hash: Hash = "0" * 64
    gate1_lease_id: Optional[NonEmpty] = None
    action_command_fingerprint: Optional[Hash] = None
    gate1_authorized: StrictBool = False
    system_authorized: StrictBool = False

    @validator("component_ids", "authorized_subjects", "subject_permissions", "recorded_evidence_ids", allow_reuse=True)
    def scope_values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("capability_scope_values_must_be_unique")
        return value


class CapabilityRequest(StrictModel):
    """Envelope whose parameter object is parsed by the selected adapter schema."""

    capability: CapabilityName
    component_id: NonEmpty
    data_class: CapabilityDataClass
    parameters: Dict[NonEmpty, Any] = Field(default_factory=dict)

    @validator("parameters", allow_reuse=True)
    def parameters_are_bounded(cls, value):
        if len(value) > 8:
            raise ValueError("capability_parameters_too_many")
        return value


class CapabilityResult(StrictModel):
    """Adapter output before the registry performs evidence admission."""

    summary: NonEmpty
    evidence: List[EvidenceEnvelope] = Field(default_factory=list, max_items=64)
    claims: List[ClaimRecord] = Field(default_factory=list, max_items=64)
    coverage: List[CoverageEntry] = Field(default_factory=list, max_items=64)


class CurrentEvidenceCapabilityResult(CapabilityResult):
    """A controlled acquisition must carry complete admissible domain records."""

    evidence: List[EvidenceEnvelope] = Field(min_items=1, max_items=64)
    claims: List[ClaimRecord] = Field(min_items=1, max_items=64)
    coverage: List[CoverageEntry] = Field(min_items=1, max_items=64)


class CapabilityAuditRecord(IncidentRunBinding):
    audit_id: UUID
    projection_revision: NonNegativeInt
    evidence_revision: NonNegativeInt
    activity_id: NonEmpty
    scope: CapabilityScope
    subject_id: NonEmpty
    audience: CapabilityAudience
    capability: CapabilityName
    component_id: NonEmpty
    capability_version: NonEmpty
    data_class: CapabilityDataClass
    required_gate: CapabilityGate
    policy_version: NonEmpty
    request_hash: Hash
    input_evidence_refs: List[NonEmpty] = Field(default_factory=list)
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    status: NonEmpty = "COMPLETED"
    created_at: datetime


class CapabilityAdapter(Protocol):
    descriptor: CapabilityDescriptor
    input_model: Type[StrictModel]
    result_model: Type[CapabilityResult]

    async def invoke(
        self, parsed_input: StrictModel, invocation_context: CapabilityInvocationContext,
    ) -> CapabilityResult:
        """Run one bounded adapter call only after registry policy validation."""


class CapabilityScopeAuthority(Protocol):
    async def assert_scope(self, invocation_context: CapabilityInvocationContext) -> None:
        """Prove tenant/public/internal/revision mapping from an authoritative store."""


class CapabilityEvidenceAdmission(Protocol):
    async def admit(
        self, result: CapabilityResult, invocation_context: CapabilityInvocationContext,
    ) -> CapabilityResult:
        """Admit complete envelopes/claims through the existing lineage boundary."""


class CapabilityAuditSink(Protocol):
    async def append_capability_audit(self, audit: CapabilityAuditRecord) -> CapabilityAuditRecord:
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


async def _maybe_await(value):
    return await value if inspect.isawaitable(value) else value


class CapabilityRegistry:
    """One enforcement and durable-audit path for diagnosis and user Q&A."""

    def __init__(
        self,
        descriptors: Iterable[CapabilityDescriptor] = (),
        adapters: Mapping[CapabilityName, CapabilityAdapter] = None,
        *,
        policy_version: str = "capability-policy.v2",
        audit_sink: Optional[CapabilityAuditSink] = None,
        scope_authority: Optional[CapabilityScopeAuthority] = None,
        gate1_authority: Optional[Any] = None,
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
            if not issubclass(adapter.input_model, StrictModel) or not issubclass(adapter.result_model, CapabilityResult):
                raise ValueError("capability_adapter_schema_contract_invalid")
        if not policy_version:
            raise ValueError("capability_policy_version_required")
        self.policy_version = policy_version
        self.audit_sink = audit_sink
        self.scope_authority = scope_authority
        self.gate1_authority = gate1_authority
        self.audit_records: Dict[UUID, CapabilityAuditRecord] = {}

    def available(self, audience: CapabilityAudience) -> List[CapabilityDescriptor]:
        """Return only enabled, bound capabilities; unbound is never decorative."""
        return [
            descriptor for capability, descriptor in sorted(self._descriptors.items(), key=lambda item: item[0].value)
            if descriptor.enabled and capability in self._adapters and audience in descriptor.audiences
        ]

    @staticmethod
    def _validate_scope_identity(invocation_context: CapabilityInvocationContext) -> None:
        if invocation_context.run_id in {invocation_context.workflow_id, invocation_context.workflow_run_id}:
            raise PolicyViolation("capability_public_run_must_not_be_temporal_identity")
        if invocation_context.subject_id not in invocation_context.authorized_subjects:
            raise PolicyViolation("capability_subject_acl_denied")

    @staticmethod
    def _validate_result_evidence(
        result: CapabilityResult, invocation_context: CapabilityInvocationContext,
    ) -> None:
        evidence_ids = [item.evidence_id for item in result.evidence]
        if len(evidence_ids) != len(set(evidence_ids)):
            raise PolicyViolation("capability_result_evidence_ids_must_be_unique")
        for evidence in result.evidence:
            if (
                evidence.tenant_id != invocation_context.tenant_id
                or evidence.case_id != invocation_context.case_id
                or evidence.case_revision != invocation_context.case_revision
            ):
                raise PolicyViolation("capability_result_evidence_scope_mismatch")
            if invocation_context.subject_id not in evidence.acl_subjects:
                raise PolicyViolation("capability_result_evidence_acl_denied")
            if invocation_context.data_class == CapabilityDataClass.CURRENT_INCIDENT:
                if evidence.proof_scope.value != "CURRENT_OBSERVATION":
                    raise PolicyViolation("capability_result_evidence_data_class_mismatch")
            elif invocation_context.data_class == CapabilityDataClass.KNOWLEDGE_REFERENCE:
                if evidence.proof_scope.value != "REFERENCE_ONLY" or evidence.source_kind.value != "KNOWLEDGE":
                    raise PolicyViolation("capability_result_evidence_data_class_mismatch")
            elif invocation_context.data_class == CapabilityDataClass.RECORDED_CONTEXT:
                if evidence.evidence_id not in invocation_context.recorded_evidence_ids:
                    raise PolicyViolation("capability_result_evidence_not_recorded_context")
        for claim in result.claims:
            if (
                claim.tenant_id != invocation_context.tenant_id
                or claim.case_id != invocation_context.case_id
                or claim.case_revision != invocation_context.case_revision
            ):
                raise PolicyViolation("capability_result_claim_scope_mismatch")
        for coverage in result.coverage:
            if (coverage.tenant_id, coverage.case_id) != (invocation_context.tenant_id, invocation_context.case_id):
                raise PolicyViolation("capability_result_coverage_scope_mismatch")

    async def invoke(
        self,
        audience: CapabilityAudience,
        invocation_context: CapabilityInvocationContext,
        request: CapabilityRequest,
        budget: ToolCallBudget,
        *,
        evidence_admission: Optional[CapabilityEvidenceAdmission] = None,
        defer_durable_persistence: bool = False,
    ) -> CapabilityInvocationResult:
        descriptor = next(
            (item for item in self.available(audience) if item.capability == request.capability), None,
        )
        if descriptor is None:
            raise PolicyViolation("capability_unavailable")
        self._validate_scope_identity(invocation_context)
        if self.scope_authority is None:
            raise PolicyViolation("capability_scope_authority_unconfigured")
        await _maybe_await(self.scope_authority.assert_scope(invocation_context))
        if request.component_id not in invocation_context.component_ids:
            raise PolicyViolation("capability_component_not_canonical")
        if budget.max_calls > invocation_context.max_tool_calls:
            raise PolicyViolation("capability_tool_budget_exceeds_authoritative_scope")
        if request.data_class != invocation_context.data_class or request.data_class not in descriptor.data_classes:
            raise PolicyViolation("capability_data_class_not_allowed")
        if descriptor.required_gate == CapabilityGate.GATE1:
            # A Boolean in a packet is never a capability. The authoritative
            # lease validates the exact tenant/public/internal/revision/tool
            # binding immediately before the adapter can receive its input.
            if self.gate1_authority is None:
                raise PolicyViolation("capability_gate1_authority_unconfigured")
            await _maybe_await(self.gate1_authority.assert_active(invocation_context, request, descriptor))
        if descriptor.required_gate == CapabilityGate.SYSTEM_DIAGNOSIS and not (
            invocation_context.scope == CapabilityScope.AUTONOMOUS_DIAGNOSIS and invocation_context.system_authorized
        ):
            raise PolicyViolation("capability_system_diagnosis_authorization_required")
        adapter = self._adapters[request.capability]
        try:
            parsed_input = adapter.input_model.parse_obj(request.parameters)
        except Exception as error:
            raise PolicyViolation("capability_input_schema_invalid") from error
        input_evidence_refs = list(getattr(parsed_input, "evidence_ids", []))
        if not set(input_evidence_refs).issubset(invocation_context.recorded_evidence_ids):
            raise PolicyViolation("capability_input_evidence_not_authorized")
        budget.consume()
        raw_result = adapter.invoke(parsed_input, invocation_context)
        raw_result = await _maybe_await(raw_result)
        try:
            result = adapter.result_model.parse_obj(raw_result)
        except Exception as error:
            raise PolicyViolation("capability_result_schema_invalid") from error
        if descriptor.fresh_read and not result.evidence:
            raise PolicyViolation("fresh_capability_evidence_required")
        self._validate_result_evidence(result, invocation_context)
        if result.evidence and not defer_durable_persistence:
            if evidence_admission is None:
                raise PolicyViolation("capability_evidence_admission_port_required")
            admitted = await _maybe_await(evidence_admission.admit(result, invocation_context))
            try:
                result = adapter.result_model.parse_obj(admitted)
            except Exception as error:
                raise PolicyViolation("capability_evidence_admission_invalid_result") from error
            self._validate_result_evidence(result, invocation_context)
        request_hash = sha256(request.json(sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        evidence_refs = list(input_evidence_refs)
        for evidence in result.evidence:
            if evidence.evidence_id not in evidence_refs:
                evidence_refs.append(evidence.evidence_id)
        audit = CapabilityAuditRecord(
            **{
                field: getattr(invocation_context, field)
                for field in IncidentRunBinding.__fields__ if field != "created_at"
            },
            audit_id=uuid5(
                NAMESPACE_URL,
                "capability:{}:{}:{}:{}:{}:{}:{}".format(
                    invocation_context.tenant_id, invocation_context.run_id, invocation_context.activity_id,
                    invocation_context.scope.value, audience.value, request.capability.value, request_hash,
                ),
            ),
            projection_revision=invocation_context.projection_revision,
            evidence_revision=invocation_context.evidence_revision,
            activity_id=invocation_context.activity_id,
            scope=invocation_context.scope,
            subject_id=invocation_context.subject_id,
            audience=audience,
            capability=request.capability,
            component_id=request.component_id,
            capability_version=descriptor.version,
            data_class=invocation_context.data_class,
            required_gate=descriptor.required_gate,
            policy_version=self.policy_version,
            request_hash=request_hash,
            input_evidence_refs=input_evidence_refs,
            evidence_refs=evidence_refs,
            # Temporal-owned packet time makes an exact retry byte-identical.
            created_at=invocation_context.created_at,
        )
        existing = self.audit_records.get(audit.audit_id)
        if existing is not None and existing != audit:
            raise PolicyViolation("capability_audit_immutable")
        self.audit_records[audit.audit_id] = audit
        # Gate 1 fresh reads carry the returned domain records and audit into
        # the action transition outbox.  That transaction is the only place
        # where a successful fresh read becomes durable.  All other callers
        # retain the normal immediate admission/audit behaviour.
        if self.audit_sink is not None and not defer_durable_persistence:
            persisted = self.audit_sink.append_capability_audit(audit)
            persisted = await _maybe_await(persisted)
            if persisted != audit:
                raise PolicyViolation("capability_audit_persistence_mismatch")
        return CapabilityInvocationResult(result=result, audit=audit)

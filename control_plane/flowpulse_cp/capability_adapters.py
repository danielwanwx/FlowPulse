"""Concrete bounded capability adapters used by the production worker."""

from datetime import datetime, timezone

from .capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityInvocationContext,
    CapabilityName,
    CapabilityResult,
    CurrentEvidenceCapabilityResult,
    EmptyCapabilityInput,
    RecordedContextInput,
)
from .evidence_acquisition import CurrentEvidenceAcquisitionPort
from .integrity import EvidenceGateway
from .models import IncidentCase
from .policy import PolicyViolation
from .repository import InMemoryCaseRepository


class CurrentEvidenceCapabilityAdapter:
    """Adapts the controlled source-reader into the shared capability seam."""

    descriptor = CapabilityDescriptor(
        capability=CapabilityName.CURRENT_EVIDENCE,
        version="current-evidence-capability.v1",
        fresh_read=True,
        enabled=True,
        audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS],
        data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.SYSTEM_DIAGNOSIS,
        input_schema="current-evidence-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CurrentEvidenceCapabilityResult

    def __init__(self, acquirer: CurrentEvidenceAcquisitionPort) -> None:
        self.acquirer = acquirer

    async def invoke(self, parsed_input, invocation_context: CapabilityInvocationContext) -> CapabilityResult:
        acquired = self.acquirer.acquire(
            IncidentCase(
                case_id=invocation_context.case_id,
                tenant_id=invocation_context.tenant_id,
                case_revision=invocation_context.case_revision,
                workflow_id=invocation_context.workflow_id,
                workflow_run_id=invocation_context.workflow_run_id,
                public_incident_id=invocation_context.incident_id,
                public_run_id=invocation_context.run_id,
                public_topology_revision=invocation_context.topology_revision,
                severity="CAPABILITY",
                environment="capability",
                affected_entities=invocation_context.component_ids,
                created_at=invocation_context.created_at,
                updated_at=datetime.now(timezone.utc),
            ),
            invocation_context.subject_id,
        )
        return CurrentEvidenceCapabilityResult(
            summary="Controlled current incident evidence acquired.",
            evidence=acquired.evidence,
            claims=acquired.claims,
            coverage=acquired.coverage,
        )


class RecordedContextCapabilityAdapter:
    """Audits use of an already-projected context without reading a new source."""

    descriptor = CapabilityDescriptor(
        capability=CapabilityName.RECORDED_CONTEXT,
        version="recorded-context-capability.v1",
        fresh_read=False,
        enabled=True,
        audiences=[CapabilityAudience.USER_QA],
        data_classes=[CapabilityDataClass.RECORDED_CONTEXT],
        required_gate=CapabilityGate.NONE,
        input_schema="recorded-context-input.v1",
    )
    input_model = RecordedContextInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context: CapabilityInvocationContext) -> CapabilityResult:
        return CapabilityResult(summary="Recorded incident context authorized for explanation.")


async def _maybe_await(value):
    if hasattr(value, "__await__"):
        return await value
    return value


class DomainEvidenceAdmission:
    """Routes adapter evidence through the existing gateway before an audit succeeds."""

    def __init__(self, repository, subject_id: str) -> None:
        self.repository = repository
        self.subject_id = subject_id

    async def admit(self, result: CapabilityResult, invocation_context: CapabilityInvocationContext) -> CapabilityResult:
        if isinstance(self.repository, InMemoryCaseRepository):
            gateway = EvidenceGateway(self.repository, self.subject_id)
            for evidence in result.evidence:
                gateway.admit(evidence)
            for claim in result.claims:
                gateway.admit_claim(claim)
            for coverage in result.coverage:
                if (coverage.tenant_id, coverage.case_id) != (
                    invocation_context.tenant_id, invocation_context.case_id,
                ):
                    raise PolicyViolation("capability_result_coverage_scope_mismatch")
                self.repository.put_coverage(coverage)
            return result
        # The production repository performs the same evidence/claim gateway
        # checks under tenant RLS. Complete domain admission happens before the
        # registry can append a COMPLETED capability audit.
        for evidence in result.evidence:
            await _maybe_await(self.repository.put_evidence(evidence, self.subject_id))
        for claim in result.claims:
            await _maybe_await(self.repository.put_claim(claim, self.subject_id))
        for coverage in result.coverage:
            if (coverage.tenant_id, coverage.case_id) != (
                invocation_context.tenant_id, invocation_context.case_id,
            ):
                raise PolicyViolation("capability_result_coverage_scope_mismatch")
            await _maybe_await(self.repository.put_coverage(coverage))
        return result

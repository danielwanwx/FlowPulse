"""The sole durable workflow definition for FlowPulse P0."""

from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow

from .models import ActivityOutcome, CaseState, TemporalActivityPacket, TemporalCaseRequest, VerificationDecision


def temporal_available() -> bool:
    return True


@workflow.defn(name="flowpulse.diagnosis.v1")
class DiagnosisTemporalWorkflow:
    """Deterministic orchestration only; all I/O runs as Temporal activities."""

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request = TemporalCaseRequest.parse_obj(request_data)
        base = {
            "case_id": request.case.case_id,
            "case_revision": request.case.case_revision,
            "tenant_id": request.case.tenant_id,
            "workflow_id": request.case.workflow_id,
            # The workflow itself is the only place that knows its real run
            # id before the first activity; never persist the starter's
            # workflow-id placeholder as a run id.
            "workflow_run_id": workflow.info().run_id,
            "actor_subject_id": request.actor.subject_id,
            "severity": request.case.severity,
            "environment": request.case.environment,
            "affected_entities": request.case.affected_entities,
            "evidence": request.evidence,
            "readback_evidence": request.readback_evidence,
            "claims": request.claims,
            "coverage": request.coverage,
            "proposal": request.proposal,
            "approval": request.approval,
            "current_witness": request.current_witness,
        }

        sequence = 0

        async def activity(stage: str, specialist_role: str = None) -> ActivityOutcome:
            nonlocal sequence
            sequence += 1
            packet = TemporalActivityPacket(
                stage=stage, specialist_role=specialist_role, sequence=sequence, **base
            )
            result = await workflow.execute_activity(
                "{}_activity".format(stage),
                packet.dict(),
                start_to_close_timeout=timedelta(minutes=2),
            )
            return ActivityOutcome.parse_obj(result)

        await activity("route_case")
        await activity("retrieve_knowledge")
        await activity("primary_investigator")
        for role in request.specialist_roles[:4]:
            await activity("specialist", role)
        critic = await activity("critic")
        if critic.decision != VerificationDecision.PASS:
            return {"state": CaseState.NEEDS_HUMAN.value, "critic": critic.dict()}
        verification = await activity("independent_verify")
        if verification.decision != VerificationDecision.PASS:
            return {"state": CaseState.ABSTAINED.value, "verification": verification.dict()}
        owner = await activity("owner_gate")
        return {
            "state": (owner.state or CaseState.BLOCKED).value,
            "verification": verification.dict(),
            "owner_gate": owner.dict(),
        }

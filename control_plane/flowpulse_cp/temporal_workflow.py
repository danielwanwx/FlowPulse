"""The sole durable workflow definition for FlowPulse P0."""

from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow

from .models import TemporalActivityPacket, TemporalCaseRequest


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
            "workflow_run_id": request.case.workflow_run_id,
            "actor_subject_id": request.actor.subject_id,
            "severity": request.case.severity,
            "environment": request.case.environment,
            "affected_entities": request.case.affected_entities,
        }

        async def activity(stage: str, specialist_role: str = None) -> Dict[str, Any]:
            packet = TemporalActivityPacket(stage=stage, specialist_role=specialist_role, **base)
            return await workflow.execute_activity(
                "{}_activity".format(stage),
                packet.dict(),
                start_to_close_timeout=timedelta(minutes=2),
            )

        await activity("route_case")
        await activity("retrieve_knowledge")
        await activity("primary_investigator")
        for role in request.specialist_roles[:4]:
            await activity("specialist", role)
        critic = await activity("critic")
        if critic["decision"] != "PASS":
            return {"state": "NEEDS_HUMAN", "critic": critic}
        verification = await activity("independent_verify")
        if verification["decision"] != "PASS":
            return {"state": "ABSTAINED", "verification": verification}
        owner = await activity("owner_gate")
        return {"state": owner["state"], "verification": verification, "owner_gate": owner}

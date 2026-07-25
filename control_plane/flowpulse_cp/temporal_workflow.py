"""Production Temporal workflow definition.

This import is isolated so deterministic tests do not require Temporal to be
installed. Temporal remains the only production progression authority; every
nondeterministic provider and database write is an activity.
"""

from datetime import timedelta
from typing import Any, Dict


def temporal_available() -> bool:
    try:
        import temporalio  # noqa: F401
    except ImportError:
        return False
    return True


def build_workflow_definition() -> Any:
    """Build lazily to keep a missing local Temporal SDK an explicit blocker."""
    from temporalio import workflow

    @workflow.defn(name="flowpulse.diagnosis.v1")
    class DiagnosisTemporalWorkflow:
        @workflow.run
        async def run(self, request: Dict[str, Any]) -> Dict[str, Any]:
            # Workflow code is deterministic orchestration only. Activities
            # return immutable record references and never own next-state logic.
            route = await workflow.execute_activity(
                "route_case_activity", request, start_to_close_timeout=timedelta(seconds=30)
            )
            knowledge = await workflow.execute_activity(
                "retrieve_knowledge_activity", route, start_to_close_timeout=timedelta(seconds=30)
            )
            investigation = await workflow.execute_activity(
                "primary_investigator_activity", knowledge, start_to_close_timeout=timedelta(minutes=2)
            )
            critic = await workflow.execute_activity(
                "critic_activity", investigation, start_to_close_timeout=timedelta(seconds=30)
            )
            if critic["decision"] != "PASS":
                return {"state": "NEEDS_HUMAN", "critic": critic}
            verification = await workflow.execute_activity(
                "independent_verify_activity", investigation, start_to_close_timeout=timedelta(minutes=2)
            )
            if verification["decision"] != "PASS":
                return {"state": "ABSTAINED", "verification": verification}
            return {"state": "AWAITING_OWNER", "verification": verification}

    return DiagnosisTemporalWorkflow

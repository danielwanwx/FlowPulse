"""Generate the Incident Workspace OpenAPI/schema bundle from real API models.

The generator deliberately contains no hand-authored success payload.  It
obtains the route document from FastAPI and the safe examples from the exact
Pydantic contracts returned by those routes.
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Run against the checkout's FastAPI/Pydantic contracts even when a developer
# has an older non-editable package installed in the selected interpreter.
SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from flowpulse_cp.app import create_app
from flowpulse_cp.workspace_models import (
    ComponentContext,
    GraphMembership,
    IncidentEvent,
    IncidentNotification,
    IncidentNotificationType,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentSummary,
    IncidentRunBinding,
    NodeExplanation,
    NodeExplanationReceipt,
    NodeExplanationState,
    ConversationTrace,
    NodeExplanationStart,
    ProjectionState,
    WorkspaceIntake,
)
from flowpulse_cp.workspace_actions import (
    ActionInvocationCommand,
    NextBestAction,
    NextBestActionCta,
    NextBestActionTaxonomy,
    WorkspaceActionReceipt,
)


def _write_json(path: Path, value) -> str:
    encoded = (json.dumps(value, indent=2, sort_keys=True, default=str) + "\n").encode("utf-8")
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


def _examples():
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    binding = IncidentRunBinding(
        tenant_id="tenant-example", incident_id="incident-example", run_id="run-example-01",
        topology_revision="topology-v1-example", case_id="workspace-case-example", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-example:run-example-01",
        workflow_run_id="temporal-run-example", created_at=now,
    )
    projection = IncidentProjection(
        **binding.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=now,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            display_name="Checkout",
            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
        )]), operator_title="Checkout latency", operator_summary="Checkout requests are degraded.",
        evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )
    command = NodeExplanationStart(
        incident_id=binding.incident_id, run_id=binding.run_id,
        topology_revision=binding.topology_revision, projection_revision=1,
        component_id="checkout", idempotency_key="example-click-01",
    )
    explanation = NodeExplanation(
        **binding.dict(), explanation_id="node-explanation-example",
        selection_key=command.selection_key(binding.tenant_id), projection_revision=1,
        component_id="checkout", conversation_schema_version=command.conversation_schema_version,
        state=NodeExplanationState.DEGRADED,
        summary="No provider or read capability is configured; no fresh read or diagnosis was performed.",
        evidence_refs=[], fresh_read_performed=False, fresh_diagnosis_claimed=False,
        degraded_code="provider_unavailable",
    )
    event = IncidentEvent(
        **binding.dict(), projection_revision=1, sequence=1, event_type="workspace.initialized",
        occurred_at=now, payload={"state": "provider_unavailable"}, evidence_refs=[],
    )
    incident_summary = IncidentSummary.from_projection(projection)
    notification = IncidentNotification(
        notification_id="2026-07-26T00:00:00+00:00|run-example-01|0000000001",
        event_type=IncidentNotificationType.ACCEPTED, occurred_at=now, incident=incident_summary,
    )
    context = ComponentContext(
        **binding.dict(), projection_revision=projection.projection_revision,
        component=projection.graph.nodes[0], evidence_refs=projection.evidence_refs,
        fresh_read_performed=False,
    )
    action = NextBestAction(
        **binding.dict(), action_id="action-example-gate1", card_version=1,
        taxonomy=NextBestActionTaxonomy.FIND_CAUSE, title="Find Cause",
        cta=NextBestActionCta.REQUEST_GATE1,
        summary="Request a bounded fresh read for the current incident.",
        display_order=1, recommended=True, projection_revision=1,
        evidence_revision=1, gate_revision=1, action_revision=1,
        component_id="checkout", capability="METRICS", data_class="CURRENT_INCIDENT",
        required_permission="incident:read", required_gate="GATE1",
        tool_schema_version="metrics-input.v1", capability_registry_revision="capability-policy.v2",
        precondition_version="workspace-precondition.v1", precondition_hash="a" * 64,
        evidence_refs=[], expires_at=now,
    )
    action_command = ActionInvocationCommand(
        incident_id=binding.incident_id, run_id=binding.run_id,
        topology_revision=binding.topology_revision, projection_revision=1,
        action_id=action.action_id, idempotency_key="example-action-01",
    )
    action_receipt = WorkspaceActionReceipt(
        **binding.dict(), action_id=action.action_id, idempotency_key=action_command.idempotency_key,
        status="GATE1_GRANTED", gate1_lease_id="gate1-example", reason="temporal_gate1_lease_accepted",
    )
    return {
        "schema_version": "flowpulse.incident-workspace.examples.v1",
        "identity_note": (
            "run_id and topology_revision are backend-owned public identities; case_id, workflow_id, "
            "and workflow_run_id are internal correlations. run_id is never derived from a Temporal ID."
        ),
        "provider_note": (
            "Standard and demo provider modes return typed degraded state when no provider is configured. "
            "Deterministic output is test-only dependency injection and is labeled TEST_DETERMINISTIC; "
            "explicit configured providers are labeled LIVE."
        ),
        "request_examples": {
            "WorkspaceIntake": WorkspaceIntake(
                incident_id="incident-example", title="Checkout latency", severity="SEV2", environment="local",
                affected_entities=["checkout"], observed_at=now, summary="Safe schema example.",
            ).dict(),
            "NodeExplanationStart": command.dict(),
            "ActionInvocationCommand": action_command.dict(),
        },
        "response_examples": {
            "IncidentProjection": projection.dict(),
            "IncidentSummary": incident_summary.dict(),
            "IncidentNotification": notification.dict(),
            "NodeExplanationReceipt": NodeExplanationReceipt(explanation=explanation, reused=False).dict(),
            "IncidentEvent": event.dict(),
            "ComponentContext": context.dict(),
            "NextBestAction": action.dict(),
            "WorkspaceActionReceipt": action_receipt.dict(),
        },
        "model_schemas": {
            "WorkspaceIntake": WorkspaceIntake.schema(),
            "IncidentProjection": IncidentProjection.schema(),
            "IncidentSummary": IncidentSummary.schema(),
            "IncidentNotification": IncidentNotification.schema(),
            "NodeExplanationStart": NodeExplanationStart.schema(),
            "NodeExplanationReceipt": NodeExplanationReceipt.schema(),
            "ConversationTrace": ConversationTrace.schema(),
            "IncidentEvent": IncidentEvent.schema(),
            "ComponentContext": ComponentContext.schema(),
            "ActionInvocationCommand": ActionInvocationCommand.schema(),
            "NextBestAction": NextBestAction.schema(),
            "WorkspaceActionReceipt": WorkspaceActionReceipt.schema(),
        },
    }


def generate(output: Path, producer_git_sha: str) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    openapi_path = output / "flowpulse-incident-workspace-v1.openapi.json"
    examples_path = output / "flowpulse-incident-workspace-v1.examples.json"
    manifest_path = output / "flowpulse-incident-workspace-v1.freeze.json"
    openapi = create_app().openapi()
    openapi["info"]["title"] = "FlowPulse Incident Workspace Contract"
    openapi["info"]["version"] = "v1"
    openapi["x-flowpulse-workspace-contract"] = {
        "schema_version": "flowpulse.incident-workspace.v1",
        "public_identity": ["tenant_id", "incident_id", "run_id", "topology_revision"],
        "internal_correlation": ["case_id", "case_revision", "workflow_id", "workflow_run_id"],
        "provider_mode": "typed_degraded_when_unconfigured",
        "provider_truth_labels": ["DEGRADED", "TEST_DETERMINISTIC", "DEMO", "LIVE"],
    }
    checksums = {
        openapi_path.name: _write_json(openapi_path, openapi),
        examples_path.name: _write_json(examples_path, _examples()),
    }
    manifest = {
        "schema_version": "flowpulse.incident-workspace.freeze.v1",
        "producer_implementation_git_sha": producer_git_sha,
        "hash_algorithm": "sha256",
        "artifacts": checksums,
        "generated_at": "deterministic-from-source",
    }
    checksums[manifest_path.name] = _write_json(manifest_path, manifest)
    return checksums


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--producer-git-sha", required=True)
    args = parser.parse_args()
    print(json.dumps(generate(args.output, args.producer_git_sha), sort_keys=True))


if __name__ == "__main__":
    main()

"""Public identity and strict-contract seams for the Incident Workspace."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    ProjectionState,
)


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def binding():
    return IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:incident-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )


def projection():
    item = binding()
    return IncidentProjection(
        schema_version="flowpulse.incident-projection.v1", **item.dict(),
        projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=NOW,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout",
            membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
        )], edges=[]),
        impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )


class IncidentWorkspaceContractTests(unittest.TestCase):
    def test_public_run_and_topology_identity_never_derive_from_temporal_ids(self):
        item = binding()
        self.assertEqual("run-public-a", item.run_id)
        self.assertNotEqual(item.run_id, item.workflow_id)
        self.assertNotEqual(item.run_id, item.workflow_run_id)
        raw = item.dict()
        raw["run_id"] = raw["workflow_run_id"]
        with self.assertRaisesRegex(ValidationError, "run_id_must_not_equal_temporal_identity"):
            IncidentRunBinding.parse_obj(raw)

    def test_projection_rejects_unknown_fields_and_unclassified_graph_nodes(self):
        raw = projection().dict()
        raw["unexpected"] = "browser-authority"
        with self.assertRaises(ValidationError):
            IncidentProjection.parse_obj(raw)
        with self.assertRaisesRegex(ValidationError, "classified_node_requires_reason"):
            IncidentGraphNode(
                component_id="unknown", canonical_identity="service:unknown",
                membership=GraphMembership.CLASSIFIED, runtime_status="unknown", impact_status="unknown",
            )

    def test_node_explanation_command_uses_public_run_selection_key(self):
        command = NodeExplanationStart(
            incident_id="incident-a", run_id="run-public-a", topology_revision="topology-v1-a",
            projection_revision=1, component_id="checkout", idempotency_key="node-click-a",
        )
        self.assertEqual(
            "node_explanation:tenant-a:run-public-a:1:checkout:flowpulse.node-explanation.v1",
            command.selection_key("tenant-a"),
        )
        raw = command.dict()
        raw["untrusted_tool"] = "read_logs"
        with self.assertRaises(ValidationError):
            NodeExplanationStart.parse_obj(raw)


if __name__ == "__main__":
    unittest.main()

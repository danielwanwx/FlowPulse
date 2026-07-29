"""Public identity and strict-contract seams for the Incident Workspace."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.workspace_models import (
    AffectedUserPathStatus,
    ClassifiedNodeReason,
    GraphMembership,
    IncidentGraph,
    IncidentGraphEdge,
    IncidentGraphNode,
    IncidentFocus,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    ProjectionState,
    VersionBundle,
)
from flowpulse_cp.workspace_registration import (
    WORKSPACE_V1_WORKFLOW_TYPE,
    WORKSPACE_V2_WORKFLOW_TYPE,
    workspace_workflow_definitions,
)
from flowpulse_cp.legacy_workspace_workflow import LegacyIncidentWorkspaceTemporalWorkflow
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow


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
            membership=GraphMembership.CLASSIFIED,
            classification_reason=ClassifiedNodeReason.RELATIONSHIP_UNAVAILABLE,
            runtime_status="unknown", impact_status="unknown",
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

    def test_graph_requires_members_and_edges_and_rejects_false_connected_nodes(self):
        required = set(IncidentGraph.schema()["required"])
        self.assertEqual({"nodes", "edges"}, required)
        with self.assertRaises(ValidationError):
            IncidentGraph.parse_obj({"nodes": []})
        with self.assertRaisesRegex(ValidationError, "connected_node_requires_edge"):
            IncidentGraph(nodes=[IncidentGraphNode(
                component_id="checkout", canonical_identity="service:checkout", display_name="Checkout",
                membership=GraphMembership.CONNECTED, runtime_status="degraded", impact_status="impacted",
            )], edges=[])
        with self.assertRaisesRegex(ValidationError, "graph_edge_references_unknown_component"):
            IncidentGraph(nodes=[IncidentGraphNode(
                component_id="checkout", canonical_identity="service:checkout", display_name="Checkout",
                membership=GraphMembership.CLASSIFIED,
                classification_reason=ClassifiedNodeReason.RELATIONSHIP_UNAVAILABLE,
                runtime_status="degraded", impact_status="impacted",
            )], edges=[IncidentGraphEdge(
                edge_id="checkout-unknown", source_component_id="checkout",
                target_component_id="unknown", status="unknown",
            )])
        with self.assertRaises(ValidationError):
            IncidentGraphNode(
                component_id="checkout", canonical_identity="service:checkout", display_name="Checkout",
                membership=GraphMembership.CLASSIFIED, classification_reason="browser_invented_reason",
                runtime_status="degraded", impact_status="impacted",
            )
        graph = IncidentGraph(nodes=[
            IncidentGraphNode(
                component_id="checkout", canonical_identity="service:checkout", display_name="Checkout",
                membership=GraphMembership.CONNECTED, runtime_status="degraded", impact_status="impacted",
            ),
            IncidentGraphNode(
                component_id="payments", canonical_identity="service:payments", display_name="Payments",
                membership=GraphMembership.CONNECTED, runtime_status="degraded", impact_status="impacted",
            ),
        ], edges=[IncidentGraphEdge(
            edge_id="checkout-payments", source_component_id="checkout", target_component_id="payments",
            status="degraded",
        )])
        self.assertEqual(2, len(graph.nodes))

        focused = projection().dict()
        focused["graph"] = graph.dict()
        focused["impacted_path"] = ["checkout", "payments"]
        focused["incident_focus"] = IncidentFocus(
            component_id="checkout", canonical_identity="service:checkout",
            rationale="Checkout is the first shared service on the audited affected user path.",
            affected_user_path_status=AffectedUserPathStatus.KNOWN,
            affected_user_path_summary="Checkout and payments are affected.",
            incident_relation_edge_ids=["checkout-payments"],
            incident_relation_provenance_refs=[
                "topology-fixture:test#relation/checkout-payments",
            ],
        ).dict()
        self.assertEqual(
            "checkout",
            IncidentProjection.parse_obj(focused).incident_focus.component_id,
        )
        focused["incident_focus"]["incident_relation_edge_ids"] = ["missing-edge"]
        with self.assertRaisesRegex(ValidationError, "incident_focus_edge_not_impacted"):
            IncidentProjection.parse_obj(focused)

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

    def test_new_workspaces_use_v2_and_worker_registers_only_v1_drain_plus_v2(self):
        self.assertEqual(WORKSPACE_V2_WORKFLOW_TYPE, VersionBundle().workflow_version)
        self.assertEqual(
            WORKSPACE_V2_WORKFLOW_TYPE,
            getattr(IncidentWorkspaceTemporalWorkflow, "__temporal_workflow_definition").name,
        )
        self.assertEqual(
            WORKSPACE_V1_WORKFLOW_TYPE,
            getattr(LegacyIncidentWorkspaceTemporalWorkflow, "__temporal_workflow_definition").name,
        )
        self.assertEqual(
            [LegacyIncidentWorkspaceTemporalWorkflow, IncidentWorkspaceTemporalWorkflow],
            workspace_workflow_definitions(),
        )


if __name__ == "__main__":
    unittest.main()

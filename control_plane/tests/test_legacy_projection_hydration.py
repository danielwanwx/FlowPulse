"""Public read seams for narrowly compatible legacy workspace projections."""

import copy
import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.models import AuthContext
from flowpulse_cp.postgres import PostgresCaseRepository


LEGACY_PROJECTION = {
    "schema_version": "flowpulse.incident-projection.v1",
    "tenant_id": "tenant-minio",
    "incident_id": "workspace-gate1-compose-legacy",
    "run_id": "run-legacy-public",
    "topology_revision": "topology-v1-legacy",
    "case_id": "workspace-case-legacy",
    "case_revision": 1,
    "workflow_id": "flowpulse.incident-workspace:tenant-minio:run-legacy-public",
    "workflow_run_id": "4cacdc9e-dd1f-456e-a40c-47916c561e86",
    "created_at": "2026-07-26T14:54:47.263849+00:00",
    "projection_revision": 1,
    "sequence": 1,
    "lifecycle_state": "DEGRADED",
    "status": "provider_unavailable",
    "generated_at": "2026-07-26T14:54:47.263849+00:00",
    "graph": {
        "nodes": [{
            "component_id": "checkout",
            "canonical_identity": "service:checkout",
            "membership": "CONNECTED",
            "classification_reason": None,
            "runtime_status": "unknown",
            "impact_status": "unknown",
        }],
        "edges": [],
    },
    "impacted_path": [],
    "evidence_revision": 1,
    "gate_revision": 1,
    "action_revision": 1,
    "evidence_refs": [],
    "degraded_code": "provider_unavailable",
}

LEGACY_EVENT = {
    "tenant_id": LEGACY_PROJECTION["tenant_id"],
    "incident_id": LEGACY_PROJECTION["incident_id"],
    "run_id": LEGACY_PROJECTION["run_id"],
    "topology_revision": LEGACY_PROJECTION["topology_revision"],
    "case_id": LEGACY_PROJECTION["case_id"],
    "case_revision": LEGACY_PROJECTION["case_revision"],
    "workflow_id": LEGACY_PROJECTION["workflow_id"],
    "workflow_run_id": LEGACY_PROJECTION["workflow_run_id"],
    "created_at": LEGACY_PROJECTION["created_at"],
    "projection_revision": 1,
    "sequence": 1,
    "event_type": "workspace.initialized",
    "occurred_at": LEGACY_PROJECTION["generated_at"],
    "payload": {"state": "provider_unavailable"},
}


def current_projection():
    projection = copy.deepcopy(LEGACY_PROJECTION)
    projection.update({
        "operator_title": "Checkout unavailable",
        "operator_summary": "Checkout requests require investigation.",
        "lifecycle_stage": "INVESTIGATE",
        "gate1_state": "NONE",
        "investigation_result": None,
    })
    projection["graph"]["nodes"][0]["display_name"] = "Checkout"
    return projection


class FrozenProjectionConnection:
    def __init__(self, projection):
        self.projection = copy.deepcopy(projection)

    async def fetch(self, query, *args):
        if "SELECT payload FROM (" in query:
            return [{"payload": copy.deepcopy(self.projection)}]
        if "SELECT e.payload AS event_payload" in query:
            return [{
                "event_payload": copy.deepcopy(LEGACY_EVENT),
                "projection_payload": copy.deepcopy(self.projection),
            }]
        raise AssertionError("unexpected_fetch")

    async def fetchrow(self, query, *args):
        if "SELECT payload FROM incident_projections" in query:
            return {"payload": copy.deepcopy(self.projection)}
        raise AssertionError("unexpected_fetchrow")


class FrozenProjectionRepository(PostgresCaseRepository):
    def __init__(self, projection):
        super().__init__("unused")
        self.connection = FrozenProjectionConnection(projection)

    async def _tenant(self, tenant_id, operation, subject_id=None):
        if tenant_id != self.connection.projection["tenant_id"]:
            return await operation(FrozenProjectionConnection({}))
        return await operation(self.connection)


class LegacyProjectionHydrationTests(unittest.TestCase):
    def setUp(self):
        repository = FrozenProjectionRepository(LEGACY_PROJECTION)
        app = create_app(workspace_repository=repository)
        app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-minio", subject_id="owner-minio", roles=["owner"],
        )
        self.client = TestClient(app, raise_server_exceptions=False)

    def test_active_incident_hydrates_frozen_legacy_projection(self):
        response = self.client.get("/v1/incidents?state=active&limit=20")
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("workspace-case-legacy", response.json()[0]["case_id"])

        projection = self.client.get("/v1/incidents/workspace-case-legacy/projection")
        self.assertEqual(200, projection.status_code, projection.text)
        node = projection.json()["graph"]["nodes"][0]
        self.assertEqual("CLASSIFIED", node["membership"])
        self.assertEqual("Relationship unavailable", node["classification_reason"])

    def test_global_sse_hydrates_frozen_legacy_projection(self):
        response = self.client.get("/v1/incidents/events")
        self.assertEqual(200, response.status_code, response.text)
        self.assertIn("event: incident-notification", response.text)
        self.assertIn('"case_id": "workspace-case-legacy"', response.text)

    def test_current_format_connected_node_without_edge_remains_rejected(self):
        repository = FrozenProjectionRepository(current_projection())
        self.client.app.state.workspace_repository = repository

        response = self.client.get("/v1/incidents?state=active&limit=20")
        self.assertEqual(500, response.status_code, response.text)

    def test_valid_current_connected_graph_is_unchanged(self):
        projection = current_projection()
        projection["graph"] = {
            "nodes": [
                {
                    "component_id": "checkout",
                    "canonical_identity": "service:checkout",
                    "display_name": "Checkout",
                    "membership": "CONNECTED",
                    "classification_reason": None,
                    "runtime_status": "degraded",
                    "impact_status": "impacted",
                },
                {
                    "component_id": "payments",
                    "canonical_identity": "service:payments",
                    "display_name": "Payments",
                    "membership": "CONNECTED",
                    "classification_reason": None,
                    "runtime_status": "degraded",
                    "impact_status": "impacted",
                },
            ],
            "edges": [{
                "edge_id": "checkout-payments",
                "source_component_id": "checkout",
                "target_component_id": "payments",
                "status": "degraded",
            }],
        }
        repository = FrozenProjectionRepository(projection)
        self.client.app.state.workspace_repository = repository

        response = self.client.get("/v1/incidents/workspace-case-legacy/projection")
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual(projection["graph"], response.json()["graph"])


if __name__ == "__main__":
    unittest.main()

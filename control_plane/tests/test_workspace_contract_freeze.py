"""Integrity guard for the checked-in frontend Contract Core artifact bundle."""

import hashlib
import json
import sys
import unittest
from pathlib import Path


CONTROL_PLANE = Path(__file__).resolve().parents[1]
REPO = CONTROL_PLANE.parent
ARTIFACT_DIR = CONTROL_PLANE / "openapi"
PRODUCER_SHA = "f92d6f6832f9562cbc8edfd574c19bc0a31acd6b"


class WorkspaceContractFreezeTests(unittest.TestCase):
    def test_checked_in_bundle_matches_manifest_and_public_identity_boundary(self):
        manifest = json.loads((ARTIFACT_DIR / "flowpulse-incident-workspace-v1.freeze.json").read_text())
        self.assertEqual(PRODUCER_SHA, manifest["producer_implementation_git_sha"])
        self.assertEqual("sha256", manifest["hash_algorithm"])
        for filename, checksum in manifest["artifacts"].items():
            self.assertEqual(checksum, hashlib.sha256((ARTIFACT_DIR / filename).read_bytes()).hexdigest())
        openapi = json.loads((ARTIFACT_DIR / "flowpulse-incident-workspace-v1.openapi.json").read_text())
        boundary = openapi["x-flowpulse-workspace-contract"]
        self.assertEqual(["tenant_id", "incident_id", "run_id", "topology_revision"], boundary["public_identity"])
        self.assertIn("workflow_run_id", boundary["internal_correlation"])
        self.assertIn("/v1/incidents/{case_id}/node-explanations", openapi["paths"])
        self.assertIn("/v1/incidents/events", openapi["paths"])
        self.assertIn("/v1/incidents/{case_id}/actions", openapi["paths"])
        self.assertIn("/v1/incidents/{case_id}/actions/{action_id}", openapi["paths"])
        self.assertEqual(
            ["DEGRADED", "TEST_DETERMINISTIC", "DEMO", "LIVE"],
            boundary["provider_truth_labels"],
        )
        self.assertEqual(
            [{"FlowPulseTrustedBearer": []}],
            openapi["paths"]["/v1/incidents"]["post"]["security"],
        )
        self.assertEqual(
            "flowpulse.incident-workspace.v2",
            openapi["components"]["schemas"]["VersionBundle"]["properties"]["workflow_version"]["default"],
        )
        self.assertEqual(
            "flowpulse.next-best-action.v1",
            openapi["components"]["schemas"]["VersionBundle"]["properties"]["card_schema_version"]["default"],
        )
        self.assertEqual(
            "v1.3-staff-incident",
            openapi["x-flowpulse-workspace-contract"]["contract_revision"],
        )
        self.assertIn("InvestigationResult", openapi["components"]["schemas"])
        self.assertIn("IncidentFocus", openapi["components"]["schemas"])
        self.assertIn("ConversationItem", openapi["components"]["schemas"])
        self.assertIn(
            "operator_status",
            openapi["components"]["schemas"]["InvestigationCritic"]["properties"],
        )
        event_response = openapi["paths"]["/v1/incidents/{case_id}/events"]["get"]["responses"]["200"]
        self.assertEqual({"text/event-stream"}, set(event_response["content"]))
        global_event_response = openapi["paths"]["/v1/incidents/events"]["get"]["responses"]["200"]
        self.assertEqual({"text/event-stream"}, set(global_event_response["content"]))
        self.assertEqual(
            "#/components/schemas/IncidentNotification",
            global_event_response["content"]["text/event-stream"]["schema"]["$ref"],
        )
        self.assertIn("IncidentNotification", openapi["components"]["schemas"])
        self.assertEqual(
            {"nodes", "edges"},
            set(openapi["components"]["schemas"]["IncidentGraph"]["required"]),
        )

    def test_plan_and_contract_record_exact_bundle_hashes_before_frontend_integration(self):
        plan = (REPO / "docs" / "plans" / "2026-07-25-agent-led-incident-control-plane-integration.md").read_text()
        contract = (REPO / "docs" / "architecture" / "incident-workspace-control-plane-contract.md").read_text()
        manifest = json.loads((ARTIFACT_DIR / "flowpulse-incident-workspace-v1.freeze.json").read_text())
        for document in [plan, contract]:
            self.assertIn(PRODUCER_SHA, document)
            for checksum in manifest["artifacts"].values():
                self.assertIn(checksum, document)


if __name__ == "__main__":
    unittest.main()

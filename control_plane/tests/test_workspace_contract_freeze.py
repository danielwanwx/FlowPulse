"""Integrity guard for the checked-in frontend Contract Core artifact bundle."""

import hashlib
import json
import sys
import unittest
from pathlib import Path


CONTROL_PLANE = Path(__file__).resolve().parents[1]
REPO = CONTROL_PLANE.parent
ARTIFACT_DIR = CONTROL_PLANE / "openapi"
PRODUCER_SHA = "8f149db47d37cb2815475162d6087fe92267d3db"


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
        self.assertNotIn("/v1/incidents/{case_id}/actions/{action_id}", openapi["paths"])
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
        event_response = openapi["paths"]["/v1/incidents/{case_id}/events"]["get"]["responses"]["200"]
        self.assertEqual({"text/event-stream"}, set(event_response["content"]))

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

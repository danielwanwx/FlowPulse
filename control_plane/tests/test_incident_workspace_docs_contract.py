"""The public workspace authority contract cannot silently drift in docs."""

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class IncidentWorkspaceDocsContractTests(unittest.TestCase):
    def test_north_star_and_authority_are_consistent(self):
        documents = [
            ROOT / "README.md",
            ROOT / "control_plane" / "README.md",
            ROOT / "docs" / "architecture.md",
            ROOT / "docs" / "architecture" / "incident-workspace-control-plane-contract.md",
        ]
        required = [
            "model-agnostic",
            "incident response",
            "Temporal",
            "run_id",
            "topology_revision",
            "workflow_run_id",
        ]
        for document in documents:
            content = document.read_text(encoding="utf-8")
            for phrase in required:
                self.assertIn(phrase, content, "{} missing {}".format(document, phrase))

    def test_contract_names_workspace_version_degraded_provider_and_same_origin_auth(self):
        content = (ROOT / "docs" / "architecture" / "incident-workspace-control-plane-contract.md").read_text(
            encoding="utf-8"
        )
        for phrase in [
            "flowpulse.incident-workspace.v1",
            "flowpulse.incident-workspace.v2",
            "replay/drain",
            "provider_unavailable",
            "/api/control-plane/v1",
            "FLOWPULSE_TEST_OWNER_TOKEN",
            "must never receive",
            "OpenAPI",
        ]:
            self.assertIn(phrase, content)


if __name__ == "__main__":
    unittest.main()

"""The checked-in frontend contract must come from real FastAPI/Pydantic models."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WorkspaceContractGeneratorTests(unittest.TestCase):
    def test_generator_emits_real_routes_safe_examples_and_reproducible_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            completed = subprocess.run(
                [
                    sys.executable, "tools/generate_workspace_contract.py", "--output", str(output),
                    "--producer-git-sha", "0" * 40,
                ],
                cwd=ROOT, check=True, text=True, capture_output=True,
            )
            reported = json.loads(completed.stdout)
            openapi = json.loads((output / "flowpulse-incident-workspace-v1.openapi.json").read_text())
            examples = json.loads((output / "flowpulse-incident-workspace-v1.examples.json").read_text())
            manifest = json.loads((output / "flowpulse-incident-workspace-v1.freeze.json").read_text())
            self.assertIn("/v1/incidents", openapi["paths"])
            self.assertIn("/v1/incidents/{case_id}/events", openapi["paths"])
            self.assertEqual("run-example-01", examples["response_examples"]["IncidentProjection"]["run_id"])
            self.assertEqual("provider_unavailable", examples["response_examples"]["IncidentProjection"]["degraded_code"])
            self.assertEqual("0" * 40, manifest["producer_implementation_git_sha"])
            for filename, checksum in manifest["artifacts"].items():
                self.assertEqual(checksum, reported[filename])
                self.assertEqual(checksum, hashlib.sha256((output / filename).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()

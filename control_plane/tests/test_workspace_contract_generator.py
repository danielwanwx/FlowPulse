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
    @staticmethod
    def _refs(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "$ref":
                    yield item
                else:
                    yield from WorkspaceContractGeneratorTests._refs(item)
        elif isinstance(value, list):
            for item in value:
                yield from WorkspaceContractGeneratorTests._refs(item)

    @staticmethod
    def _resolve(document, pointer):
        current = document
        for token in pointer.removeprefix("#/").split("/"):
            current = current[token.replace("~1", "/").replace("~0", "~")]
        return current

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
            self.assertIn("/v1/incidents/events", openapi["paths"])
            self.assertIn("/v1/incidents/{case_id}/events", openapi["paths"])
            self.assertIn("/v1/incidents/{case_id}/actions", openapi["paths"])
            self.assertIn("/v1/incidents/{case_id}/actions/{action_id}", openapi["paths"])
            self.assertEqual(
                [{"FlowPulseTrustedBearer": []}],
                openapi["paths"]["/v1/incidents"]["post"]["security"],
            )
            context = openapi["paths"]["/v1/incidents/{case_id}/components/{component_id}/context"]["get"]
            self.assertEqual("#/components/schemas/ComponentContext", context["responses"]["200"]["content"]["application/json"]["schema"]["$ref"])
            event_response = openapi["paths"]["/v1/incidents/{case_id}/events"]["get"]["responses"]["200"]
            self.assertEqual({"text/event-stream"}, set(event_response["content"]))
            self.assertEqual("#/components/schemas/IncidentEvent", event_response["content"]["text/event-stream"]["schema"]["$ref"])
            notification_response = openapi["paths"]["/v1/incidents/events"]["get"]["responses"]["200"]
            self.assertEqual({"text/event-stream"}, set(notification_response["content"]))
            self.assertEqual(
                "#/components/schemas/IncidentNotification",
                notification_response["content"]["text/event-stream"]["schema"]["$ref"],
            )
            for reference in self._refs(openapi):
                self.assertTrue(reference.startswith("#/"), reference)
                self.assertIsNotNone(self._resolve(openapi, reference), reference)
            self.assertFalse(openapi["components"]["schemas"]["ComponentContext"].get("additionalProperties", True))
            self.assertFalse(openapi["components"]["schemas"]["IncidentEvent"].get("additionalProperties", True))
            self.assertEqual("run-example-01", examples["response_examples"]["IncidentProjection"]["run_id"])
            decide = examples["response_examples"]["IncidentProjectionDecide"]
            self.assertEqual("DECIDE", decide["lifecycle_stage"])
            self.assertEqual("ACCEPTED", decide["investigation_result"]["disposition"])
            self.assertEqual(
                decide["evidence_refs"],
                [item["evidence_id"] for item in decide["investigation_result"]["evidence"]],
            )
            self.assertNotIn("reason", decide["investigation_result"])
            self.assertIn("InvestigationResult", openapi["components"]["schemas"])
            self.assertIn("IncidentFocus", openapi["components"]["schemas"])
            self.assertIn("ConversationItem", openapi["components"]["schemas"])
            projection_properties = openapi["components"]["schemas"]["IncidentProjection"]["properties"]
            self.assertIn("incident_focus", projection_properties)
            self.assertIn("conversation_items", projection_properties)
            self.assertIn(
                "operator_status",
                openapi["components"]["schemas"]["InvestigationCritic"]["properties"],
            )
            self.assertEqual(
                "v1.3-staff-incident",
                openapi["x-flowpulse-workspace-contract"]["contract_revision"],
            )
            self.assertEqual(
                "checkout",
                examples["response_examples"]["IncidentProjection"]["incident_focus"]["component_id"],
            )
            self.assertEqual(
                "UNKNOWN",
                examples["response_examples"]["NodeExplanationReceipt"]["explanation"][
                    "conversation_items"
                ][0]["knowledge_state"],
            )
            self.assertEqual(
                "PASS",
                decide["investigation_result"]["critic"]["operator_status"],
            )
            self.assertEqual(
                "incident.accepted", examples["response_examples"]["IncidentNotification"]["event_type"],
            )
            self.assertEqual(
                "Find Cause", examples["response_examples"]["NextBestAction"]["title"],
            )
            self.assertNotIn(
                "capability", examples["request_examples"]["ActionInvocationCommand"],
            )
            self.assertEqual("provider_unavailable", examples["response_examples"]["IncidentProjection"]["degraded_code"])
            self.assertEqual(
                "flowpulse.incident-workspace.v2",
                openapi["components"]["schemas"]["VersionBundle"]["properties"]["workflow_version"]["default"],
            )
            self.assertEqual("0" * 40, manifest["producer_implementation_git_sha"])
            for filename, checksum in manifest["artifacts"].items():
                self.assertEqual(checksum, reported[filename])
                self.assertEqual(checksum, hashlib.sha256((output / filename).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()

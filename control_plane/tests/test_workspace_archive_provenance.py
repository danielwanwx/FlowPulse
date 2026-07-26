"""The workspace archive provenance is derived from immutable image/Git identity."""

import json
import base64
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))

from flowpulse_cp.workspace_provenance import (  # noqa: E402
    IMAGE_GIT_LABEL,
    IMAGE_WORKFLOW_BLOB_LABEL,
    build_producer_attestation,
    verify_producer_attestation,
    write_producer_attestation,
    write_producer_attestation_from_image,
    history_identity,
)


class WorkspaceArchiveProvenanceTests(unittest.TestCase):
    def _head(self):
        return subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()

    def _blob(self):
        return subprocess.check_output(
            ["git", "-C", str(REPO), "rev-parse", "HEAD:control_plane/flowpulse_cp/workspace_workflow.py"],
            text=True,
        ).strip()

    def _image(self):
        return {
            "Id": "sha256:" + "a" * 64,
            "Config": {"Labels": {IMAGE_GIT_LABEL: self._head(), IMAGE_WORKFLOW_BLOB_LABEL: self._blob()}},
        }

    def test_attestation_derives_and_verifies_git_blob_and_immutable_image_labels(self):
        attestation = build_producer_attestation(REPO, self._image())
        self.assertEqual(self._head(), attestation["git_sha"])
        self.assertEqual(self._blob(), attestation["workflow_module_git_blob_oid"])
        self.assertEqual(attestation["git_sha"], attestation["image_revision_label"])
        self.assertEqual(attestation["workflow_module_git_blob_oid"], verify_producer_attestation(REPO, attestation)["workflow_module_git_blob_oid"])

    def test_attestation_rejects_caller_mismatched_image_or_git_identity(self):
        image = self._image()
        image["Config"]["Labels"][IMAGE_GIT_LABEL] = "0" * 40
        with self.assertRaisesRegex(RuntimeError, "producer_image_revision_label_mismatch"):
            build_producer_attestation(REPO, image)

        attestation = build_producer_attestation(REPO, self._image())
        attestation["git_sha"] = "0" * 40
        with self.assertRaisesRegex(RuntimeError, "producer_attestation_image_identity_invalid"):
            verify_producer_attestation(REPO, attestation)

    def test_writer_accepts_only_docker_inspection_shape_not_a_free_form_producer_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            inspect_path = directory / "image-inspect.json"
            output = directory / "attestation.json"
            inspect_path.write_text(json.dumps([self._image()]), encoding="utf-8")
            written = write_producer_attestation(REPO, inspect_path, output)
            self.assertEqual(written, json.loads(output.read_text(encoding="utf-8")))

    def test_image_writer_reads_docker_inspection_instead_of_accepting_a_caller_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "attestation.json"
            head = self._head()
            blob = self._blob()
            image = self._image()
            with patch("flowpulse_cp.workspace_provenance.subprocess.check_output") as command:
                command.side_effect = [
                    json.dumps([image]), head, blob,
                ]
                written = write_producer_attestation_from_image(REPO, "flowpulse-worker:local", output)
            self.assertEqual(head, written["git_sha"])
            self.assertIn("docker", command.call_args_list[0].args[0])

    def test_history_identity_is_derived_from_the_start_event_not_archive_arguments(self):
        raw_path = ROOT / "tests" / "fixtures" / "temporal_workspace_v1" / "workspace_node_explanation_degraded.json"
        raw = raw_path.read_bytes()
        identity = history_identity(raw)
        self.assertEqual("flowpulse.incident-workspace.v1", identity["workflow_type"])
        self.assertNotEqual(identity["run_id"], identity["workflow_run_id"])

        forged = json.loads(raw)
        started = forged["events"][0]["workflowExecutionStartedEventAttributes"]
        request = json.loads(base64.b64decode(started["input"]["payloads"][0]["data"]).decode("utf-8"))
        request["workflow_id"] = "forged-workflow-id"
        started["input"]["payloads"][0]["data"] = base64.b64encode(
            json.dumps(request, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        with self.assertRaisesRegex(RuntimeError, "workspace_history_workflow_id_input_mismatch"):
            history_identity(json.dumps(forged).encode("utf-8"))


if __name__ == "__main__":
    unittest.main()

"""The workspace archive provenance is derived from immutable image/Git identity."""

import asyncio
import json
import base64
import hashlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from flowpulse_cp.workspace_provenance import (  # noqa: E402
    IMAGE_GIT_LABEL,
    IMAGE_WORKFLOW_BLOB_LABEL,
    build_producer_attestation,
    verify_producer_attestation,
    verify_producer_image_attestation,
    write_producer_attestation,
    write_producer_attestation_from_image,
    history_identity,
    inspect_producer_image,
)
from archive_workspace_temporal_history import archive  # noqa: E402


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

    def test_archive_image_verification_rejects_a_different_actual_image(self):
        attestation = build_producer_attestation(REPO, self._image())
        other = self._image()
        other["Id"] = "sha256:" + "b" * 64
        with patch("flowpulse_cp.workspace_provenance.inspect_producer_image", return_value=other):
            with self.assertRaisesRegex(RuntimeError, "producer_image_attestation_mismatch"):
                verify_producer_image_attestation(REPO, "flowpulse-worker:local", attestation)

    def test_archive_image_verification_requires_actual_docker_identity(self):
        attestation = build_producer_attestation(REPO, self._image())
        # ``docker image inspect`` returns a one-element list; the production
        # inspection seam normalizes it before the immutable labels are read.
        with patch("flowpulse_cp.workspace_provenance.inspect_producer_image", return_value=self._image()):
            verified = verify_producer_image_attestation(REPO, "flowpulse-worker:local", attestation)
        self.assertEqual(attestation["image_id"], verified["image_id"])

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

    def test_archive_can_verify_a_read_only_temporal_cli_history_stream_without_host_port(self):
        fixture = ROOT / "tests" / "fixtures" / "temporal_workspace_v1"
        raw = (fixture / "workspace_node_explanation_degraded.json").read_bytes()
        attestation = json.loads((fixture / "producer-attestation.json").read_text(encoding="utf-8"))
        producer = {key: value for key, value in attestation.items() if key != "schema_version"}
        identity = history_identity(raw)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = SimpleNamespace(
                producer_attestation=fixture / "producer-attestation.json", repo_root=REPO,
                producer_image="unused-in-deterministic-stream-test", history_stdin=True, address=None,
                workflow_id=identity["workflow_id"], workflow_run_id=identity["workflow_run_id"], output=output,
            )

            class Stream:
                buffer = io.BytesIO(raw)

            with patch("archive_workspace_temporal_history.verify_producer_image_attestation", return_value=producer):
                with patch.object(sys, "stdin", Stream()):
                    asyncio.run(archive(args))
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(identity["workflow_run_id"], manifest["producer"]["workflow_run_id"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), manifest["histories"][0]["sha256"])

    @unittest.skipUnless(
        os.environ.get("FLOWPULSE_LIVE_WORKSPACE_PROVENANCE") == "1",
        "requires the local inspected workspace producer image",
    )
    def test_live_inspected_image_maps_to_immutable_git_workflow_object(self):
        """No caller-supplied SHA can make the real local image verify."""
        image = inspect_producer_image(os.environ.get("FLOWPULSE_WORKSPACE_PRODUCER_IMAGE", "control_plane-worker:latest"))
        labels = image["Config"]["Labels"]
        git_sha = labels[IMAGE_GIT_LABEL]
        blob = labels[IMAGE_WORKFLOW_BLOB_LABEL]
        source = subprocess.check_output(["git", "-C", str(REPO), "cat-file", "-p", blob])
        attestation = {
            "schema_version": 1,
            "git_sha": git_sha,
            "image_id": image["Id"],
            "image_revision_label": git_sha,
            "workflow_module_repo_path": "control_plane/flowpulse_cp/workspace_workflow.py",
            "workflow_module_git_blob_oid": blob,
            "workflow_module_sha256": hashlib.sha256(source).hexdigest(),
            "workflow_type": "flowpulse.incident-workspace.v1",
        }
        self.assertEqual(attestation, {"schema_version": 1, **verify_producer_image_attestation(
            REPO, os.environ.get("FLOWPULSE_WORKSPACE_PRODUCER_IMAGE", "control_plane-worker:latest"), attestation,
        )})


if __name__ == "__main__":
    unittest.main()

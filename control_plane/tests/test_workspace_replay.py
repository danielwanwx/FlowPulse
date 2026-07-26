"""Replay only an archived real workspace history; never regenerate it in test."""

import asyncio
import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import temporalio
from temporalio.client import WorkflowHistory
from temporalio.worker import Replayer

from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "temporal_workspace_v1"
IMPLEMENTATION_SHA = "341033f531a2afa2786cab4fcba37167e6f3d483"


class WorkspaceHistoryReplayTests(unittest.TestCase):
    def archived_history(self):
        manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(1, manifest["schema_version"])
        self.assertEqual(IMPLEMENTATION_SHA, manifest["producer"]["git_sha"])
        self.assertEqual("flowpulse.incident-workspace.v1", manifest["producer"]["workflow_type"])
        public = manifest["producer"]["public_identity"]
        self.assertNotEqual(public["run_id"], manifest["producer"]["workflow_run_id"])
        self.assertNotEqual(public["run_id"], manifest["producer"]["workflow_id"])
        entry = manifest["histories"][0]
        self.assertEqual("workspace_node_explanation_degraded", entry["name"])
        encoded = (FIXTURE_DIR / entry["filename"]).read_bytes()
        self.assertEqual(entry["sha256"], hashlib.sha256(encoded).hexdigest())
        history = WorkflowHistory.from_json(manifest["producer"]["workflow_id"], encoded.decode("utf-8"))
        self.assertEqual(entry["event_count"], len(history.events))
        started = history.events[0].workflow_execution_started_event_attributes
        self.assertEqual("flowpulse.incident-workspace.v1", started.workflow_type.name)
        self.assertIn(b"start_or_reuse_node_explanation", encoded)
        return history

    def test_archived_history_integrity_and_provenance(self):
        self.archived_history()

    @unittest.skipUnless(
        tuple(int(part) for part in temporalio.__version__.split(".")[:2]) >= (1, 20),
        "Temporal Python SDK >=1.20 required for archived-history replay",
    )
    def test_archived_history_replays_with_current_workspace_workflow(self):
        history = self.archived_history()

        async def replay_archived_history():
            async def iterator():
                yield history
            return await Replayer(workflows=[IncidentWorkspaceTemporalWorkflow]).replay_workflows(iterator())

        replay = asyncio.run(replay_archived_history())
        self.assertEqual({}, replay.replay_failures)


if __name__ == "__main__":
    unittest.main()

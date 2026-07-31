"""Replay immutable Temporal histories produced by the exact parent worker."""

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

from flowpulse_cp.legacy_temporal_workflow import LegacyDiagnosisTemporalWorkflow


PARENT_SHA = "1e4a6c7dec90198dc472c270edf108c112ef3bdf"
PARENT_WORKFLOW_SHA256 = "76a4cc08f0475e70f041cbfa8907533f1436bb2be2526d6fcd2d75b19346c3bb"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "temporal_parent_1e4a6c7"
EXPECTED_HISTORY_NAMES = {
    "pre_ready_rejected",
    "owner_wait_approved",
    "critic_terminal",
}
EXPECTED_OUTCOMES = {
    "pre_ready_rejected": "rejected:owner_gate_not_ready_then_terminated",
    "owner_wait_approved": "owner_wait_update_validation_terminal_approved",
    "critic_terminal": "critic_terminal_needs_human_no_owner_command",
}


class ParentHistoryReplayCompatibilityTests(unittest.TestCase):
    """The current checkout can only consume these archived parent artifacts."""

    def archived_parent_histories(self):
        manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(1, manifest["schema_version"])
        self.assertEqual(PARENT_SHA, manifest["producer"]["git_sha"])
        self.assertEqual("flowpulse.diagnosis.v1", manifest["producer"]["workflow_type"])
        self.assertEqual(PARENT_WORKFLOW_SHA256, manifest["producer"]["workflow_module_sha256"])
        self.assertTrue(manifest["producer"]["image_id"].startswith("sha256:"))
        self.assertEqual(EXPECTED_HISTORY_NAMES, {entry["name"] for entry in manifest["histories"]})

        histories = []
        for entry in manifest["histories"]:
            self.assertEqual(EXPECTED_OUTCOMES[entry["name"]], entry["expected_outcome"])
            encoded = (FIXTURE_DIR / entry["filename"]).read_bytes()
            self.assertEqual(entry["sha256"], hashlib.sha256(encoded).hexdigest(), entry["name"])
            history = WorkflowHistory.from_json(entry["workflow_id"], encoded.decode("utf-8"))
            self.assertEqual(entry["event_count"], len(history.events), entry["name"])
            started = history.events[0].workflow_execution_started_event_attributes
            self.assertEqual("flowpulse.diagnosis.v1", started.workflow_type.name, entry["name"])
            self.assertEqual(entry["run_id"], started.original_execution_run_id, entry["name"])
            self.assertEqual(entry["run_id"], started.first_execution_run_id, entry["name"])
            histories.append(history)
        return histories

    def test_exact_parent_history_fixture_integrity(self):
        self.assertEqual(3, len(self.archived_parent_histories()))

    @unittest.skipUnless(
        tuple(int(part) for part in temporalio.__version__.split(".")[:2]) >= (1, 20),
        "Temporal Python SDK >=1.20 required for archived-history replay",
    )
    def test_exact_parent_v1_histories_replay_with_frozen_v1(self):
        histories = self.archived_parent_histories()

        async def replay_archived_parent_histories():
            async def history_iterator():
                for history in histories:
                    yield history

            return await Replayer(
                workflows=[LegacyDiagnosisTemporalWorkflow],
            ).replay_workflows(history_iterator())

        replay = asyncio.run(replay_archived_parent_histories())
        self.assertEqual({}, replay.replay_failures)


if __name__ == "__main__":
    unittest.main()

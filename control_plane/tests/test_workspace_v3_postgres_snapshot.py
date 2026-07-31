"""Normalized Postgres V3 audit rows retain post-action branch parents."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_v3_models import IncidentProjectionV3


EXAMPLES_PATH = (
    Path(__file__).resolve().parents[1]
    / "openapi"
    / "flowpulse-incident-workflow-v3.examples.json"
)


def branched_projection():
    raw = copy.deepcopy(json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["projection"])
    generated_at = raw["generated_at"]
    parent = raw["current_attempt"]
    parent_id = parent["attempt_id"]
    parent["status"] = "SUPERSEDED"
    parent["completed_at"] = generated_at
    parent["action_executed"] = True
    parent["action_receipt_id"] = "receipt-parent-action"
    for run in parent["stage_runs"]:
        if run["status"] == "RUNNING":
            run["status"] = "SUPERSEDED"
            run["completed_at"] = generated_at

    source_run = copy.deepcopy(parent["stage_runs"][-1])
    child_id = "attempt-post-action-child"
    child_run_id = "stage-run-post-action-investigate"
    source_run.update({
        "stage_run_id": child_run_id,
        "attempt_id": child_id,
        "stage": "INVESTIGATE",
        "status": "RUNNING",
        "run_number": 1,
        "input_workflow_revision": 3,
        "progress_percent": 0,
        "summary": None,
        "output": None,
        "evidence_refs": [],
        "failure_code": None,
        "completed_at": None,
    })
    child = {
        "schema_version": "flowpulse.workflow-attempt.v3",
        "attempt_id": child_id,
        "parent_attempt_id": parent_id,
        "attempt_number": 2,
        "current_stage": "INVESTIGATE",
        "status": "ACTIVE",
        "workflow_revision": 3,
        "created_reason": "Re-open from current real system state.",
        "created_at": generated_at,
        "completed_at": None,
        "stage_runs": [source_run],
        "action_executed": False,
        "action_receipt_id": None,
    }
    raw.update({
        "workflow_revision": 3,
        "projection_revision": 3,
        "sequence": 4,
        "current_attempt": child,
        "attempt_history": [parent],
        "available_commands": ["RETRY", "ESCALATE"],
    })
    return IncidentProjectionV3.parse_obj(raw)


class RecordingConnection:
    def __init__(self):
        self.calls = []

    async def execute(self, statement, *arguments):
        self.calls.append((" ".join(statement.split()), arguments))
        return "INSERT 0 1"


class WorkspaceV3PostgresSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def test_branch_snapshot_appends_parent_and_child_attempt_and_stage_revisions(self):
        projection = branched_projection()
        connection = RecordingConnection()

        await PostgresCaseRepository._insert_workspace_v3_snapshot(
            connection, projection,
        )

        attempt_rows = [
            arguments for statement, arguments in connection.calls
            if "INSERT INTO incident_workflow_attempt_revisions_v3" in statement
        ]
        stage_rows = [
            arguments for statement, arguments in connection.calls
            if "INSERT INTO incident_workflow_stage_run_revisions_v3" in statement
        ]
        parent = projection.attempt_history[0]
        child = projection.current_attempt
        self.assertEqual(
            [parent.attempt_id, child.attempt_id],
            [row[2] for row in attempt_rows],
        )
        self.assertEqual(
            [
                (run.stage_run_id, parent.attempt_id)
                for run in parent.stage_runs
            ] + [
                (run.stage_run_id, child.attempt_id)
                for run in child.stage_runs
            ],
            [(row[2], row[3]) for row in stage_rows],
        )
        self.assertTrue(all(row[4] == projection.projection_revision for row in attempt_rows))
        self.assertTrue(all(row[7] == projection.projection_revision for row in stage_rows))
        # Foreign-key safe order: each attempt row precedes all of its stages,
        # and the parent is materialized before its child.
        call_kinds = [
            "attempt" if "attempt_revisions" in statement
            else "stage" if "stage_run_revisions" in statement
            else "projection"
            for statement, _ in connection.calls
        ]
        self.assertEqual(
            ["projection", "attempt", "stage", "stage", "attempt", "stage"],
            call_kinds,
        )


if __name__ == "__main__":
    unittest.main()

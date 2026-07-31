"""Live snapshot cursor and cards share one repository snapshot boundary."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_v3_guided import GuidedWorkflowCoordinatorV3
from flowpulse_cp.workspace_v3_models import WorkflowCommandV3, WorkflowStageV3
from tests.test_workspace_v3_acceptance import initial_event, initial_projection


class SnapshotConnection:
    def __init__(self, projection):
        self.projection = projection
        self.fetchrow_calls = []

    async def fetchrow(self, statement, *arguments):
        self.fetchrow_calls.append((statement, arguments))
        return {
            "live_sequence": 3,
            "projection_payloads": [self.projection.dict()],
        }


class WorkspaceV3AtomicLiveSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def test_postgres_reads_cursor_and_latest_projections_in_one_statement(self):
        projection = initial_projection("case-a", "incident-a", "run-a")
        connection = SnapshotConnection(projection)
        repository = PostgresCaseRepository("postgresql://not-used")

        async def direct_tenant(tenant_id, operation, subject_id=None):
            self.assertEqual("tenant-a", tenant_id)
            return await operation(connection)

        repository._tenant = direct_tenant
        snapshot = await repository.workspace_live_snapshot_v3("tenant-a")

        self.assertEqual(1, len(connection.fetchrow_calls))
        statement, arguments = connection.fetchrow_calls[0]
        self.assertIn("incident_workflow_projections_v3", statement)
        self.assertIn("incident_workflow_live_outbox_v3", statement)
        self.assertEqual(("tenant-a", 100), arguments)
        self.assertEqual(3, snapshot.sequence)
        self.assertEqual(["case-a"], [item.case_id for item in snapshot.incidents])

    async def test_concurrent_commit_never_returns_old_card_with_new_cursor(self):
        observed = set()
        for index in range(40):
            repository = InMemoryWorkspaceRepository()
            projection = initial_projection("case-a", "incident-a", "run-a")
            await repository.initialize_workspace_v3(
                projection, initial_event(projection),
            )
            coordinator = GuidedWorkflowCoordinatorV3(repository)
            command = WorkflowCommandV3(
                attempt_id=projection.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.DETECT,
                expected_workflow_revision=projection.workflow_revision,
                idempotency_key="advance-{}".format(index),
            )

            if index % 2:
                advance_task = asyncio.create_task(coordinator.advance(
                    "tenant-a", "case-a", command, "subject-a",
                    projection.generated_at,
                ))
                await asyncio.sleep(0)
                snapshot = await repository.workspace_live_snapshot_v3("tenant-a")
                await advance_task
            else:
                snapshot, _ = await asyncio.gather(
                    repository.workspace_live_snapshot_v3("tenant-a"),
                    coordinator.advance(
                        "tenant-a", "case-a", command, "subject-a",
                        projection.generated_at,
                    ),
                )
            pair = (
                snapshot.sequence,
                snapshot.incidents[0].current_stage,
            )
            observed.add(pair)
            self.assertIn(pair, {
                (1, WorkflowStageV3.DETECT),
                (3, WorkflowStageV3.TRIAGE),
            })

        self.assertTrue(observed)


if __name__ == "__main__":
    unittest.main()

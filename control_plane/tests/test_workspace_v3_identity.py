from datetime import datetime, timedelta, timezone
import unittest

from pydantic import ValidationError

from flowpulse_cp.workspace_v3_models import (
    ActionInvocationCommandV3,
    IncidentExecutionIdentityV3,
    TemporalExecutionPointerV3,
    TemporalExecutionRolloverV3,
)


NOW = datetime(2026, 7, 30, 22, 0, tzinfo=timezone.utc)


def identity():
    return IncidentExecutionIdentityV3(
        tenant_id="tenant-a",
        incident_id="incident-a",
        incident_run_id="run-public-a",
        topology_revision="topology-a",
        case_id="case-a",
        case_revision=1,
        temporal_workflow_id="workflow-a",
        created_at=NOW,
    )


def pointer(run_id, generation):
    return TemporalExecutionPointerV3(
        tenant_id="tenant-a",
        incident_run_id="run-public-a",
        temporal_workflow_id="workflow-a",
        temporal_run_id=run_id,
        temporal_generation=generation,
        updated_at=NOW + timedelta(minutes=generation),
    )


class WorkspaceV3IdentityTests(unittest.TestCase):
    def test_rollover_preserves_stable_identity_and_advances_once(self):
        rollover = TemporalExecutionRolloverV3(
            identity=identity(),
            expected=pointer("temporal-run-1", 1),
            replacement=pointer("temporal-run-2", 2),
        )

        self.assertEqual("run-public-a", rollover.identity.incident_run_id)
        self.assertEqual(2, rollover.replacement.temporal_generation)

    def test_rollover_rejects_skipped_generation(self):
        with self.assertRaisesRegex(
            ValidationError,
            "temporal_rollover_generation_must_increment_once",
        ):
            TemporalExecutionRolloverV3(
                identity=identity(),
                expected=pointer("temporal-run-1", 1),
                replacement=pointer("temporal-run-3", 3),
            )

    def test_rollover_rejects_reused_physical_run(self):
        with self.assertRaisesRegex(
            ValidationError,
            "temporal_rollover_requires_new_physical_run",
        ):
            TemporalExecutionRolloverV3(
                identity=identity(),
                expected=pointer("temporal-run-1", 1),
                replacement=pointer("temporal-run-1", 2),
            )

    def test_action_hash_is_bound_to_decision_not_projection_revision(self):
        command = ActionInvocationCommandV3(
            incident_id="incident-a",
            incident_run_id="run-public-a",
            topology_revision="topology-a",
            decision_revision=4,
            action_id="action-a",
            idempotency_key="idem-a",
            idempotency_valid_until=NOW + timedelta(minutes=30),
        )

        self.assertNotIn("projection_revision", command.dict())
        self.assertEqual(64, len(command.canonical_hash()))


if __name__ == "__main__":
    unittest.main()

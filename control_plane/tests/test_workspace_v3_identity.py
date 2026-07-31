from datetime import datetime, timedelta, timezone
import unittest

from pydantic import ValidationError

from flowpulse_cp.workspace_v3_models import (
    ActionInvocationCommandV3,
    IncidentExecutionIdentityV3,
    TemporalExecutionPointerV3,
    TemporalExecutionRolloverV3,
    WorkspaceExecutionRegistrationV3,
    WorkspaceRolloverStateV3,
    resolve_temporal_execution_target_v3,
)
from flowpulse_cp.workspace_activities import (
    WorkspaceActivityDispatcher,
    workspace_activity_surface,
)
from flowpulse_cp.temporal_runtime import WorkspaceTemporalStarter


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

    def test_execution_target_prefers_current_v3_pointer(self):
        class Repository:
            async def current_temporal_execution_v3(self, tenant_id, incident_run_id):
                self.lookup = (tenant_id, incident_run_id)
                return pointer("temporal-run-2", 2)

        class Binding:
            tenant_id = "tenant-a"
            run_id = "run-public-a"
            workflow_id = "workflow-a"
            workflow_run_id = "temporal-run-1"

        async def scenario():
            repository = Repository()
            target = await resolve_temporal_execution_target_v3(
                repository, Binding(),
            )
            self.assertEqual(("tenant-a", "run-public-a"), repository.lookup)
            self.assertEqual("temporal-run-2", target.temporal_run_id)
            self.assertEqual(2, target.temporal_generation)
            self.assertEqual("V3_CURRENT_POINTER", target.source)

        import asyncio
        asyncio.run(scenario())

    def test_execution_target_falls_back_to_frozen_v2_binding(self):
        class Repository:
            pass

        class Binding:
            tenant_id = "tenant-a"
            run_id = "run-public-a"
            workflow_id = "workflow-a"
            workflow_run_id = "temporal-run-1"

        async def scenario():
            target = await resolve_temporal_execution_target_v3(
                Repository(), Binding(),
            )
            self.assertEqual("temporal-run-1", target.temporal_run_id)
            self.assertEqual(1, target.temporal_generation)
            self.assertEqual("V2_IMMUTABLE_BINDING", target.source)

        import asyncio
        asyncio.run(scenario())

    def test_api_update_handle_follows_the_current_execution_pointer(self):
        class Repository:
            async def current_temporal_execution_v3(self, tenant_id, incident_run_id):
                return pointer("temporal-run-2", 2)

        class Projection:
            tenant_id = "tenant-a"
            run_id = "run-public-a"
            workflow_id = "workflow-a"
            workflow_run_id = "temporal-run-1"

        class Client:
            def get_workflow_handle(self, workflow_id, *, run_id):
                return {"workflow_id": workflow_id, "run_id": run_id}

        async def scenario():
            starter = WorkspaceTemporalStarter("temporal:7233", "test-queue")
            starter.bind_execution_repository(Repository())
            handle = await starter._workspace_handle(Client(), Projection())
            self.assertEqual(
                {"workflow_id": "workflow-a", "run_id": "temporal-run-2"},
                handle,
            )

        import asyncio
        asyncio.run(scenario())

    def test_rollover_state_rejects_unbounded_fingerprints(self):
        with self.assertRaises(ValidationError):
            WorkspaceRolloverStateV3(
                identity=identity(),
                current_execution=pointer("temporal-run-1", 1),
                projection_ref="projection:case-a:8",
                projection_revision=8,
                signal_revision=20,
                decision_revision=3,
                workspace_revision=5,
                case_event_sequence=42,
                recent_idempotency_fingerprints=[
                    "fingerprint-{}".format(index) for index in range(129)
                ],
            )

    def test_execution_registration_requires_exact_next_generation(self):
        with self.assertRaisesRegex(
            ValidationError,
            "temporal_rollover_generation_must_increment_once",
        ):
            WorkspaceExecutionRegistrationV3(
                identity=identity(),
                prior=pointer("temporal-run-1", 1),
                current=pointer("temporal-run-3", 3),
            )

    def test_registration_activity_persists_first_and_rollover_generations(self):
        class Repository:
            async def put_incident_execution_v3(self, supplied_identity, current):
                self.initial = (supplied_identity, current)
                return current

            async def rollover_temporal_execution_v3(self, rollover):
                self.rollover = rollover
                return rollover.replacement

        async def scenario():
            repository = Repository()
            dispatcher = WorkspaceActivityDispatcher(repository)
            first = WorkspaceExecutionRegistrationV3(
                identity=identity(),
                current=pointer("temporal-run-1", 1),
            )
            result = await dispatcher.dispatch(
                "workspace_register_execution_v3_activity",
                first.dict(),
            )
            self.assertEqual(1, result["temporal_generation"])
            second = WorkspaceExecutionRegistrationV3(
                identity=identity(),
                prior=pointer("temporal-run-1", 1),
                current=pointer("temporal-run-2", 2),
            )
            result = await dispatcher.dispatch(
                "workspace_register_execution_v3_activity",
                second.dict(),
            )
            self.assertEqual(2, result["temporal_generation"])
            self.assertEqual(
                "temporal-run-2",
                repository.rollover.replacement.temporal_run_id,
            )

        import asyncio
        asyncio.run(scenario())
        self.assertIn(
            "workspace_register_execution_v3_activity",
            workspace_activity_surface(),
        )


if __name__ == "__main__":
    unittest.main()

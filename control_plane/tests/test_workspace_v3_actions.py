from datetime import datetime, timedelta, timezone
import unittest

from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_v3_actions import (
    HmacWorkspaceActionAuthorityV3,
    NextBestActionV3,
    WorkspaceActionAuthorizationIntentV3,
    validate_current_action_card_v3,
)
from flowpulse_cp.workspace_v3_models import (
    ActionInvocationCommandV3,
    IncidentExecutionIdentityV3,
)


NOW = datetime(2026, 7, 30, 22, 0, tzinfo=timezone.utc)


def identity():
    return IncidentExecutionIdentityV3(
        tenant_id="tenant-a", incident_id="incident-a", incident_run_id="run-a",
        topology_revision="topology-a", case_id="case-a", case_revision=1,
        temporal_workflow_id="workflow-a", created_at=NOW,
    )


def command(decision_revision=3):
    return ActionInvocationCommandV3(
        incident_id="incident-a", incident_run_id="run-a",
        topology_revision="topology-a", decision_revision=decision_revision,
        action_id="action-a", idempotency_key="idem-a",
        idempotency_valid_until=NOW + timedelta(minutes=30),
    )


class WorkspaceV3ActionTests(unittest.TestCase):
    def test_signal_tick_is_not_part_of_v3_card_validity(self):
        card = NextBestActionV3(
            **identity().dict(), action_id="action-a", card_version=1,
            decision_revision=3, evidence_revision=7, title="Read evidence",
            summary="Read bounded current evidence.", required_permission="incident:read",
            precondition_version="decision.v3", precondition_hash="a" * 64,
            idempotency_valid_until=NOW + timedelta(minutes=30),
            expires_at=NOW + timedelta(minutes=5),
        )
        validate_current_action_card_v3(
            card, command(), ["incident:read"], NOW,
        )

    def test_assertion_survives_physical_temporal_rollover(self):
        cmd = command()
        authority = HmacWorkspaceActionAuthorityV3("secret")
        intent = WorkspaceActionAuthorizationIntentV3(
            intent_id="intent-a", identity=identity(), decision_revision=3,
            action_id="action-a", command_hash=cmd.canonical_hash(),
            subject_id="subject-a", roles=["owner"], created_at=NOW,
            expires_at=NOW + timedelta(minutes=1),
        )
        assertion = authority.issue(intent, now=NOW)
        authority.resolve(assertion, cmd, now=NOW)

    def test_changed_decision_revision_requires_revalidation(self):
        cmd = command()
        authority = HmacWorkspaceActionAuthorityV3("secret")
        intent = WorkspaceActionAuthorizationIntentV3(
            intent_id="intent-a", identity=identity(), decision_revision=3,
            action_id="action-a", command_hash=cmd.canonical_hash(),
            subject_id="subject-a", roles=["owner"], created_at=NOW,
            expires_at=NOW + timedelta(minutes=1),
        )
        assertion = authority.issue(intent, now=NOW)
        with self.assertRaisesRegex(PolicyViolation, "scope_mismatch"):
            authority.resolve(assertion, command(decision_revision=4), now=NOW)


if __name__ == "__main__":
    unittest.main()

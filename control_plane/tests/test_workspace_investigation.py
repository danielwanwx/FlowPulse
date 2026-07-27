"""Canonical Investigate result and Temporal-owned Decide handoff."""

import asyncio
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.models import AuthContext, VerificationDecision
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.workspace_investigation import (
    DeterministicInvestigationCritic,
    DeterministicInvestigationSynthesizer,
    WorkspaceInvestigationCriticPacket,
    WorkspaceInvestigationFinalizePacket,
    WorkspaceInvestigationSynthesisPacket,
    temporal_investigation_finalize_activity,
    validate_workspace_investigation_commit,
)
from flowpulse_cp.workspace_models import (
    Gate1ProjectionState,
    IncidentLifecycleStage,
    IncidentProjection,
    InvestigationDisposition,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from tests.test_gate1_capabilities import binding, complete_fresh_read


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


async def fresh_read(repository, prefix):
    item = binding()
    _, transition, outcome = await complete_fresh_read(
        repository, item, idempotency_prefix=prefix,
    )
    return item, transition, IncidentProjection.parse_obj(outcome["projection"])


async def synthesize_and_finalize(repository, item, transition, projection, synthesizer, critic):
    dispatcher = WorkspaceActivityDispatcher(
        repository,
        investigation_synthesizer=synthesizer,
        investigation_critic=critic,
    )
    synthesis_packet = WorkspaceInvestigationSynthesisPacket(
        **item.dict(),
        projection=projection,
        component_id="checkout",
        actor_subject_id="subject-a",
        source_action_id=transition.receipt.action_id,
        source_idempotency_key=transition.receipt.idempotency_key,
        synthesis_activity_id="investigation-synthesis:" + transition.command_fingerprint,
    )
    synthesis = await dispatcher.dispatch(
        "workspace_synthesize_investigation_activity", synthesis_packet.dict(),
    )
    critic_outcome = None
    if synthesis["disposition"] == "CANDIDATE":
        critic_packet = WorkspaceInvestigationCriticPacket(
            **item.dict(),
            projection=projection,
            component_id="checkout",
            actor_subject_id="subject-a",
            source_action_id=transition.receipt.action_id,
            source_idempotency_key=transition.receipt.idempotency_key,
            critic_activity_id="investigation-critic:" + transition.command_fingerprint,
            synthesis=synthesis,
        )
        critic_outcome = await dispatcher.dispatch(
            "workspace_critic_investigation_activity", critic_packet.dict(),
        )
    activity_name = temporal_investigation_finalize_activity(synthesis, critic_outcome)
    final = await dispatcher.dispatch(
        activity_name,
        WorkspaceInvestigationFinalizePacket(
            **item.dict(),
            projection=projection,
            component_id="checkout",
            actor_subject_id="subject-a",
            source_action_id=transition.receipt.action_id,
            source_idempotency_key=transition.receipt.idempotency_key,
            transition_key="investigation:" + transition.command_fingerprint,
            event_sequence=projection.sequence + 1,
            synthesis=synthesis,
            critic=critic_outcome,
        ).dict(),
    )
    return synthesis, critic_outcome, final


class WorkspaceInvestigationTests(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_read_alone_cannot_advance_to_decide(self):
        repository = InMemoryWorkspaceRepository()
        _, _, projection = await fresh_read(repository, "read-only")
        self.assertEqual(IncidentLifecycleStage.INVESTIGATE, projection.lifecycle_stage)
        self.assertEqual(Gate1ProjectionState.CONSUMED, projection.gate1_state)
        self.assertIsNone(projection.investigation_result)

    async def test_current_evidence_and_independent_critic_create_one_decide_handoff(self):
        repository = InMemoryWorkspaceRepository()
        item, transition, projection = await fresh_read(repository, "accepted")
        synthesizer = DeterministicInvestigationSynthesizer()
        critic = DeterministicInvestigationCritic()
        synthesis, critic_outcome, final = await synthesize_and_finalize(
            repository, item, transition, projection, synthesizer, critic,
        )
        projected = IncidentProjection.parse_obj(final["projection"])
        result = projected.investigation_result
        self.assertEqual(IncidentLifecycleStage.DECIDE, projected.lifecycle_stage)
        self.assertEqual("investigation_accepted", projected.status)
        self.assertEqual(InvestigationDisposition.ACCEPTED, result.disposition)
        self.assertEqual(VerificationDecision.PASS, result.critic.decision)
        self.assertEqual({"OBSERVATION", "HYPOTHESIS"}, {claim.kind.value for claim in result.claims})
        self.assertEqual(set(projected.evidence_refs), {evidence.evidence_id for evidence in result.evidence})
        self.assertTrue(all(evidence.freshness.value == "CURRENT" for evidence in result.evidence))
        self.assertEqual("workspace_accept_investigation_activity", temporal_investigation_finalize_activity(
            synthesis, critic_outcome,
        ))
        self.assertEqual([], final["actions"])

        repeated = await WorkspaceActivityDispatcher(
            repository,
            investigation_synthesizer=synthesizer,
            investigation_critic=critic,
        ).dispatch(
            "workspace_accept_investigation_activity",
            WorkspaceInvestigationFinalizePacket(
                **item.dict(),
                projection=projection,
                component_id="checkout",
                actor_subject_id="subject-a",
                source_action_id=transition.receipt.action_id,
                source_idempotency_key=transition.receipt.idempotency_key,
                transition_key="investigation:" + transition.command_fingerprint,
                event_sequence=projection.sequence + 1,
                synthesis=synthesis,
                critic=critic_outcome,
            ).dict(),
        )
        self.assertEqual(final, repeated)
        events = await repository.workspace_events_after(item.tenant_id, item.case_id, 0)
        self.assertEqual(1, sum(event.event_type == "workspace.investigation.accepted" for event in events))
        self.assertEqual(1, synthesizer.call_count)
        self.assertEqual(1, critic.call_count)

    async def test_critic_rejection_stays_investigate_and_never_publishes_success(self):
        repository = InMemoryWorkspaceRepository()
        item, transition, projection = await fresh_read(repository, "critic-reject")
        _, critic_outcome, final = await synthesize_and_finalize(
            repository,
            item,
            transition,
            projection,
            DeterministicInvestigationSynthesizer(),
            DeterministicInvestigationCritic(decision=VerificationDecision.FAIL),
        )
        projected = IncidentProjection.parse_obj(final["projection"])
        self.assertEqual(IncidentLifecycleStage.INVESTIGATE, projected.lifecycle_stage)
        self.assertEqual(InvestigationDisposition.CRITIC_REJECTED, projected.investigation_result.disposition)
        self.assertEqual(VerificationDecision.FAIL, critic_outcome["decision"])
        self.assertEqual(
            {"OBSERVATION"},
            {claim.kind.value for claim in projected.investigation_result.claims},
        )
        committed = next(iter(repository.workspace_investigation_commits.values()))
        self.assertEqual([], committed.domain_claims)
        self.assertEqual([], final["actions"])
        events = await repository.workspace_events_after(item.tenant_id, item.case_id, 0)
        self.assertFalse(any(event.event_type == "workspace.investigation.accepted" for event in events))

    async def test_cross_run_or_stale_synthesis_is_rejected_before_projection(self):
        repository = InMemoryWorkspaceRepository()
        item, transition, projection = await fresh_read(repository, "scope-reject")
        synthesizer = DeterministicInvestigationSynthesizer()
        dispatcher = WorkspaceActivityDispatcher(
            repository,
            investigation_synthesizer=synthesizer,
            investigation_critic=DeterministicInvestigationCritic(),
        )
        base = WorkspaceInvestigationSynthesisPacket(
            **item.dict(),
            projection=projection,
            component_id="checkout",
            actor_subject_id="subject-a",
            source_action_id=transition.receipt.action_id,
            source_idempotency_key=transition.receipt.idempotency_key,
            synthesis_activity_id="investigation-synthesis:" + transition.command_fingerprint,
        )
        with self.assertRaisesRegex(
            Exception,
            "investigation_(binding|projection|source_transition)_mismatch",
        ):
            await dispatcher.dispatch(
                "workspace_synthesize_investigation_activity",
                base.copy(update={
                    "run_id": "run-attacker",
                    "projection": projection.copy(update={"projection_revision": projection.projection_revision + 1}),
                }).dict(),
            )
        for changes, message in [
            ({"tenant_id": "tenant-attacker"}, "investigation_source_transition_missing"),
            ({"component_id": "inventory"}, "investigation_component_not_canonical"),
            (
                {"projection": projection.copy(update={
                    "evidence_revision": projection.evidence_revision + 1,
                })},
                "investigation_source_transition_mismatch",
            ),
        ]:
            with self.assertRaisesRegex(Exception, message):
                await dispatcher.dispatch(
                    "workspace_synthesize_investigation_activity",
                    base.copy(update=changes).dict(),
                )
        self.assertEqual(0, synthesizer.call_count)
        current = await repository.workspace_projection(item.tenant_id, item.case_id)
        self.assertEqual(projection, current)

    async def test_unavailable_provider_publishes_typed_degraded_result_without_critic_or_action(self):
        repository = InMemoryWorkspaceRepository()
        item, transition, projection = await fresh_read(repository, "provider-unavailable")
        dispatcher = WorkspaceActivityDispatcher(repository)
        synthesis = await dispatcher.dispatch(
            "workspace_synthesize_investigation_activity",
            WorkspaceInvestigationSynthesisPacket(
                **item.dict(), projection=projection, component_id="checkout",
                actor_subject_id="subject-a", source_action_id=transition.receipt.action_id,
                source_idempotency_key=transition.receipt.idempotency_key,
                synthesis_activity_id="investigation-synthesis:" + transition.command_fingerprint,
            ).dict(),
        )
        self.assertEqual("DEGRADED", synthesis["disposition"])
        self.assertEqual("investigation_provider_unavailable", synthesis["degraded_code"])
        final = await dispatcher.dispatch(
            temporal_investigation_finalize_activity(synthesis, None),
            WorkspaceInvestigationFinalizePacket(
                **item.dict(), projection=projection, component_id="checkout",
                actor_subject_id="subject-a", source_action_id=transition.receipt.action_id,
                source_idempotency_key=transition.receipt.idempotency_key,
                transition_key="investigation:" + transition.command_fingerprint,
                event_sequence=projection.sequence + 1, synthesis=synthesis,
            ).dict(),
        )
        projected = IncidentProjection.parse_obj(final["projection"])
        self.assertEqual(IncidentLifecycleStage.INVESTIGATE, projected.lifecycle_stage)
        self.assertEqual(InvestigationDisposition.DEGRADED, projected.investigation_result.disposition)
        self.assertEqual("DEGRADED", projected.investigation_result.truth_label.value)
        self.assertEqual([], final["actions"])

    async def test_repository_validator_rejects_tampered_component_and_evidence_lineage(self):
        repository = InMemoryWorkspaceRepository()
        item, transition, projection = await fresh_read(repository, "tamper")
        _, _, final = await synthesize_and_finalize(
            repository, item, transition, projection,
            DeterministicInvestigationSynthesizer(), DeterministicInvestigationCritic(),
        )
        committed = next(iter(repository.workspace_investigation_commits.values()))
        result = IncidentProjection.parse_obj(final["projection"]).investigation_result
        synthesis_record = await repository.workspace_investigation_stage_record(
            item.tenant_id, item.case_id, result.synthesis_activity_id,
        )
        critic_record = next(
            record for record in repository.workspace_investigation_stage_records.values()
            if record.critic is not None
        )
        forged_result = result.copy(update={"component_id": "inventory"})
        forged_projection = committed.projection.copy(update={"investigation_result": forged_result})
        forged_commit = committed.copy(update={"projection": forged_projection})
        with self.assertRaisesRegex(Exception, "workspace_investigation_result_source_mismatch"):
            validate_workspace_investigation_commit(
                forged_commit, transition, synthesis_record.synthesis, critic_record.critic,
            )
        stale_evidence = result.evidence[0].copy(update={"freshness": "STALE"})
        with self.assertRaises(ValidationError):
            type(result).parse_obj({
                **result.dict(),
                "evidence": [stale_evidence.dict()] + [item.dict() for item in result.evidence[1:]],
            })

    async def test_pre_slice_projection_payload_remains_readable_as_investigate(self):
        repository = InMemoryWorkspaceRepository()
        _, _, projection = await fresh_read(repository, "compat")
        archived = projection.dict()
        archived.pop("lifecycle_stage")
        archived.pop("gate1_state")
        archived.pop("investigation_result")
        decoded = IncidentProjection.parse_obj(archived)
        self.assertEqual(IncidentLifecycleStage.INVESTIGATE, decoded.lifecycle_stage)
        self.assertEqual(Gate1ProjectionState.NONE, decoded.gate1_state)
        self.assertIsNone(decoded.investigation_result)


class WorkspaceInvestigationApiTests(unittest.TestCase):
    def test_projection_and_sse_publish_structured_result_without_receipt_parsing(self):
        async def arrange():
            repository = InMemoryWorkspaceRepository()
            item, transition, projection = await fresh_read(repository, "api")
            _, _, final = await synthesize_and_finalize(
                repository,
                item,
                transition,
                projection,
                DeterministicInvestigationSynthesizer(),
                DeterministicInvestigationCritic(),
            )
            return repository, item, final

        repository, item, final = asyncio.run(arrange())
        app = create_app(workspace_repository=repository)
        app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id=item.tenant_id, subject_id="subject-a", roles=["viewer"],
        )
        client = TestClient(app)
        response = client.get("/v1/incidents/{}/projection".format(item.case_id))
        self.assertEqual(200, response.status_code, response.text)
        body = response.json()
        self.assertEqual("DECIDE", body["lifecycle_stage"])
        self.assertEqual("ACCEPTED", body["investigation_result"]["disposition"])
        self.assertNotIn("reason", body["investigation_result"])
        actions = client.get("/v1/incidents/{}/actions".format(item.case_id))
        self.assertEqual(200, actions.status_code, actions.text)
        self.assertEqual([], actions.json())
        stream = client.get("/v1/incidents/{}/events?after={}".format(
            item.case_id, final["projection"]["sequence"] - 1,
        ))
        self.assertEqual(200, stream.status_code, stream.text)
        self.assertIn("workspace.investigation.accepted", stream.text)
        self.assertIn(final["projection"]["investigation_result"]["result_id"], stream.text)


if __name__ == "__main__":
    unittest.main()

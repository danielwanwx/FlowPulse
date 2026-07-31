"""Activities for the additive Incident Workspace workflow.

Conversation/provider work is bounded inside this Temporal activity.  No
fresh capability invocation is permitted before the later Gate 1 increment.
"""

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Any, Dict, List

from .models import (
    CaseState,
    ClaimRecord,
    ClaimStatus,
    EvidenceAuthority,
    FreshnessStatus,
    IncidentCase,
    ProofScope,
    SourceKind,
    VerificationDecision,
)
from .policy import PolicyViolation
from .capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityInvocationContext,
    CapabilityRequest,
    CapabilityScope,
    ToolCallBudget,
)
from .workspace_models import (
    ConversationItem,
    ConversationKnowledgeState,
    Gate1ProjectionState,
    IncidentEvent,
    IncidentLifecycleStage,
    IncidentProjection,
    IncidentRunBinding,
    ExplanationEventStatus,
    InvestigationClaim,
    InvestigationClaimKind,
    InvestigationCritic,
    InvestigationDisposition,
    InvestigationEvidenceReference,
    InvestigationResult,
    NodeExplanation,
    NodeExplanationState,
    ProjectionState,
    ProviderTruthLabel,
    VersionBundle,
    WorkspaceActivityOutcome,
    WorkspaceActivityPacket,
    WorkspaceNodeExplanationAuthorizationOutcome,
    WorkspaceNodeExplanationAuthorizationPacket,
)
from .workspace_actions import (
    ActionInvocationCommand,
    Gate1Lease,
    Gate1LeaseStatus,
    NextBestActionGenerator,
    WorkspaceActionAuthorizationOutcome,
    WorkspaceActionAuthorizationPacket,
    WorkspaceActionCommit,
    WorkspaceActionGenerationOutcome,
    WorkspaceActionGenerationPacket,
    WorkspaceActionOutcome,
    WorkspaceActionPacket,
    WorkspaceActionReceipt,
    canonical_evidence_set_hash,
    validate_current_action_card,
    workspace_permissions_for_roles,
)
from .workspace_investigation import (
    InvestigationCriticOutcome,
    InvestigationCriticOutput,
    InvestigationCriticRequest,
    InvestigationSynthesisDisposition,
    InvestigationSynthesisOutcome,
    InvestigationSynthesisOutput,
    InvestigationSynthesisRequest,
    InvestigationStageRecordKind,
    UnavailableInvestigationCritic,
    UnavailableInvestigationSynthesizer,
    WorkspaceInvestigationCommit,
    WorkspaceInvestigationCriticPacket,
    WorkspaceInvestigationFinalizePacket,
    WorkspaceInvestigationOutcome,
    WorkspaceInvestigationStageRecord,
    WorkspaceInvestigationSynthesisPacket,
    claim_fingerprint,
    temporal_investigation_finalize_activity,
    validate_investigation_source_transition,
)
from .workspace_v3_models import (
    TemporalExecutionRolloverV3,
    WorkspaceExecutionRegistrationV3,
)


def workspace_activity_surface() -> List[str]:
    return [
        "workspace_register_execution_v3_activity",
        "workspace_initialize_activity",
        "workspace_authorize_node_explanation_activity",
        "workspace_node_explanation_activity",
        "workspace_authorize_action_activity",
        "workspace_generate_actions_activity",
        "workspace_execute_action_activity",
        "workspace_synthesize_investigation_activity",
        "workspace_critic_investigation_activity",
        "workspace_accept_investigation_activity",
        "workspace_record_investigation_degraded_activity",
    ]


def build_workspace_activities(dispatcher: "WorkspaceActivityDispatcher") -> List[Any]:
    from temporalio import activity
    from temporalio.exceptions import ApplicationError

    def definition(name: str):
        @activity.defn(name=name)
        async def run(packet: Dict[str, Any]) -> Dict[str, Any]:
            try:
                return await dispatcher.dispatch(name, packet)
            except Exception as error:
                # Authorization/policy denials are terminal at the activity
                # boundary. Do not let Temporal replay a forged command.
                from .policy import PolicyViolation
                if isinstance(error, PolicyViolation):
                    raise ApplicationError(str(error), non_retryable=True) from error
                raise
        return run

    return [definition(name) for name in workspace_activity_surface()]


class WorkspaceActivityDispatcher:
    """Writes only Temporal-derived public projections and safe degraded records."""

    def __init__(
        self, repository: Any, conversation_manager: Any = None, authorization: Any = None,
        capability_registry: Any = None, investigation_synthesizer: Any = None,
        investigation_critic: Any = None, topology_provider: Any = None,
    ) -> None:
        self.repository = repository
        self.conversation_manager = conversation_manager
        self.authorization = authorization
        self.capability_registry = capability_registry
        self.investigation_synthesizer = (
            investigation_synthesizer or UnavailableInvestigationSynthesizer()
        )
        self.investigation_critic = investigation_critic or UnavailableInvestigationCritic()
        self.topology_provider = topology_provider
        configure = getattr(repository, "configure_workspace_capability_registry", None)
        if capability_registry is not None and configure is not None:
            configure(capability_registry)

    @staticmethod
    def _binding(item) -> IncidentRunBinding:
        return IncidentRunBinding.parse_obj({
            name: getattr(item, name) for name in IncidentRunBinding.__fields__
        })

    async def _investigation_source(self, packet):
        source = await self.repository.workspace_action_commit(
            packet.tenant_id, packet.case_id, packet.source_idempotency_key,
        )
        validate_investigation_source_transition(
            self._binding(packet), packet.projection, source,
            source_action_id=packet.source_action_id,
            source_idempotency_key=packet.source_idempotency_key,
        )
        if packet.component_id not in {node.component_id for node in packet.projection.graph.nodes}:
            raise PolicyViolation("investigation_component_not_canonical")
        if (
            source.capability_audit.subject_id != packet.actor_subject_id
            or source.capability_audit.component_id != packet.component_id
            or packet.actor_subject_id not in {
                subject
                for evidence in source.capability_result.evidence
                for subject in evidence.acl_subjects
            }
        ):
            raise PolicyViolation("investigation_subject_evidence_acl_denied")
        return source

    async def _synthesize_investigation(self, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        packet = WorkspaceInvestigationSynthesisPacket.parse_obj(packet_data)
        prior = await self.repository.workspace_investigation_stage_record(
            packet.tenant_id, packet.case_id, packet.synthesis_activity_id,
        )
        if prior is not None:
            if prior.kind != InvestigationStageRecordKind.SYNTHESIS:
                raise PolicyViolation("investigation_stage_record_kind_mismatch")
            return prior.synthesis.dict()
        source = await self._investigation_source(packet)
        request = InvestigationSynthesisRequest(
            **self._binding(packet).dict(),
            projection_revision=packet.projection.projection_revision,
            evidence_revision=packet.projection.evidence_revision,
            component_id=packet.component_id,
            synthesis_activity_id=packet.synthesis_activity_id,
            observations=source.capability_result.claims,
            evidence=source.capability_result.evidence,
        )
        output = None
        degraded_code = None
        try:
            raw = await self.investigation_synthesizer.synthesize(request)
            output = InvestigationSynthesisOutput.parse_obj(raw) if raw is not None else None
        except Exception:
            degraded_code = "investigation_provider_output_invalid"
        evidence_refs = [item.evidence_id for item in request.evidence]
        disposition = InvestigationSynthesisDisposition.DEGRADED
        truth_label = ProviderTruthLabel.DEGRADED
        provider_id = getattr(
            self.investigation_synthesizer, "provider_id", "unconfigured-investigation-provider",
        )
        model_id = getattr(self.investigation_synthesizer, "model_id", None)
        summary = "Investigation synthesis is unavailable; current evidence remains recorded."
        hypotheses = []
        if output is not None:
            if any(
                not set(candidate.evidence_refs).issubset(set(evidence_refs))
                for candidate in output.hypotheses
            ):
                output = None
                degraded_code = "investigation_provider_evidence_mismatch"
            elif output.abstained:
                disposition = InvestigationSynthesisDisposition.ABSTAINED
                degraded_code = "investigation_abstained"
                summary = output.summary
            else:
                configured_truth = getattr(self.investigation_synthesizer, "truth_label", None)
                if configured_truth not in {
                    ProviderTruthLabel.TEST_DETERMINISTIC,
                    ProviderTruthLabel.DEMO,
                    ProviderTruthLabel.LIVE,
                }:
                    output = None
                    degraded_code = "investigation_provider_truth_mode_invalid"
                else:
                    disposition = InvestigationSynthesisDisposition.CANDIDATE
                    truth_label = configured_truth
                    summary = output.summary
                    hypotheses = output.hypotheses
        if output is None and degraded_code is None:
            degraded_code = "investigation_provider_unavailable"
        synthesis_id = "investigation-synthesis-{}".format(
            sha256(packet.synthesis_activity_id.encode("utf-8")).hexdigest()[:24],
        )
        outcome = InvestigationSynthesisOutcome(
            **self._binding(packet).dict(),
            synthesis_id=synthesis_id,
            synthesis_activity_id=packet.synthesis_activity_id,
            source_action_id=packet.source_action_id,
            source_idempotency_key=packet.source_idempotency_key,
            component_id=packet.component_id,
            projection_revision=packet.projection.projection_revision,
            evidence_revision=packet.projection.evidence_revision,
            disposition=disposition,
            truth_label=truth_label,
            provider_id=provider_id,
            model_id=model_id,
            summary=summary,
            hypotheses=hypotheses,
            evidence_refs=evidence_refs,
            degraded_code=degraded_code,
        )
        record = WorkspaceInvestigationStageRecord(
            **self._binding(packet).dict(),
            record_id=packet.synthesis_activity_id,
            kind=InvestigationStageRecordKind.SYNTHESIS,
            synthesis=outcome,
        )
        await self.repository.append_workspace_investigation_stage_record(record)
        return outcome.dict()

    async def _critic_investigation(self, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        packet = WorkspaceInvestigationCriticPacket.parse_obj(packet_data)
        prior = await self.repository.workspace_investigation_stage_record(
            packet.tenant_id, packet.case_id, packet.critic_activity_id,
        )
        if prior is not None:
            if prior.kind != InvestigationStageRecordKind.CRITIC:
                raise PolicyViolation("investigation_stage_record_kind_mismatch")
            return prior.critic.dict()
        source = await self._investigation_source(packet)
        synthesis_record = await self.repository.workspace_investigation_stage_record(
            packet.tenant_id, packet.case_id, packet.synthesis.synthesis_activity_id,
        )
        if synthesis_record is None or synthesis_record.synthesis != packet.synthesis:
            raise PolicyViolation("investigation_synthesis_not_authoritative")
        if packet.synthesis.disposition != InvestigationSynthesisDisposition.CANDIDATE:
            raise PolicyViolation("investigation_critic_candidate_required")
        if getattr(self.investigation_critic, "identity", "") == packet.synthesis.provider_id:
            raise PolicyViolation("investigation_critic_identity_not_independent")
        request = InvestigationCriticRequest(
            **self._binding(packet).dict(),
            projection_revision=packet.projection.projection_revision,
            evidence_revision=packet.projection.evidence_revision,
            component_id=packet.component_id,
            critic_activity_id=packet.critic_activity_id,
            synthesis=packet.synthesis,
            observations=source.capability_result.claims,
            evidence=source.capability_result.evidence,
        )
        try:
            output = InvestigationCriticOutput.parse_obj(
                await self.investigation_critic.critique(request),
            )
        except Exception:
            output = InvestigationCriticOutput(
                decision=VerificationDecision.AMBIGUOUS,
                reason_codes=["critic_provider_output_invalid"],
            )
        fingerprints = [
            claim_fingerprint(item.claim_type, item.statement, item.evidence_ids)
            for item in request.observations
        ] + [
            claim_fingerprint("hypothesis", item.statement, item.evidence_refs)
            for item in packet.synthesis.hypotheses
        ]
        outcome = InvestigationCriticOutcome(
            **self._binding(packet).dict(),
            critic_id="investigation-critic-{}".format(
                sha256(packet.critic_activity_id.encode("utf-8")).hexdigest()[:24],
            ),
            critic_activity_id=packet.critic_activity_id,
            identity=getattr(self.investigation_critic, "identity", "unconfigured-investigation-critic"),
            source_action_id=packet.source_action_id,
            source_idempotency_key=packet.source_idempotency_key,
            component_id=packet.component_id,
            projection_revision=packet.projection.projection_revision,
            evidence_revision=packet.projection.evidence_revision,
            decision=output.decision,
            reason_codes=output.reason_codes,
            reviewed_claim_fingerprints=fingerprints,
            evidence_refs=[item.evidence_id for item in request.evidence],
        )
        await self.repository.append_workspace_investigation_stage_record(
            WorkspaceInvestigationStageRecord(
                **self._binding(packet).dict(),
                record_id=packet.critic_activity_id,
                kind=InvestigationStageRecordKind.CRITIC,
                critic=outcome,
            ),
        )
        return outcome.dict()

    async def _finalize_investigation(
        self, activity_name: str, packet_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        packet = WorkspaceInvestigationFinalizePacket.parse_obj(packet_data)
        existing = await self.repository.workspace_investigation_transition(
            packet.tenant_id, packet.case_id, packet.transition_key,
        )
        if existing is not None:
            return WorkspaceInvestigationOutcome(
                projection=existing.projection,
                result=existing.projection.investigation_result,
                actions=existing.actions,
            ).dict()
        source = await self._investigation_source(packet)
        synthesis_record = await self.repository.workspace_investigation_stage_record(
            packet.tenant_id, packet.case_id, packet.synthesis.synthesis_activity_id,
        )
        if synthesis_record is None or synthesis_record.synthesis != packet.synthesis:
            raise PolicyViolation("investigation_synthesis_not_authoritative")
        if packet.critic is not None:
            critic_record = await self.repository.workspace_investigation_stage_record(
                packet.tenant_id, packet.case_id, packet.critic.critic_activity_id,
            )
            if critic_record is None or critic_record.critic != packet.critic:
                raise PolicyViolation("investigation_critic_not_authoritative")
        expected_activity = temporal_investigation_finalize_activity(packet.synthesis, packet.critic)
        if activity_name != expected_activity:
            raise PolicyViolation("investigation_temporal_decision_mismatch")
        accepted = activity_name == "workspace_accept_investigation_activity"
        evidence = [
            InvestigationEvidenceReference(
                evidence_id=item.evidence_id,
                source_kind=item.source_kind,
                observed_at=item.observed_at,
                freshness=item.freshness,
                authority=item.authority,
                proof_scope=item.proof_scope,
                parent_evidence_refs=item.parent_evidence_ids,
            )
            for item in source.capability_result.evidence
        ]
        public_claims = [
            InvestigationClaim(
                claim_id=item.claim_id,
                kind=InvestigationClaimKind.OBSERVATION,
                statement=item.statement,
                evidence_refs=item.evidence_ids,
            )
            for item in source.capability_result.claims
        ]
        domain_claims = []
        if accepted:
            for candidate in packet.synthesis.hypotheses:
                claim_id = "investigation-claim-{}".format(
                    claim_fingerprint("hypothesis", candidate.statement, candidate.evidence_refs)[:24],
                )
                public_claims.append(InvestigationClaim(
                    claim_id=claim_id,
                    kind=InvestigationClaimKind.HYPOTHESIS,
                    statement=candidate.statement,
                    evidence_refs=candidate.evidence_refs,
                ))
                domain_claims.append(ClaimRecord(
                    claim_id=claim_id,
                    case_id=packet.case_id,
                    case_revision=packet.case_revision,
                    tenant_id=packet.tenant_id,
                    claim_type="hypothesis",
                    statement=candidate.statement,
                    evidence_ids=candidate.evidence_refs,
                    status=ClaimStatus.SUPPORTED,
                    requires_current_proof=True,
                    created_by="workspace-investigator:" + packet.synthesis.synthesis_activity_id,
                ))
        disposition = InvestigationDisposition.ACCEPTED
        degraded_code = None
        lifecycle_stage = IncidentLifecycleStage.DECIDE
        lifecycle_state = ProjectionState.ACTIVE
        status = "investigation_accepted"
        truth_label = packet.synthesis.truth_label
        critic = None
        if packet.critic is not None:
            critic = InvestigationCritic(
                critic_id=packet.critic.critic_id,
                identity=packet.critic.identity,
                decision=packet.critic.decision,
                reason_codes=packet.critic.reason_codes,
                reviewed_claim_ids=[item.claim_id for item in public_claims],
                evidence_refs=packet.critic.evidence_refs,
            )
        if not accepted:
            lifecycle_stage = IncidentLifecycleStage.INVESTIGATE
            lifecycle_state = ProjectionState.DEGRADED
            truth_label = ProviderTruthLabel.DEGRADED
            status = "investigation_degraded"
            degraded_code = packet.synthesis.degraded_code or "investigation_critic_rejected"
            if packet.synthesis.disposition == InvestigationSynthesisDisposition.ABSTAINED:
                disposition = InvestigationDisposition.ABSTAINED
            elif packet.synthesis.disposition == InvestigationSynthesisDisposition.DEGRADED:
                disposition = InvestigationDisposition.DEGRADED
            else:
                disposition = InvestigationDisposition.CRITIC_REJECTED
                degraded_code = "investigation_critic_rejected"
        next_revision = packet.projection.projection_revision + 1
        result_id = "investigation-result-{}".format(
            sha256(packet.transition_key.encode("utf-8")).hexdigest()[:24],
        )
        result = InvestigationResult(
            **self._binding(packet).dict(),
            result_id=result_id,
            component_id=packet.component_id,
            source_action_id=packet.source_action_id,
            source_idempotency_key=packet.source_idempotency_key,
            source_activity_identity=source.activity_identity,
            synthesis_id=packet.synthesis.synthesis_id,
            synthesis_activity_id=packet.synthesis.synthesis_activity_id,
            synthesis_provider_id=packet.synthesis.provider_id,
            synthesis_model_id=packet.synthesis.model_id,
            projection_revision=next_revision,
            evidence_revision=packet.projection.evidence_revision,
            lifecycle_stage=lifecycle_stage,
            disposition=disposition,
            summary=packet.synthesis.summary,
            claims=public_claims,
            evidence=evidence,
            critic=critic,
            truth_label=truth_label,
            version_bundle=VersionBundle(),
            degraded_code=degraded_code,
            recorded_at=datetime.now(timezone.utc),
        )
        recorded_conversation_items = {
            item.item_id: item for item in packet.projection.conversation_items
        }
        conversation_reader = getattr(self.repository, "workspace_conversation_items", None)
        if conversation_reader is not None:
            for item in await conversation_reader(packet.tenant_id, packet.case_id):
                recorded_conversation_items.setdefault(item.item_id, item)
        projection = IncidentProjection.parse_obj({
            **packet.projection.dict(),
            "projection_revision": next_revision,
            "sequence": packet.projection.sequence + 1,
            "action_revision": packet.projection.action_revision + 1,
            "lifecycle_stage": lifecycle_stage,
            "lifecycle_state": lifecycle_state,
            "status": status,
            "investigation_result": result,
            "conversation_items": [
                item.dict() for item in sorted(
                    recorded_conversation_items.values(),
                    key=lambda item: (item.sequence, item.item_id),
                )
            ],
            "degraded_code": degraded_code,
            "generated_at": result.recorded_at,
        })
        event_payload = {
            "result_id": result.result_id,
            "component_id": result.component_id,
            "lifecycle_stage": result.lifecycle_stage.value,
            "disposition": result.disposition.value,
            "conversation_item_ids": ",".join(
                item.item_id for item in projection.conversation_items
            ),
        }
        if result.critic is not None:
            event_payload["critic_operator_status"] = result.critic.operator_status.value
        event = IncidentEvent(
            **self._binding(packet).dict(),
            projection_revision=projection.projection_revision,
            sequence=packet.event_sequence,
            event_type=(
                "workspace.investigation.accepted"
                if accepted else "workspace.investigation.degraded"
            ),
            occurred_at=result.recorded_at,
            payload=event_payload,
            evidence_refs=list(projection.evidence_refs),
        )
        commit = WorkspaceInvestigationCommit(
            transition_key=packet.transition_key,
            source_projection=packet.projection,
            projection=projection,
            result_id=result.result_id,
            domain_claims=domain_claims,
            event=event,
            actions=[],
        )
        stored = await self.repository.commit_workspace_investigation_transition(commit)
        return WorkspaceInvestigationOutcome(
            projection=stored.projection,
            result=stored.projection.investigation_result,
            actions=stored.actions,
        ).dict()

    @staticmethod
    def _permissions(actor) -> list:
        return workspace_permissions_for_roles(actor.roles)

    def _action_event(
        self, packet: WorkspaceActionPacket, projection, action: str,
        command_fingerprint: str, activity_identity: str,
    ) -> IncidentEvent:
        return IncidentEvent(
            **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
            projection_revision=projection.projection_revision, sequence=packet.event_sequence,
            event_type=action, occurred_at=datetime.now(timezone.utc),
            payload={
                "action_id": packet.command.action_id,
                "idempotency_key": packet.command.idempotency_key,
                "command_fingerprint": command_fingerprint,
                "activity_identity": activity_identity,
            },
            evidence_refs=list(projection.evidence_refs),
        )

    async def _consumed_gate1_lease(
        self, lease_id: str, invocation_context: CapabilityInvocationContext, command_fingerprint: str,
        action, receipt: WorkspaceActionReceipt, capability_audit,
    ) -> Gate1Lease:
        """Prepare, but do not persist, the exact consumed lease revision.

        The repository rechecks this against the locked active revision and
        writes it only with the admitted source result/audit/action outbox.
        """
        active = await self.repository.workspace_gate1_lease(
            invocation_context.tenant_id, invocation_context.case_id, lease_id,
        )
        if active is None or active.status != Gate1LeaseStatus.ACTIVE:
            raise PolicyViolation("gate1_lease_not_active")
        evidence_set_hash = canonical_evidence_set_hash(list(invocation_context.recorded_evidence_ids))
        if active.evidence_set_hash != evidence_set_hash:
            raise PolicyViolation("gate1_lease_evidence_set_mismatch")
        return active.copy(update={
            "lease_revision": active.lease_revision + 1,
            "status": Gate1LeaseStatus.CONSUMED,
            "consumed_by_activity_id": invocation_context.activity_id,
            "consumed_command_fingerprint": command_fingerprint,
            "consumed_action_id": action.action_id,
            "consumed_card_version": action.card_version,
            "consumed_idempotency_key": receipt.idempotency_key,
            "consumed_request_hash": capability_audit.request_hash,
            "consumed_result_hash": capability_audit.result_hash,
            "consumed_audit_id": capability_audit.audit_id,
            "consumed_evidence_set_hash": evidence_set_hash,
            "consumed_evidence_revision": invocation_context.evidence_revision,
        })

    async def _persist_case(self, packet: WorkspaceActivityPacket) -> None:
        if not hasattr(self.repository, "put_case"):
            return
        now = datetime.now(timezone.utc)
        case = IncidentCase(
            case_id=packet.case_id, tenant_id=packet.tenant_id, case_revision=packet.case_revision,
            workflow_id=packet.workflow_id, workflow_run_id=packet.workflow_run_id,
            state=CaseState.NEEDS_HUMAN, severity=packet.projection.status,
            environment="workspace", affected_entities=[node.component_id for node in packet.projection.graph.nodes] or ["workspace"],
            created_at=packet.created_at, updated_at=now, blocker_code="provider_unavailable",
            human_question="No provider or read capability is configured for this workspace checkpoint.",
        )
        result = self.repository.put_case(case)
        if hasattr(result, "__await__"):
            await result
    async def _grant_initializer_subject(self, packet: WorkspaceActivityPacket) -> None:
        if packet.actor is None:
            # Frozen v1/replay-only histories did not carry a trusted actor.
            # Current live workflows always include one at initialization.
            return
        grant = getattr(self.repository, "grant_workspace_subject", None)
        if grant is None:
            raise RuntimeError("workspace_subject_grant_repository_required")
        binding = IncidentRunBinding.parse_obj({
            name: getattr(packet, name) for name in IncidentRunBinding.__fields__
        })
        result = grant(
            binding, packet.actor.subject_id, packet.actor.roles,
            self._permissions(packet.actor),
        )
        if hasattr(result, "__await__"):
            await result

    async def _append_event(
        self, packet: WorkspaceActivityPacket, event_type: str, payload: Dict[str, str],
        *, sequence: int = None, explanation_status: ExplanationEventStatus = None,
    ) -> None:
        event = IncidentEvent(
            **{name: getattr(packet, name) for name in packet.__fields__ if name in {
                "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
                "workflow_id", "workflow_run_id", "created_at",
            }},
            projection_revision=packet.projection.projection_revision,
            sequence=sequence if sequence is not None else packet.event_sequence, event_type=event_type,
            occurred_at=datetime.now(timezone.utc), payload=payload,
            evidence_refs=list(packet.projection.evidence_refs),
            explanation_status=explanation_status,
        )
        await self.repository.append_workspace_event(event)

    async def dispatch(self, activity_name: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        if activity_name == "workspace_register_execution_v3_activity":
            packet = WorkspaceExecutionRegistrationV3.parse_obj(packet_data)
            if packet.prior is None:
                pointer = await self.repository.put_incident_execution_v3(
                    packet.identity, packet.current,
                )
            else:
                pointer = await self.repository.rollover_temporal_execution_v3(
                    TemporalExecutionRolloverV3(
                        identity=packet.identity,
                        expected=packet.prior,
                        replacement=packet.current,
                    ),
                )
            return pointer.dict()
        if activity_name == "workspace_authorize_node_explanation_activity":
            packet = WorkspaceNodeExplanationAuthorizationPacket.parse_obj(packet_data)
            if self.authorization is None:
                raise RuntimeError("workspace_authorization_port_unconfigured")
            binding = IncidentRunBinding.parse_obj({
                name: getattr(packet, name) for name in IncidentRunBinding.__fields__
            })
            actor = self.authorization.resolve_workspace_node_explanation(
                packet.authorization, binding, packet.command,
            )
            if hasattr(actor, "__await__"):
                actor = await actor
            if actor.tenant_id != binding.tenant_id:
                raise RuntimeError("workspace_authorization_actor_tenant_mismatch")
            return WorkspaceNodeExplanationAuthorizationOutcome(actor=actor).dict()
        if activity_name == "workspace_authorize_action_activity":
            packet = WorkspaceActionAuthorizationPacket.parse_obj(packet_data)
            if self.authorization is None:
                raise RuntimeError("workspace_authorization_port_unconfigured")
            binding = IncidentRunBinding.parse_obj({
                name: getattr(packet, name) for name in IncidentRunBinding.__fields__
            })
            actor = self.authorization.resolve_workspace_action(packet.authorization, binding, packet.command)
            if hasattr(actor, "__await__"):
                actor = await actor
            if actor.tenant_id != binding.tenant_id:
                raise RuntimeError("workspace_action_authorization_actor_tenant_mismatch")
            return WorkspaceActionAuthorizationOutcome(
                actor_tenant_id=actor.tenant_id, actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            ).dict()
        if activity_name == "workspace_generate_actions_activity":
            packet = WorkspaceActionGenerationPacket.parse_obj(packet_data)
            if self.capability_registry is None:
                return WorkspaceActionGenerationOutcome().dict()
            actions = NextBestActionGenerator(
                self.capability_registry, registry_revision=self.capability_registry.policy_version,
            ).generate(packet.projection, datetime.now(timezone.utc))
            for action in actions:
                await self.repository.append_next_best_action(action)
            return WorkspaceActionGenerationOutcome(actions=actions).dict()
        if activity_name == "workspace_synthesize_investigation_activity":
            return await self._synthesize_investigation(packet_data)
        if activity_name == "workspace_critic_investigation_activity":
            return await self._critic_investigation(packet_data)
        if activity_name in {
            "workspace_accept_investigation_activity",
            "workspace_record_investigation_degraded_activity",
        }:
            return await self._finalize_investigation(activity_name, packet_data)
        if activity_name == "workspace_execute_action_activity":
            packet = WorkspaceActionPacket.parse_obj(packet_data)
            command_fingerprint = packet.command.canonical_hash()
            activity_identity = packet.activity_identity or "workspace-action:{}:{}".format(
                packet.workflow_run_id, command_fingerprint,
            )
            prior = await self.repository.workspace_action_commit(
                packet.tenant_id, packet.case_id, packet.command.idempotency_key,
            )
            if prior is not None:
                if (
                    prior.command_fingerprint != command_fingerprint
                    or prior.receipt.action_id != packet.command.action_id
                    or prior.activity_identity != activity_identity
                ):
                    raise PolicyViolation("workspace_action_idempotency_conflict")
                return WorkspaceActionOutcome(
                    receipt=prior.receipt, projection=prior.projection, actions=prior.actions,
                ).dict()
            action = await self.repository.workspace_next_best_action(
                packet.tenant_id, packet.case_id, packet.command.action_id,
            )
            if action is None:
                raise PolicyViolation("workspace_action_not_found")
            from .models import AuthContext
            actor = AuthContext(
                tenant_id=packet.actor_tenant_id, subject_id=packet.actor_subject_id, roles=packet.actor_roles,
            )
            if actor.tenant_id != packet.tenant_id:
                raise PolicyViolation("workspace_action_actor_tenant_mismatch")
            # This activity only receives the actor after the workflow's
            # trusted authorization activity.  Persist that grant before
            # building a Gate 1 transition so both repository boundaries can
            # independently derive the lease from durable authority rather
            # than trusting the action packet.
            await self.repository.grant_workspace_subject(
                IncidentRunBinding.parse_obj({
                    name: getattr(packet, name) for name in IncidentRunBinding.__fields__
                }),
                actor.subject_id,
                actor.roles,
                self._permissions(actor),
            )
            validate_current_action_card(
                action, packet.projection, packet.command, self._permissions(actor), datetime.now(timezone.utc),
            )
            if self.capability_registry is None:
                raise PolicyViolation("workspace_action_capability_registry_unconfigured")
            if action.capability_registry_revision != self.capability_registry.policy_version:
                raise PolicyViolation("workspace_action_registry_revision_stale")
            descriptor = next((item for item in self.capability_registry.available(CapabilityAudience.USER_QA)
                               if item.capability.value == action.capability), None)
            if (
                descriptor is None or not descriptor.fresh_read or descriptor.required_gate.value != "GATE1"
                or descriptor.input_schema != action.tool_schema_version
                or action.data_class not in {item.value for item in descriptor.data_classes}
            ):
                raise PolicyViolation("workspace_action_capability_not_bound")
            now = datetime.now(timezone.utc)
            if action.cta.value == "run_read_capability":
                if action.gate1_lease_id is None:
                    raise PolicyViolation("workspace_action_gate1_lease_required")
                invocation_context = CapabilityInvocationContext(
                    **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                    projection_revision=packet.projection.projection_revision,
                    evidence_revision=packet.projection.evidence_revision,
                    component_ids=[action.component_id],
                    activity_id="workspace-gate1:{}:{}:{}".format(
                        packet.workflow_run_id, action.action_id, packet.command.idempotency_key,
                    ),
                    scope=CapabilityScope.USER_QA, subject_id=actor.subject_id,
                    subject_roles=actor.roles, subject_permissions=self._permissions(actor),
                    authorized_subjects=[actor.subject_id],
                    data_class=CapabilityDataClass(action.data_class),
                    recorded_evidence_ids=list(packet.projection.evidence_refs), max_tool_calls=1,
                    capability_registry_revision=action.capability_registry_revision,
                    precondition_version=action.precondition_version, precondition_hash=action.precondition_hash,
                    gate1_lease_id=action.gate1_lease_id,
                    action_command_fingerprint=command_fingerprint,
                )
                # The registry validates and obtains the controlled source,
                # but it must not durably admit evidence, write the audit, or
                # consume the lease yet.  Those records join the consumed
                # lease in the one action transition transaction below.
                invocation = await self.capability_registry.invoke(
                    CapabilityAudience.USER_QA, invocation_context,
                    CapabilityRequest(
                        capability=descriptor.capability, component_id=action.component_id,
                        data_class=CapabilityDataClass(action.data_class), parameters={},
                    ),
                    ToolCallBudget(max_calls=1),
                    defer_durable_persistence=True,
                )
                evidence_refs = list(packet.projection.evidence_refs)
                for evidence in invocation.result.evidence:
                    if evidence.evidence_id not in evidence_refs:
                        evidence_refs.append(evidence.evidence_id)
                updated_projection = packet.projection.copy(update={
                    "projection_revision": packet.projection.projection_revision + 1,
                    "sequence": packet.event_sequence,
                    "evidence_revision": packet.projection.evidence_revision + 1,
                    "action_revision": packet.projection.action_revision + 1,
                    "gate1_state": Gate1ProjectionState.CONSUMED,
                    "evidence_refs": evidence_refs, "generated_at": now,
                })
                receipt = WorkspaceActionReceipt(
                    **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                    action_id=action.action_id, idempotency_key=packet.command.idempotency_key,
                    status="FRESH_READ_COMPLETED", gate1_lease_id=action.gate1_lease_id,
                    reason="temporal_gate1_bound_read_completed",
                )
                consumed_lease = await self._consumed_gate1_lease(
                    action.gate1_lease_id, invocation_context, command_fingerprint,
                    action, receipt, invocation.audit,
                )
                commit = await self.repository.commit_workspace_action_transition(WorkspaceActionCommit(
                    activity_identity=activity_identity, command_fingerprint=command_fingerprint,
                    projection=updated_projection, receipt=receipt,
                    lease=consumed_lease, capability_result=invocation.result,
                    capability_audit=invocation.audit,
                    event=self._action_event(
                        packet, updated_projection, "workspace.action.fresh_read_completed",
                        command_fingerprint, activity_identity,
                    ),
                ))
                return WorkspaceActionOutcome(receipt=commit.receipt, projection=commit.projection).dict()
            if action.cta.value != "request_gate_1":
                raise PolicyViolation("workspace_action_cta_not_enabled_p0")
            updated_projection = packet.projection.copy(update={
                "projection_revision": packet.projection.projection_revision + 1,
                "sequence": packet.event_sequence,
                "gate_revision": packet.projection.gate_revision + 1,
                "action_revision": packet.projection.action_revision + 1,
                "gate1_state": Gate1ProjectionState.ACTIVE,
                "generated_at": now,
            })
            lease_id = "gate1-" + command_fingerprint
            lease = Gate1Lease(
                **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                lease_id=lease_id, lease_revision=1, subject_id=actor.subject_id,
                required_permission=action.required_permission, component_id=action.component_id,
                capability=action.capability, data_class=action.data_class,
                capability_version=action.capability_version,
                tool_schema_version=action.tool_schema_version,
                projection_revision=updated_projection.projection_revision,
                evidence_revision=updated_projection.evidence_revision,
                capability_registry_revision=action.capability_registry_revision,
                precondition_version=action.precondition_version, precondition_hash=NextBestActionGenerator._precondition_hash(updated_projection),
                issuance_command_fingerprint=command_fingerprint,
                issuance_action_id=action.action_id,
                issuance_card_version=action.card_version,
                issuance_idempotency_key=packet.command.idempotency_key,
                evidence_set_hash=canonical_evidence_set_hash(list(updated_projection.evidence_refs)),
                issued_at=now, expires_at=now + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
            )
            next_actions = NextBestActionGenerator(
                self.capability_registry, registry_revision=self.capability_registry.policy_version,
            ).generate_after_gate1(updated_projection, lease, now)
            receipt = WorkspaceActionReceipt(
                **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                action_id=action.action_id, idempotency_key=packet.command.idempotency_key,
                status="GATE1_GRANTED", gate1_lease_id=lease.lease_id,
                reason="temporal_gate1_lease_accepted",
            )
            commit = await self.repository.commit_workspace_action_transition(WorkspaceActionCommit(
                activity_identity=activity_identity, command_fingerprint=command_fingerprint,
                projection=updated_projection, receipt=receipt, lease=lease, actions=next_actions,
                issued_action=action,
                event=self._action_event(
                    packet, updated_projection, "workspace.action.gate1_granted",
                    command_fingerprint, activity_identity,
                ),
            ))
            return WorkspaceActionOutcome(
                receipt=commit.receipt, projection=commit.projection, actions=commit.actions,
            ).dict()
        packet = WorkspaceActivityPacket.parse_obj(packet_data)
        expected = packet.stage + "_activity"
        if activity_name != expected:
            raise RuntimeError("workspace_activity_stage_mismatch")
        if packet.stage == "workspace_initialize":
            intake_packet = packet
            event_payload = {"state": packet.projection.status}
            if self.topology_provider is not None:
                projection = self.topology_provider.snapshot(packet.projection)
                packet = WorkspaceActivityPacket.parse_obj({
                    **packet.dict(),
                    "projection": projection.dict(),
                })
                event_payload = self.topology_provider.initialized_event_payload(projection)
            # The full topology is context, not a claim that every service was
            # affected. Preserve the intake's bounded affected-entity record.
            await self._persist_case(intake_packet)
            await self.repository.put_workspace_binding(IncidentRunBinding.parse_obj({
                name: getattr(packet, name) for name in IncidentRunBinding.__fields__
            }))
            await self._grant_initializer_subject(packet)
            await self.repository.put_workspace_projection(packet.projection)
            await self._append_event(packet, "workspace.initialized", event_payload)
            return WorkspaceActivityOutcome(projection=packet.projection).dict()
        if packet.stage == "workspace_node_explanation":
            command = packet.node_explanation
            if command is None:
                raise RuntimeError("workspace_node_explanation_command_required")
            known = {node.component_id for node in packet.projection.graph.nodes}
            if command.component_id not in known:
                raise RuntimeError("workspace_node_explanation_component_not_canonical")
            if packet.actor is None or packet.actor.tenant_id != packet.tenant_id:
                raise RuntimeError("workspace_node_explanation_actor_not_authorized")
            selection_key = command.selection_key(packet.tenant_id)
            await self._append_event(
                packet, "node_explanation.started",
                {"component_id": command.component_id, "selection_key": selection_key},
                explanation_status=ExplanationEventStatus.STARTED,
            )
            conversation = None
            if self.conversation_manager is not None:
                binding = IncidentRunBinding.parse_obj({
                    name: getattr(packet, name) for name in IncidentRunBinding.__fields__
                })
                conversation = await self.conversation_manager.explain(
                    binding, packet.projection, command, actor=packet.actor,
                )
            explanation_id = "node-explanation-{}".format(
                sha256(selection_key.encode("utf-8")).hexdigest()[:24],
            )
            explanation_state = (
                NodeExplanationState.COMPLETED
                if conversation is not None and conversation.truth_label.value != "DEGRADED"
                else NodeExplanationState.DEGRADED
            )
            summary = (
                conversation.summary if conversation is not None
                else "No provider or read capability is configured; no fresh read or diagnosis was performed."
            )
            evidence_refs = (
                conversation.evidence_refs if conversation is not None else list(packet.projection.evidence_refs)
            )
            conversation_item = ConversationItem(
                item_id="conversation-item-{}".format(
                    sha256((explanation_id + ":1").encode("utf-8")).hexdigest()[:24],
                ),
                sequence=packet.event_sequence + 1,
                **{
                    name: getattr(packet, name)
                    for name in (
                        "tenant_id", "incident_id", "run_id", "topology_revision", "case_id",
                        "case_revision", "workflow_id", "workflow_run_id",
                    )
                },
                projection_revision=command.projection_revision,
                component_id=command.component_id,
                explanation_id=explanation_id,
                knowledge_state=(
                    ConversationKnowledgeState.KNOWN
                    if explanation_state == NodeExplanationState.COMPLETED
                    else ConversationKnowledgeState.UNKNOWN
                ),
                summary=summary,
                evidence_refs=evidence_refs,
                created_at=datetime.now(timezone.utc),
            )
            explanation = NodeExplanation(
                **{name: getattr(packet, name) for name in packet.__fields__ if name in {
                    "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
                    "workflow_id", "workflow_run_id", "created_at",
                }},
                explanation_id=explanation_id,
                selection_key=selection_key, projection_revision=command.projection_revision,
                component_id=command.component_id, conversation_schema_version=command.conversation_schema_version,
                state=explanation_state,
                summary=summary,
                evidence_refs=evidence_refs,
                conversation_items=[conversation_item],
                fresh_read_performed=False, fresh_diagnosis_claimed=False,
                truth_label=(conversation.truth_label if conversation is not None else "DEGRADED"),
                conversation_trace=(conversation.trace if conversation is not None else None),
                degraded_code=(conversation.degraded_code if conversation is not None else "provider_unavailable"),
            )
            stored, _ = await self.repository.start_or_reuse_workspace_explanation(explanation)
            await self._append_event(
                packet,
                "node_explanation.completed" if stored.state == NodeExplanationState.COMPLETED else "node_explanation.degraded",
                {
                    "explanation_id": stored.explanation_id,
                    "truth_label": stored.truth_label.value,
                    "conversation_item_ids": ",".join(
                        item.item_id for item in stored.conversation_items
                    ),
                },
                sequence=packet.event_sequence + 1,
                explanation_status=(
                    ExplanationEventStatus.COMPLETED
                    if stored.state == NodeExplanationState.COMPLETED
                    else ExplanationEventStatus.DEGRADED
                ),
            )
            return WorkspaceActivityOutcome(explanation=stored).dict()
        raise RuntimeError("workspace_activity_unknown")

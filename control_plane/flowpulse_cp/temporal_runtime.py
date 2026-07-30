"""Temporal starter, real domain activities, and production worker wiring."""

import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, List, Optional
from uuid import uuid4

import boto3
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from .activities import ControlActivityDispatcher, build_temporal_activities
from .authorization import AuthorizationPort, HttpAuthorizationClient
from .evidence_acquisition import CurrentEvidenceAcquisitionPort, S3CurrentEvidenceAcquirer
from .integrity import (
    DeterministicCritic,
    EvidenceGateway,
    EvidenceReadbackPort,
    IndependentEvidenceVerifier,
    REQUIRED_COVERAGE,
)
from .legacy_temporal_workflow import LegacyDiagnosisTemporalWorkflow
from .models import (
    ActivityOutcome,
    AuthContext,
    CaseState,
    ClaimRecord,
    CoverageEntry,
    CoverageStatus,
    EvidenceAuthority,
    EvidenceAcquisitionResult,
    EvidenceEnvelope,
    FreshnessStatus,
    IncidentCase,
    IncidentIntake,
    InvestigatorAssignment,
    ProofScope,
    SourceKind,
    TemporalActivityPacket,
    TemporalCaseDescriptor,
    TemporalCaseRequest,
    OwnerCommandReceipt,
    OwnerGateCommand,
    VerificationDecision,
)
from .object_store import S3ObjectStore
from .policy import PolicyViolation, validate_owner_gate
from .postgres import PostgresCaseRepository
from .repository import InMemoryCaseRepository
from .source_readback import LocalDeterministicSourceReadback, S3SourceReadback
from .temporal_workflow import DiagnosisTemporalWorkflow
from .workspace_activities import WorkspaceActivityDispatcher, build_workspace_activities
from .capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityInvocationContext,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityScope,
    ToolCallBudget,
)
from .capability_adapters import (
    CurrentEvidenceCapabilityAdapter,
    DomainEvidenceAdmission,
    Gate1CurrentEvidenceCapabilityAdapter,
    RecordedContextCapabilityAdapter,
    production_current_evidence_adapters,
)
from .postgres import PostgresCapabilityScopeAuthority
from .conversation_manager import ConversationManager
from .provider_gateway import (
    DeterministicConversationProvider,
    ProviderMode,
    ProviderSettings,
    build_conversation_provider,
    build_investigation_providers,
)
from .workspace_investigation import (
    DeterministicInvestigationCritic,
    DeterministicInvestigationSynthesizer,
)
from .workspace_models import (
    ConversationRole,
    IncidentProjection,
    NodeExplanationReceipt,
    NodeExplanationStart,
    WorkspaceNodeExplanationInvocation,
    WorkspaceIntake,
    WorkspaceWorkflowRequest,
    initial_topology_revision,
)
from .workspace_actions import (
    ActionInvocationCommand,
    Gate1LeaseAuthority,
    WorkspaceActionInvocation,
    WorkspaceActionReceipt,
)
from .workspace_workflow import IncidentWorkspaceTemporalWorkflow
from .workspace_registration import workspace_workflow_definitions
from .realtime_models import RealtimeUpdateCommand, RealtimeUpdateOutcome
from .realtime_activities import RealtimeActivityDispatcher, build_realtime_activities
from .realtime_adapters import (
    BoundedJsonReader,
    ConfiguredPrometheusConnector,
    ConnectorEndpointPolicy,
    UnavailableOtelAdapter,
)
from .realtime_models import (
    ConfiguredBindingTemplate,
    ConnectorProvider,
    ConnectorRegistration,
    ConnectorTruthLabel,
)
from .realtime_scheduler import RealtimeIngestScheduler
from .realtime_observability import realtime_telemetry


class TemporalStarter:
    def __init__(self, address: str, task_queue: str, local_deterministic_evidence: bool = False) -> None:
        self.address = address
        self.task_queue = task_queue
        self.local_deterministic_evidence = local_deterministic_evidence

    def _local_records(self, case: IncidentCase, actor: AuthContext):
        """Compose-only deterministic fixture; production supplies real adapters."""
        now = case.created_at
        content = "local-current-observation:{}:{}".format(case.case_id, case.case_revision)
        evidence = EvidenceEnvelope(
            evidence_id="evidence-{}".format(case.case_id), case_id=case.case_id,
            case_revision=case.case_revision, tenant_id=case.tenant_id, acl_subjects=[actor.subject_id],
            source_kind=SourceKind.SOURCE_READBACK, source_uri="local://current/{}".format(case.case_id),
            source_anchor="deterministic:1", observed_at=now, effective_at=now, source_version="local-v1",
            content_hash=sha256(content.encode("utf-8")).hexdigest(), authority=EvidenceAuthority.T0,
            freshness=FreshnessStatus.CURRENT, independence_key="local-source:{}".format(case.case_id),
            schema_binding="local.current.v1", proof_scope=ProofScope.CURRENT_OBSERVATION,
        )
        claim = ClaimRecord(
            claim_id="claim-{}".format(case.case_id), case_id=case.case_id, case_revision=case.case_revision,
            tenant_id=case.tenant_id, claim_type="suspected_root_cause", statement="Local deterministic current observation.",
            evidence_ids=[evidence.evidence_id], created_by="primary:p0:deterministic-fake",
        )
        coverage = [
            CoverageEntry(case_id=case.case_id, tenant_id=case.tenant_id, field=field, status=CoverageStatus.FILLED)
            for field in sorted(REQUIRED_COVERAGE)
        ]
        return [evidence], [claim], coverage

    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        now = datetime.now(timezone.utc)
        workflow_id = "flowpulse.diagnosis:{}:{}".format(actor.tenant_id, intake.external_incident_id)
        public_seed = "{}:{}".format(actor.tenant_id, intake.external_incident_id)
        public_run_id = "diagnosis-run-{}".format(sha256(public_seed.encode("utf-8")).hexdigest()[:24])
        public_topology_revision = "diagnosis-topology-v1-{}".format(
            sha256((public_seed + ":topology").encode("utf-8")).hexdigest()[:24]
        )
        case = IncidentCase(
            case_id="case-{}-{}".format(actor.tenant_id, intake.external_incident_id), tenant_id=actor.tenant_id,
            workflow_id=workflow_id, workflow_run_id="pending", severity=intake.severity,
            environment=intake.environment, affected_entities=intake.affected_entities, created_at=now, updated_at=now,
            public_incident_id=intake.external_incident_id, public_run_id=public_run_id,
            public_topology_revision=public_topology_revision,
        )
        evidence, claims, coverage = ([], [], [])
        if self.local_deterministic_evidence:
            evidence, claims, coverage = self._local_records(case, actor)
        client = await Client.connect(self.address)
        handle = await client.start_workflow(
            DiagnosisTemporalWorkflow.run,
            TemporalCaseRequest(
                case=TemporalCaseDescriptor(
                    case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
                    workflow_id=case.workflow_id, workflow_run_id="pending", severity=case.severity, environment=case.environment,
                    affected_entities=case.affected_entities, public_incident_id=case.public_incident_id,
                    public_run_id=case.public_run_id, public_topology_revision=case.public_topology_revision,
                    capability_scope_created_at=case.created_at,
                ),
                actor=actor, evidence=evidence, claims=claims, coverage=coverage,
            ).dict(),
            id=workflow_id, task_queue=self.task_queue,
        )
        return case.copy(update={"workflow_run_id": handle.result_run_id})

    async def submit_owner_command(
        self, case: IncidentCase, command: OwnerGateCommand,
    ) -> OwnerCommandReceipt:
        if case.workflow_run_id == "pending":
            raise RuntimeError("temporal_workflow_run_not_started")
        client = await Client.connect(self.address)
        handle = client.get_workflow_handle(case.workflow_id, run_id=case.workflow_run_id)
        response = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command.dict())
        receipt = OwnerCommandReceipt.parse_obj(response)
        if not receipt.accepted:
            raise PolicyViolation(receipt.phase.removeprefix("rejected:"))
        return receipt


class WorkspaceTemporalStarter:
    """Temporal start/update port for the additive Incident Workspace.

    The public ``run_id`` is generated independently of Temporal's workflow and
    run IDs.  The only initial response is a typed degraded projection; the
    worker's activity persists the authoritative projection and mapping.
    """

    def __init__(self, address: str, task_queue: str) -> None:
        self.address = address
        self.task_queue = task_queue

    async def start_workspace(self, intake: WorkspaceIntake, actor: AuthContext) -> IncidentProjection:
        now = datetime.now(timezone.utc)
        run_id = "run-{}".format(uuid4().hex)
        case_id = "workspace-case-{}".format(uuid4().hex)
        workflow_id = "flowpulse.incident-workspace:{}:{}".format(actor.tenant_id, run_id)
        topology_revision = initial_topology_revision(
            actor.tenant_id, intake.incident_id, run_id, intake.affected_entities,
        )
        request = WorkspaceWorkflowRequest(
            tenant_id=actor.tenant_id, incident_id=intake.incident_id, run_id=run_id,
            topology_revision=topology_revision, case_id=case_id, case_revision=1,
            workflow_id=workflow_id, workflow_run_id="pending", created_at=now, actor=actor,
            title=intake.title, severity=intake.severity, environment=intake.environment,
            affected_entities=intake.affected_entities, summary=intake.summary,
        )
        client = await Client.connect(self.address)
        handle = await client.start_workflow(
            IncidentWorkspaceTemporalWorkflow.run, request.dict(), id=workflow_id, task_queue=self.task_queue,
        )
        # An HTTP success is not a speculative browser fixture: this update is
        # accepted only after the initializer activity has persisted the
        # Temporal-derived projection and its public/internal binding.
        response = await handle.execute_update(IncidentWorkspaceTemporalWorkflow.await_workspace_projection)
        projection = IncidentProjection.parse_obj(response)
        if projection.workflow_run_id != handle.result_run_id:
            raise RuntimeError("workspace_temporal_run_correlation_mismatch")
        return projection

    async def reconcile_realtime_connector(
        self, projection: IncidentProjection, connector_id: str, idempotency_key: str,
        actor_subject_id: str, source_event_id: str, dispatch_id: str,
    ) -> RealtimeUpdateOutcome:
        client = await Client.connect(self.address)
        handle = client.get_workflow_handle(
            projection.workflow_id, run_id=projection.workflow_run_id,
        )
        response = await handle.execute_update(
            IncidentWorkspaceTemporalWorkflow.reconcile_realtime_connector,
            RealtimeUpdateCommand(
                tenant_id=projection.tenant_id,
                actor_subject_id=actor_subject_id,
                case_id=projection.case_id,
                incident_id=projection.incident_id,
                run_id=projection.run_id,
                topology_revision=projection.topology_revision,
                connector_id=connector_id,
                source_event_id=source_event_id,
                dispatch_id=dispatch_id,
                idempotency_key=idempotency_key,
            ).dict(),
        )
        return RealtimeUpdateOutcome.parse_obj(response)

    async def start_or_reuse_node_explanation(
        self, projection: IncidentProjection, command: NodeExplanationStart, authorization,
    ) -> NodeExplanationReceipt:
        client = await Client.connect(self.address)
        handle = client.get_workflow_handle(projection.workflow_id, run_id=projection.workflow_run_id)
        response = await handle.execute_update(
            IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation,
            WorkspaceNodeExplanationInvocation(command=command, authorization=authorization).dict(),
        )
        if not response.get("accepted", True):
            raise RuntimeError(response.get("reason", "workspace_node_explanation_rejected"))
        return NodeExplanationReceipt.parse_obj(response)

    async def invoke_next_best_action(
        self, projection: IncidentProjection, command: ActionInvocationCommand, authorization,
    ) -> WorkspaceActionReceipt:
        client = await Client.connect(self.address)
        handle = client.get_workflow_handle(projection.workflow_id, run_id=projection.workflow_run_id)
        response = await handle.execute_update(
            IncidentWorkspaceTemporalWorkflow.invoke_next_best_action,
            WorkspaceActionInvocation(command=command, authorization=authorization).dict(),
        )
        if not response.get("accepted", True):
            raise PolicyViolation(response.get("reason", "workspace_action_rejected"))
        return WorkspaceActionReceipt.parse_obj(response)


class DomainActivityEngine:
    """Runs the same deterministic domain gates used by tests inside activities."""

    def __init__(
        self, source_readback: EvidenceReadbackPort, authorization: AuthorizationPort,
        evidence_acquirer: Optional[CurrentEvidenceAcquisitionPort] = None,
        capability_registry: Optional[CapabilityRegistry] = None,
    ) -> None:
        self.source_readback = source_readback
        self.authorization = authorization
        self.evidence_acquirer = evidence_acquirer
        self.capability_registry = capability_registry

    def _case(self, packet: TemporalActivityPacket) -> IncidentCase:
        now = datetime.now(timezone.utc)
        return IncidentCase(
            case_id=packet.case_id, tenant_id=packet.tenant_id, case_revision=packet.case_revision,
            workflow_id=packet.workflow_id, workflow_run_id=packet.workflow_run_id,
            public_incident_id=packet.public_incident_id, public_run_id=packet.public_run_id,
            public_topology_revision=packet.public_topology_revision,
            severity=packet.severity, environment=packet.environment, affected_entities=packet.affected_entities,
            created_at=now, updated_at=now,
        )

    def _repository(self, packet: TemporalActivityPacket) -> InMemoryCaseRepository:
        now = datetime.now(timezone.utc)
        repository = InMemoryCaseRepository()
        repository.put_case(self._case(packet))
        gateway = EvidenceGateway(repository, packet.actor_subject_id)
        for item in packet.evidence:
            gateway.admit(item)
        for claim in packet.claims:
            gateway.admit_claim(claim)
        for entry in packet.coverage:
            repository.put_coverage(entry)
        return repository

    def _autonomous_capability_context(self, packet: TemporalActivityPacket) -> CapabilityInvocationContext:
        if not all((packet.public_incident_id, packet.public_run_id, packet.public_topology_revision,
                    packet.capability_scope_created_at)):
            raise PolicyViolation("capability_scope_public_identity_missing")
        return CapabilityInvocationContext(
            tenant_id=packet.tenant_id, incident_id=packet.public_incident_id, run_id=packet.public_run_id,
            topology_revision=packet.public_topology_revision, case_id=packet.case_id,
            case_revision=packet.case_revision, workflow_id=packet.workflow_id,
            workflow_run_id=packet.workflow_run_id, created_at=packet.capability_scope_created_at,
            projection_revision=packet.case_revision, evidence_revision=packet.case_revision,
            component_ids=packet.affected_entities, activity_id="{}:{}:{}".format(
                packet.workflow_run_id, packet.stage, packet.sequence,
            ),
            scope=CapabilityScope.AUTONOMOUS_DIAGNOSIS, subject_id=packet.actor_subject_id,
            subject_roles=packet.actor_roles, authorized_subjects=[packet.actor_subject_id],
            data_class=CapabilityDataClass.CURRENT_INCIDENT, recorded_evidence_ids=[],
            gate1_authorized=False, system_authorized=True,
        )

    async def execute_async(
        self, packet: TemporalActivityPacket, evidence_admission: Optional[DomainEvidenceAdmission] = None,
    ) -> ActivityOutcome:
        """Production acquisition runs through the one shared registry/audit seam."""
        if packet.stage != "acquire_current_evidence":
            return self.execute(packet)
        if self.capability_registry is None:
            return ActivityOutcome(
                decision=VerificationDecision.FAIL, state=CaseState.NEEDS_HUMAN,
                identity="acquire_current_evidence:p0:domain",
                reason_codes=["capability_registry_unconfigured"],
            )
        if self.evidence_acquirer is None:
            return ActivityOutcome(
                decision=VerificationDecision.FAIL, state=CaseState.NEEDS_HUMAN,
                identity="acquire_current_evidence:p0:domain",
                reason_codes=["controlled_current_evidence_port_unconfigured"],
            )
        try:
            invocation_context = self._autonomous_capability_context(packet)
            invocation = await self.capability_registry.invoke(
                CapabilityAudience.AUTONOMOUS_DIAGNOSIS,
                invocation_context,
                CapabilityRequest(
                    capability=CurrentEvidenceCapabilityAdapter.descriptor.capability,
                    component_id=packet.affected_entities[0],
                    data_class=CapabilityDataClass.CURRENT_INCIDENT,
                    parameters={},
                ),
                ToolCallBudget(max_calls=1),
                evidence_admission=evidence_admission or DomainEvidenceAdmission(
                    self._repository(packet), packet.actor_subject_id,
                ),
            )
            acquired = EvidenceAcquisitionResult(
                evidence=invocation.result.evidence,
                claims=invocation.result.claims,
                coverage=invocation.result.coverage,
            )
            return ActivityOutcome(
                decision=VerificationDecision.PASS, identity="capability:current-evidence:v1",
                acquisition=acquired,
            )
        except PolicyViolation as error:
            return ActivityOutcome(
                decision=VerificationDecision.FAIL, state=CaseState.NEEDS_HUMAN,
                identity="acquire_current_evidence:p0:domain", reason_codes=[str(error)],
            )

    def execute(self, packet: TemporalActivityPacket) -> ActivityOutcome:
        try:
            if packet.stage == "acquire_current_evidence":
                if self.evidence_acquirer is None:
                    raise PolicyViolation("controlled_current_evidence_port_unconfigured")
                acquired = self.evidence_acquirer.acquire(self._case(packet), packet.actor_subject_id)
                repository = InMemoryCaseRepository()
                repository.put_case(self._case(packet))
                gateway = EvidenceGateway(repository, packet.actor_subject_id)
                for evidence in acquired.evidence:
                    gateway.admit(evidence)
                for claim in acquired.claims:
                    gateway.admit_claim(claim)
                for entry in acquired.coverage:
                    repository.put_coverage(entry)
                return ActivityOutcome(
                    decision=VerificationDecision.PASS, identity="evidence-acquisition:p0:controlled-port",
                    acquisition=acquired,
                )
            repository = self._repository(packet)
            if packet.stage in {"primary_investigator", "specialist"}:
                role = "primary" if packet.stage == "primary_investigator" else packet.specialist_role
                if role is None:
                    raise PolicyViolation("specialist_role_required")
                repository.put_assignment(InvestigatorAssignment(
                    assignment_id="assignment-{}-{}-{}".format(packet.case_id, packet.sequence, role),
                    case_id=packet.case_id, case_revision=packet.case_revision, tenant_id=packet.tenant_id,
                    role=role, question="bounded diagnosis", allowed_tools=["read_evidence"],
                    allowed_entities=packet.affected_entities, dispatched_at=datetime.now(timezone.utc),
                ))
            if packet.stage == "critic":
                critic = DeterministicCritic().review(repository, packet.case_id)
                return ActivityOutcome(
                    decision=critic.decision,
                    state=CaseState.NEEDS_HUMAN if critic.decision != VerificationDecision.PASS else None,
                    identity=critic.identity, reason_codes=critic.reason_codes, critic=critic,
                )
            if packet.stage == "independent_verify":
                report = IndependentEvidenceVerifier(self.source_readback).verify(
                    repository, packet.case_id, packet.workflow_run_id, subject_id=packet.actor_subject_id
                )
                return ActivityOutcome(
                    decision=report.decision,
                    state=CaseState.ABSTAINED if report.decision != VerificationDecision.PASS else None,
                    identity=report.verifier_identity, reason_codes=report.reason_codes,
                    verification=report,
                )
            if packet.stage == "owner_wait":
                return ActivityOutcome(
                    decision=VerificationDecision.PASS, state=CaseState.AWAITING_OWNER,
                    identity="owner-wait:p0:temporal-durable",
                )
            if packet.stage == "validate_owner_command":
                if packet.auth_assertion is None:
                    raise PolicyViolation("owner_auth_assertion_required")
                proposal_id = packet.proposal.proposal_id if packet.proposal is not None else packet.proposal_id
                approval_id = packet.approval.approval_id if packet.approval is not None else None
                authenticated = self.authorization.resolve(
                    packet.auth_assertion, self._case(packet), proposal_id, approval_id,
                )
                if packet.approval is not None:
                    if packet.approval.actor_id != authenticated.subject_id:
                        raise PolicyViolation("approval_actor_not_authenticated_subject")
                    if "owner" not in authenticated.roles:
                        raise PolicyViolation("owner_role_required")
                return ActivityOutcome(
                    decision=VerificationDecision.PASS, identity="owner-command-authz:p0:trusted",
                    authenticated=authenticated,
                )
            if packet.stage == "owner_gate":
                if packet.proposal is None:
                    return ActivityOutcome(
                        decision=VerificationDecision.AMBIGUOUS, state=CaseState.NEEDS_HUMAN,
                        identity="owner-gate:p0:exact", reason_codes=["proposal_required"],
                    )
                if packet.approval is None:
                    return ActivityOutcome(
                        decision=VerificationDecision.AMBIGUOUS, state=CaseState.AWAITING_OWNER,
                        identity="owner-gate:p0:exact", reason_codes=["owner_approval_required"],
                    )
                authenticated = packet.authorized_actor
                if authenticated is None:
                    raise PolicyViolation("owner_authorization_not_validated")
                if packet.approval.actor_id != authenticated.subject_id:
                    raise PolicyViolation("approval_actor_not_authenticated_subject")
                validate_owner_gate(
                    approval=packet.approval, proposal=packet.proposal,
                    current_case_revision=packet.case_revision, current_witness=packet.current_witness,
                    now=datetime.now(timezone.utc), authenticated_subject=authenticated.subject_id,
                    authenticated_roles=authenticated.roles, action_allowlist=(),
                )
                return ActivityOutcome(
                    decision=VerificationDecision.PASS, state=CaseState.APPROVED,
                    identity="owner-gate:p0:exact",
                )
            return ActivityOutcome(decision=VerificationDecision.PASS, identity="{}:p0:domain".format(packet.stage))
        except PolicyViolation as error:
            # A rejected update is an audit event, not a case-state transition.
            # In particular, a forged command that arrived before OWNER_WAIT
            # became externally visible must not overwrite that projection.
            terminal = (
                None if packet.stage == "validate_owner_command"
                else CaseState.BLOCKED if packet.stage == "owner_gate" else CaseState.NEEDS_HUMAN
            )
            return ActivityOutcome(
                decision=VerificationDecision.FAIL, state=terminal,
                identity="{}:p0:domain".format(packet.stage), reason_codes=[str(error)],
            )


class PostgresActivityDispatcher(ControlActivityDispatcher):
    def __init__(
        self, repository: PostgresCaseRepository, artifacts: S3ObjectStore, source_readback: EvidenceReadbackPort,
        authorization: AuthorizationPort, evidence_acquirer: Optional[CurrentEvidenceAcquisitionPort] = None,
        capability_registry: Optional[CapabilityRegistry] = None,
    ) -> None:
        self.repository = repository
        self.artifacts = artifacts
        self.authorization = authorization
        self.engine = DomainActivityEngine(
            source_readback, authorization, evidence_acquirer, capability_registry,
        )

    async def _persist_case_scope(self, packet: TemporalActivityPacket) -> None:
        await self.repository.put_case(self.engine._case(packet))

    async def _persist_domain(self, packet: TemporalActivityPacket) -> None:
        now = datetime.now(timezone.utc)
        await self.repository.put_case(IncidentCase(
            case_id=packet.case_id, tenant_id=packet.tenant_id, case_revision=packet.case_revision,
            workflow_id=packet.workflow_id, workflow_run_id=packet.workflow_run_id,
            public_incident_id=packet.public_incident_id, public_run_id=packet.public_run_id,
            public_topology_revision=packet.public_topology_revision,
            severity=packet.severity, environment=packet.environment, affected_entities=packet.affected_entities,
            created_at=now, updated_at=now,
        ))
        for evidence in packet.evidence:
            await self.repository.put_evidence(evidence, packet.actor_subject_id)
        for claim in packet.claims:
            await self.repository.put_claim(claim, packet.actor_subject_id)
        for coverage in packet.coverage:
            await self.repository.put_coverage(coverage)
        if packet.stage in {"primary_investigator", "specialist"}:
            role = "primary" if packet.stage == "primary_investigator" else packet.specialist_role
            if role is None:
                raise PolicyViolation("specialist_role_required")
            await self.repository.put_assignment(InvestigatorAssignment(
                assignment_id="assignment-{}-{}-{}".format(packet.case_id, packet.sequence, role),
                case_id=packet.case_id, case_revision=packet.case_revision, tenant_id=packet.tenant_id,
                role=role, question="bounded diagnosis", allowed_tools=["read_evidence"],
                allowed_entities=packet.affected_entities, dispatched_at=datetime.now(timezone.utc),
            ))

    async def dispatch(self, stage: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        packet = TemporalActivityPacket.parse_obj(packet_data)
        if packet.stage != stage.removesuffix("_activity"):
            raise PolicyViolation("temporal_activity_stage_mismatch")
        # Scope authority resolves the persisted case before a production
        # capability adapter or its audit record can run.
        await self._persist_case_scope(packet)
        outcome = await self.engine.execute_async(
            packet, DomainEvidenceAdmission(self.repository, packet.actor_subject_id),
        )
        persisted_packet = packet
        if outcome.acquisition is not None:
            persisted_packet = packet.copy(update={
                "evidence": outcome.acquisition.evidence,
                "claims": outcome.acquisition.claims,
                "coverage": outcome.acquisition.coverage,
            })
        await self._persist_domain(persisted_packet)
        if packet.stage == "owner_gate":
            outcome = await self.repository.record_owner_gate(packet, outcome, packet.authorized_actor)
        elif outcome.state is not None:
            await self.repository.project_case_state(packet, outcome.state, outcome.reason_codes)
        encoded = persisted_packet.json(sort_keys=True).encode("utf-8")
        artifact_key = self.artifacts.put(packet.tenant_id, encoded)
        if self.artifacts.get(packet.tenant_id, artifact_key) != encoded:
            raise PolicyViolation("object_store_readback_mismatch")
        activity_id = activity.info().activity_id
        await self.repository.append_activity_event(packet, activity_id, outcome.dict(), artifact_key)
        if outcome.verification is not None:
            await self.repository.append_verification(packet, outcome.verification)
        return outcome.dict()


def _s3_store(endpoint: str, bucket: str, access_key: str, secret_key: str) -> S3ObjectStore:
    client = boto3.client(
        "s3", endpoint_url=endpoint, aws_access_key_id=access_key, aws_secret_access_key=secret_key,
        region_name="us-east-1",
    )
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        client.create_bucket(Bucket=bucket)
    return S3ObjectStore(client, bucket)


def resolve_worker_provider_dependencies(
    settings: ProviderSettings,
    deterministic_test_providers_enabled: bool = False,
):
    """Resolve the worker's three provider roles from one explicit truth mode."""
    deterministic_conversation = (
        DeterministicConversationProvider()
        if deterministic_test_providers_enabled
        else None
    )
    deterministic_synthesizer = (
        DeterministicInvestigationSynthesizer()
        if deterministic_test_providers_enabled
        else None
    )
    deterministic_critic = (
        DeterministicInvestigationCritic()
        if deterministic_test_providers_enabled
        else None
    )
    conversation = build_conversation_provider(
        settings,
        deterministic_provider=deterministic_conversation,
    )
    synthesis, critic = build_investigation_providers(
        settings,
        deterministic_synthesizer=deterministic_synthesizer,
        deterministic_critic=deterministic_critic,
    )
    return conversation, synthesis, critic


async def run_worker(
    address: str, task_queue: str, postgres_dsn: str, object_endpoint: str, object_bucket: str,
    object_access_key: str, object_secret_key: str, source_endpoint: str, source_bucket: str, source_prefix: str,
    source_tenant_id: str, source_access_key: str, source_secret_key: str, authorization_service_url: str,
    authorization_service_token: str,
    local_deterministic_evidence: bool = False,
    provider_settings: Optional[ProviderSettings] = None,
    deterministic_test_providers_enabled: bool = False,
    prometheus_url: Optional[str] = None,
    prometheus_expression: str = "flowpulse_checkout_error_rate",
    connector_allowed_origins=None,
    connector_allow_private_origins: bool = False,
    prometheus_binding_templates: Optional[List[ConfiguredBindingTemplate]] = None,
    realtime_scheduler_interval_seconds: float = 0,
    realtime_actor_subject_id: Optional[str] = None,
) -> None:
    client = await Client.connect(address)
    repository = PostgresCaseRepository(postgres_dsn)
    await repository.connect()
    artifacts = _s3_store(object_endpoint, object_bucket, object_access_key, object_secret_key)
    authorization = HttpAuthorizationClient(authorization_service_url, "worker", authorization_service_token)
    source_client = boto3.client(
        "s3", endpoint_url=source_endpoint, aws_access_key_id=source_access_key,
        aws_secret_access_key=source_secret_key, region_name="us-east-1",
    )
    source_readback = (
        LocalDeterministicSourceReadback()
        if local_deterministic_evidence
        else S3SourceReadback(source_client, source_bucket, source_prefix, source_tenant_id)
    )
    controlled_evidence_acquirer = S3CurrentEvidenceAcquirer(
        source_client, source_bucket, source_prefix, source_tenant_id,
    )
    # Local deterministic diagnosis remains isolated from the actual source
    # reader, while the user-facing Gate 1 adapter always remains a real,
    # controlled source capability when a worker has source credentials.
    evidence_acquirer = None if local_deterministic_evidence else controlled_evidence_acquirer
    descriptors = [RecordedContextCapabilityAdapter.descriptor]
    adapters = {RecordedContextCapabilityAdapter.descriptor.capability: RecordedContextCapabilityAdapter()}
    if evidence_acquirer is not None:
        autonomous_descriptors, autonomous_adapters = production_current_evidence_adapters(evidence_acquirer)
        descriptors.extend(autonomous_descriptors)
        adapters.update(autonomous_adapters)
    else:
        # Compose's deterministic diagnosis fixture still uses the configured
        # reader for a user-authorized Gate 1 command. It does not turn that
        # read into deterministic diagnosis evidence.
        gate1_adapter = Gate1CurrentEvidenceCapabilityAdapter(controlled_evidence_acquirer)
        descriptors.append(gate1_adapter.descriptor)
        adapters[gate1_adapter.descriptor.capability] = gate1_adapter
    capability_registry = CapabilityRegistry(
        descriptors=descriptors, adapters=adapters, audit_sink=repository,
        scope_authority=PostgresCapabilityScopeAuthority(repository),
        gate1_authority=Gate1LeaseAuthority(repository),
    )
    resolved_provider_settings = provider_settings or ProviderSettings()
    topology_provider = None
    if resolved_provider_settings.mode in {ProviderMode.TEST, ProviderMode.DEMO}:
        from .workspace_topology import CapturedAstronomyTopologyProvider
        topology_provider = CapturedAstronomyTopologyProvider(resolved_provider_settings.mode)
    conversation_provider, investigation_synthesizer, investigation_critic = (
        resolve_worker_provider_dependencies(
            resolved_provider_settings,
            deterministic_test_providers_enabled,
        )
    )
    conversation_manager = ConversationManager(
        conversation_provider,
        capability_registry,
        specialist_roles=[ConversationRole.EVIDENCE_SPECIALIST, ConversationRole.TOPOLOGY_SPECIALIST],
        max_output_tokens=resolved_provider_settings.max_output_tokens,
    )
    connector_truth_label = (
        ConnectorTruthLabel.TEST_DETERMINISTIC
        if resolved_provider_settings.mode == ProviderMode.TEST
        else ConnectorTruthLabel.LIVE
    )
    realtime_adapters = {}
    if prometheus_url:
        prometheus_registration = ConnectorRegistration(
            connector_id="connector-prometheus-primary",
            tenant_id=source_tenant_id,
            provider=ConnectorProvider.PROMETHEUS,
            adapter_version="prometheus-read.v1",
            data_classes=["METRIC"],
            capabilities=["METRICS"],
            freshness_sla_seconds=60,
            enabled=True,
            truth_label=connector_truth_label,
        )
        await repository.register_realtime_connector(prometheus_registration)
        endpoint_policy = ConnectorEndpointPolicy(
            allowed_origins=list(connector_allowed_origins or []),
            allow_private_origins=connector_allow_private_origins,
        )
        realtime_adapters[prometheus_registration.connector_id] = ConfiguredPrometheusConnector(
            registration=prometheus_registration,
            base_url=prometheus_url,
            expression=prometheus_expression,
            reader=BoundedJsonReader(endpoint_policy),
            artifact_store=artifacts,
            repository=repository,
        )
    otel_registration = ConnectorRegistration(
        connector_id="connector-otel-primary",
        tenant_id=source_tenant_id,
        provider=ConnectorProvider.OTEL,
        adapter_version="otel-read.v1",
        data_classes=["TRACE", "LOG"],
        capabilities=["TRACES", "LOGS"],
        freshness_sla_seconds=60,
        # Phase 1A has no safe OTEL query adapter. A configured URL remains
        # truthfully unavailable until that bounded adapter is implemented.
        enabled=True,
        truth_label=connector_truth_label,
    )
    await repository.register_realtime_connector(otel_registration)
    await UnavailableOtelAdapter(otel_registration, repository).health()

    async def dispatch_realtime_fact(source, dispatch):
        projection = await repository.workspace_projection(
            source.tenant_id, source.case_id,
        )
        if projection is None:
            raise RuntimeError("realtime_dispatch_workspace_projection_missing")
        handle = client.get_workflow_handle(
            projection.workflow_id, run_id=projection.workflow_run_id,
        )
        response = await handle.execute_update(
            IncidentWorkspaceTemporalWorkflow.reconcile_realtime_connector,
            RealtimeUpdateCommand(
                tenant_id=source.tenant_id,
                actor_subject_id=(
                    realtime_actor_subject_id or source.acl_subjects[0]
                ),
                case_id=source.case_id,
                incident_id=source.incident_id,
                run_id=source.run_id,
                topology_revision=source.topology_revision,
                connector_id=source.connector_id,
                source_event_id=source.source_event_id,
                dispatch_id=dispatch.dispatch_id,
                idempotency_key=dispatch.dispatch_id,
            ).dict(),
        )
        outcome = RealtimeUpdateOutcome.parse_obj(response)
        if not outcome.accepted:
            raise RuntimeError(outcome.reason or "realtime_dispatch_rejected")
        return outcome

    scheduler = RealtimeIngestScheduler(
        repository=repository,
        connectors=realtime_adapters,
        temporal_dispatch=dispatch_realtime_fact,
        tenant_id=source_tenant_id,
        binding_templates=list(prometheus_binding_templates or []),
        actor_subject_id=realtime_actor_subject_id or "",
    )

    async def scheduler_loop():
        while True:
            try:
                await scheduler.run_once()
            except Exception as error:
                realtime_telemetry.record(
                    "PROMETHEUS",
                    "dispatch",
                    "error",
                    reason_code=type(error).__name__,
                )
            await asyncio.sleep(realtime_scheduler_interval_seconds)

    async with Worker(
        client, task_queue=task_queue,
        workflows=[
            LegacyDiagnosisTemporalWorkflow,
            DiagnosisTemporalWorkflow,
            *workspace_workflow_definitions(),
        ],
        activities=(
            build_temporal_activities(PostgresActivityDispatcher(
                repository, artifacts, source_readback, authorization, evidence_acquirer, capability_registry,
            ))
            + build_workspace_activities(WorkspaceActivityDispatcher(
                repository, conversation_manager=conversation_manager, authorization=authorization,
                capability_registry=capability_registry,
                investigation_synthesizer=investigation_synthesizer,
                investigation_critic=investigation_critic,
                topology_provider=topology_provider,
            ))
            + build_realtime_activities(RealtimeActivityDispatcher(
                repository, realtime_adapters,
            ))
        ),
    ):
        scheduler_task = (
            asyncio.create_task(scheduler_loop())
            if realtime_scheduler_interval_seconds > 0 else None
        )
        try:
            await asyncio.Future()
        finally:
            if scheduler_task is not None:
                scheduler_task.cancel()
            await repository.close()

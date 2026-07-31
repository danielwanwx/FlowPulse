"""Temporal activity implementation for the guided V3 incident loop.

The activity layer is the only place that may call the hardened local Codex
bridge or the allowlisted Astronomy executor. Model output remains an
untrusted explanation; canonical telemetry and the coordinator own all state,
evidence, approval, and verification decisions.
"""

import asyncio
import hmac
import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .models import FreshnessStatus
from .policy import PolicyViolation
from .realtime_models import RealtimeSignalStatus
from .workspace_v3_guided import GuidedWorkflowCoordinatorV3
from .workspace_v3_models import (
    ActionApprovalCommandV3,
    ActionApprovalDecisionV3,
    ActionRollbackReceiptV3,
    ActionExecutionReceiptV3,
    ActionExecutionStateV3,
    AgentRunCommandV3,
    AgentRunStateV3,
    GuidedActionActivityPacketV3,
    GuidedActionBridgeRequestV3,
    GuidedActionBridgeResponseV3,
    GuidedActionPreflightRequestV3,
    GuidedActionPreflightResponseV3,
    GuidedAgentActivityPacketV3,
    GuidedAgentBridgeRequestV3,
    GuidedAgentBridgeResponseV3,
    GuidedAgentEvidenceFactV3,
    GuidedRollbackBridgeResponseV3,
    GuidedStageActivityOutcomeV3,
    GuidedStageActivityPacketV3,
    GuidedStageActivityStatusV3,
    IncidentActionStatusV3,
    IncidentActionV3,
    ActionApprovalStateV3,
    ActionExecutionStateV3,
    StageFactV3,
    DecisionActionCandidateV3,
    DecisionDryRunStateV3,
    EvidenceQueryNameV3,
    EvidenceQueryResultV3,
    EvidenceQueryStateV3,
    WorkflowHypothesisV3,
    WorkflowCommandV3,
    WorkflowEscalationCommandV3,
    WorkflowRerunCommandV3,
    WorkflowStageStateV3,
    WorkflowStageV3,
    WorkflowTemporalCommandV3,
    WorkflowTemporalOperationV3,
)


ALLOWLISTED_ASTRONOMY_COMMAND = "astronomy.restore-payment-and-recreate-checkout"
GUIDED_ACTIVITY_MAX_ATTEMPTS = 3
GUIDED_AGENT_REQUEST_MAX_BYTES = 64 * 1024
SERVER_OWNED_EVIDENCE_QUERY_ALLOWLIST = frozenset({
    EvidenceQueryNameV3.CURRENT_INCIDENT_SIGNALS,
})


def _stable_id(prefix: str, *parts: object) -> str:
    material = ":".join(str(part) for part in parts)
    return "{}-{}".format(prefix, sha256(material.encode("utf-8")).hexdigest()[:24])


class GuidedRuntimeBridgeUnavailable(RuntimeError):
    pass


class GuidedRuntimeBridgeRejected(RuntimeError):
    """A signed bridge returned an explicit terminal policy/result code."""

    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class GuidedRuntimeStageFailed(RuntimeError):
    pass


class GuidedRuntimeStageObsolete(RuntimeError):
    """The activity packet belongs to a superseded attempt/stage-run."""

    pass


def _activity_attempt() -> int:
    """Read the Temporal attempt while keeping direct unit calls deterministic."""

    try:
        from temporalio import activity
        return max(1, activity.info().attempt)
    except Exception:
        return 1


class HttpGuidedRuntimeBridgeV3:
    """Signed, exact-origin bridge to existing hardened Node local adapters."""

    def __init__(
        self,
        base_url: Optional[str],
        secret: Optional[str],
        *,
        timeout_seconds: int = 125,
        rollback_url: Optional[str] = None,
        rollback_secret: Optional[str] = None,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.secret = secret or ""
        self.timeout_seconds = timeout_seconds
        self.rollback_url = (rollback_url or "").rstrip("/")
        self.rollback_secret = rollback_secret or ""
        for configured_url in (self.base_url, self.rollback_url):
            if not configured_url:
                continue
            parsed = urlparse(configured_url)
            if (
                parsed.scheme != "http"
                or parsed.hostname not in {"127.0.0.1", "localhost", "host.docker.internal"}
                or parsed.username is not None
                or parsed.password is not None
            ):
                raise ValueError("workflow_v3_internal_bridge_origin_invalid")
        if bool(self.base_url) != bool(self.secret):
            raise ValueError("workflow_v3_internal_bridge_configuration_incomplete")
        if bool(self.rollback_url) != bool(self.rollback_secret):
            raise ValueError("workflow_v3_safe_rollback_configuration_incomplete")

    def _post_sync(
        self, path: str, payload: Dict[str, Any],
        *, base_url: Optional[str] = None, secret: Optional[str] = None,
    ) -> Dict[str, Any]:
        resolved_base_url = self.base_url if base_url is None else base_url
        resolved_secret = self.secret if secret is None else secret
        if not resolved_base_url or not resolved_secret:
            raise GuidedRuntimeBridgeUnavailable("workflow_v3_internal_bridge_unavailable")
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(resolved_secret.encode("utf-8"), raw, sha256).hexdigest()
        request = Request(
            resolved_base_url + path,
            data=raw,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-flowpulse-internal-signature": signature,
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            try:
                payload = json.loads(error.read(16 * 1024).decode("utf-8"))
                code = payload.get("error") if isinstance(payload, dict) else None
            except Exception:
                code = None
            code = code if isinstance(code, str) and code else "workflow_v3_internal_bridge_http_error"
            # A generic 5xx may have happened after the durable Node effect but
            # before its response reached Python. Retry the exact same signed
            # request/idempotency key; explicit Codex/policy errors are final.
            if error.code >= 500 and not code.startswith("codex_"):
                raise GuidedRuntimeBridgeUnavailable(code) from error
            raise GuidedRuntimeBridgeRejected(code, error.code) from error
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            raise GuidedRuntimeBridgeUnavailable(
                "workflow_v3_internal_bridge_request_failed",
            ) from error

    async def run_agent(
        self, request: GuidedAgentBridgeRequestV3,
    ) -> GuidedAgentBridgeResponseV3:
        response = await asyncio.to_thread(
            self._post_sync,
            "/api/internal/control-plane/v3/agent-runs",
            json.loads(request.json()),
        )
        result = GuidedAgentBridgeResponseV3.parse_obj(response)
        if result.request_id != request.request_id:
            raise PolicyViolation("workflow_v3_agent_bridge_request_mismatch")
        if not set(result.evidence_refs).issubset(set(request.evidence_refs)):
            raise PolicyViolation("workflow_v3_agent_bridge_evidence_not_canonical")
        # V3 does not let a model nominate a query and then treat the echoed
        # request as evidence.  Until a server-owned tool executor returns a
        # separately persisted, typed result, every tool request fails closed.
        if result.tool_requests:
            raise PolicyViolation("workflow_v3_agent_tool_request_not_executed")
        return result

    async def execute_action(
        self, request: GuidedActionBridgeRequestV3,
    ) -> GuidedActionBridgeResponseV3:
        response = await asyncio.to_thread(
            self._post_sync,
            "/api/internal/control-plane/v3/actions/execute",
            json.loads(request.json()),
        )
        result = GuidedActionBridgeResponseV3.parse_obj(response)
        if (
            result.execution_key != request.execution_key
            or result.command_id != request.command_id
        ):
            raise PolicyViolation("workflow_v3_action_bridge_request_mismatch")
        return result

    async def preflight_action(
        self, request: GuidedActionPreflightRequestV3,
    ) -> GuidedActionPreflightResponseV3:
        response = await asyncio.to_thread(
            self._post_sync,
            "/api/internal/control-plane/v3/actions/preflight",
            json.loads(request.json()),
        )
        result = GuidedActionPreflightResponseV3.parse_obj(response)
        if (
            result.request_id != request.request_id
            or result.command_id != request.command_id
            or result.target_component_id != request.target_component_id
            or "{}={}".format(result.flag_name, result.expected_variant)
            != request.expected_before
        ):
            raise PolicyViolation("workflow_v3_action_preflight_request_mismatch")
        return result

    async def rollback_action(self, request: GuidedActionBridgeRequestV3):
        if not self.rollback_url or not self.rollback_secret:
            raise GuidedRuntimeBridgeUnavailable(
                "workflow_v3_rollback_port_unconfigured",
            )
        response = await asyncio.to_thread(
            self._post_sync,
            "/api/internal/control-plane/v3/actions/safe-rollback",
            json.loads(request.json()),
            base_url=self.rollback_url,
            secret=self.rollback_secret,
        )
        result = GuidedRollbackBridgeResponseV3.parse_obj(response)
        if (
            result.execution_key != request.execution_key
            or result.action_id != request.action_id
            or result.command_id != request.command_id
        ):
            raise PolicyViolation("workflow_v3_safe_rollback_scope_mismatch")
        return result


class GuidedWorkflowActivityDispatcherV3:
    """Runs one current stage at a time against append-only repository state."""

    def __init__(self, repository, bridge: Any) -> None:
        self.repository = repository
        self.bridge = bridge
        self.coordinator = GuidedWorkflowCoordinatorV3(repository)

    async def _persist_with_rebase(self, operation):
        """Retry only a projection CAS race, never the external side effect.

        Realtime synchronization preserves workflow revision but may advance
        projection revision between a stage activity's read and commit.  The
        supplied operation reconstructs its deterministic transition from the
        latest canonical projection while retaining the already-captured
        evidence/model/preflight result in its closure.
        """

        race_codes = {
            "workflow_v3_transition_not_monotonic",
            "workflow_v3_revision_conflict",
            "workflow_v3_realtime_projection_conflict",
        }
        last_error = None
        for _ in range(3):
            try:
                return await operation()
            except PolicyViolation as error:
                last_error = error
                if not any(code in str(error) for code in race_codes):
                    raise
        raise last_error

    async def dispatch_command(
        self, invocation_data: Dict[str, Any], *, now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        invocation = WorkflowTemporalCommandV3.parse_obj(invocation_data)
        now = now or datetime.now(timezone.utc)
        if not set(invocation.actor_roles).intersection({"owner", "local-test-owner"}):
            raise PolicyViolation("owner_role_required")
        operation = invocation.operation
        if operation == WorkflowTemporalOperationV3.ADVANCE:
            receipt = await self.coordinator.advance(
                invocation.tenant_id, invocation.case_id,
                WorkflowCommandV3.parse_obj(invocation.command),
                invocation.actor_subject_id, now,
            )
        elif operation == WorkflowTemporalOperationV3.RERUN:
            receipt = await self.coordinator.rerun(
                invocation.tenant_id, invocation.case_id, invocation.target_stage,
                WorkflowRerunCommandV3.parse_obj(invocation.command),
                invocation.actor_subject_id, now,
            )
        elif operation == WorkflowTemporalOperationV3.ESCALATE:
            receipt = await self.coordinator.escalate(
                invocation.tenant_id, invocation.case_id,
                WorkflowEscalationCommandV3.parse_obj(invocation.command),
                invocation.actor_subject_id, now,
            )
        elif operation == WorkflowTemporalOperationV3.AGENT_RUN:
            receipt = await self.coordinator.start_agent_run(
                invocation.tenant_id, invocation.case_id,
                AgentRunCommandV3.parse_obj(invocation.command),
                invocation.actor_subject_id, now,
            )
        elif operation == WorkflowTemporalOperationV3.ACTION_APPROVAL:
            receipt = await self.coordinator.approve_action(
                invocation.tenant_id, invocation.case_id, invocation.action_id,
                ActionApprovalCommandV3.parse_obj(invocation.command),
                invocation.actor_subject_id, invocation.actor_roles, now,
            )
        else:
            raise PolicyViolation("workflow_v3_operation_unsupported")
        return receipt.dict()

    @staticmethod
    def _required_current(projection, packet) -> None:
        attempt = projection.current_attempt
        current = next(
            item for item in attempt.stage_runs
            if item.stage == attempt.current_stage
            and item.status != WorkflowStageStateV3.SUPERSEDED
        )
        if (
            packet.attempt_id != attempt.attempt_id
            or packet.stage_run_id != current.stage_run_id
            or getattr(packet, "stage", current.stage) != current.stage
        ):
            raise PolicyViolation("workflow_v3_activity_scope_mismatch")

    async def _required_stage_projection(
        self,
        tenant_id: str,
        case_id: str,
        attempt_id: str,
        stage_run_id: str,
    ):
        projection = await self.coordinator._required_projection(
            tenant_id, case_id,
        )
        current = next(
            item for item in projection.current_attempt.stage_runs
            if item.stage == projection.current_attempt.current_stage
            and item.status != WorkflowStageStateV3.SUPERSEDED
        )
        if (
            projection.current_attempt.attempt_id != attempt_id
            or current.stage_run_id != stage_run_id
        ):
            raise GuidedRuntimeStageObsolete("workflow_v3_stage_run_superseded")
        return projection

    @staticmethod
    def _evidence_refs(projection) -> List[str]:
        return list(dict.fromkeys(
            ref
            for run in projection.current_attempt.stage_runs
            if run.status != WorkflowStageStateV3.SUPERSEDED
            for ref in run.evidence_refs
        ))

    async def _agent_request(
        self, projection, role: str, request_discriminator: Optional[str] = None,
        hypotheses_override: Optional[List[WorkflowHypothesisV3]] = None,
        selected_component_override: Optional[str] = None,
    ) -> GuidedAgentBridgeRequestV3:
        attempt = projection.current_attempt
        current = next(
            item for item in attempt.stage_runs
            if item.stage == attempt.current_stage
            and item.status != WorkflowStageStateV3.SUPERSEDED
        )
        evidence_refs = self._evidence_refs(projection)
        prior_agent_summary = " ".join(
            item.summary for item in projection.agent_activity
            if item.stage_run_id == current.stage_run_id
            and item.state == AgentRunStateV3.SUCCEEDED
        )
        known_components = {item.component_id for item in projection.graph.nodes}
        known_edges = {item.edge_id for item in projection.graph.edges}
        selected = selected_component_override or (
            projection.impacted_path[0]
            if projection.impacted_path else projection.graph.nodes[0].component_id
        )
        if selected not in known_components:
            raise PolicyViolation("workflow_v3_agent_component_not_canonical")
        canonical_refs = set(evidence_refs)
        live_investigate_run_ids = {
            item.stage_run_id for item in attempt.stage_runs
            if item.stage == WorkflowStageV3.INVESTIGATE
            and item.status != WorkflowStageStateV3.SUPERSEDED
        }
        source = await self.repository.realtime_projection(
            projection.tenant_id, projection.case_id,
        )
        evidence_facts = []
        if source is not None:
            evidence_facts = [GuidedAgentEvidenceFactV3(
                fact_id=item.signal_id,
                label=item.title,
                value=item.display_value,
                observed_at=item.observed_at,
                component_ids=item.component_ids,
                edge_ids=item.edge_ids,
                evidence_refs=item.evidence_refs,
            ) for item in source.realtime_signals
                if item.freshness == FreshnessStatus.CURRENT
                and item.connector_state.value == "CONNECTED"
                and set(item.component_ids).issubset(known_components)
                and set(item.edge_ids).issubset(known_edges)
                and set(item.evidence_refs).issubset(canonical_refs)
            ][-32:]
        query_outcomes = [
            item for item in projection.evidence_queries
            if item.attempt_id == attempt.attempt_id
            and item.stage_run_id in live_investigate_run_ids
            and set(item.evidence_refs).issubset(canonical_refs)
            and set(item.component_ids).issubset(known_components)
            and set(item.edge_ids).issubset(known_edges)
        ][-16:]
        hypotheses = list(hypotheses_override) if hypotheses_override is not None else [
            item for item in projection.hypotheses
            if item.stage_run_id in live_investigate_run_ids
            and (
                set(item.supporting_evidence_refs)
                | set(item.contradicting_evidence_refs)
            ).issubset(canonical_refs)
        ][-32:]
        return GuidedAgentBridgeRequestV3(
            request_id=_stable_id(
                "agent-bridge", projection.case_id, current.stage_run_id,
                request_discriminator or role,
            ),
            case_id=projection.case_id,
            attempt_id=attempt.attempt_id,
            stage_run_id=current.stage_run_id,
            stage=current.stage,
            role=role,
            selected_component=selected,
            incident_title=projection.title,
            incident_summary=(
                "{} Prior independent result: {}".format(
                    projection.summary, prior_agent_summary,
                ) if prior_agent_summary else projection.summary
            ),
            freshness=projection.freshness,
            component_ids=[item.component_id for item in projection.graph.nodes],
            edge_ids=[item.edge_id for item in projection.graph.edges],
            evidence_refs=evidence_refs,
            evidence_facts=evidence_facts,
            query_outcomes=query_outcomes,
            hypotheses=hypotheses,
        )

    async def _freeze_agent_request(
        self,
        projection,
        agent,
        role: str,
        *,
        hypotheses_override: Optional[List[WorkflowHypothesisV3]] = None,
        now: Optional[datetime] = None,
    ):
        """Persist one exact redacted request before any provider call.

        The agent-run ID is the immutable idempotency discriminator. Realtime
        telemetry may continue moving after this point, but retries and lost
        responses always reuse the same signed bytes.
        """
        request = agent.bridge_request
        if request is None:
            if agent.progress_percent >= 25:
                raise PolicyViolation("workflow_v3_agent_bridge_snapshot_missing")
            request = await self._agent_request(
                projection,
                role,
                request_discriminator=agent.agent_run_id,
                hypotheses_override=hypotheses_override,
                selected_component_override=agent.selected_component_id,
            )
        request_bytes = len(request.json(
            sort_keys=True, separators=(",", ":"),
        ).encode("utf-8"))
        if request_bytes > GUIDED_AGENT_REQUEST_MAX_BYTES:
            raise PolicyViolation("workflow_v3_agent_bridge_request_too_large")
        if agent.progress_percent < 25:
            projection = await self._persist_with_rebase(
                lambda: self.coordinator.update_agent_run(
                    projection.tenant_id,
                    projection.case_id,
                    agent.agent_run_id,
                    state=AgentRunStateV3.RUNNING,
                    progress_percent=25,
                    summary="Preparing bounded evidence context.",
                    evidence_refs=self._evidence_refs(projection),
                    now=now or datetime.now(timezone.utc),
                    bridge_request=request,
                ),
            )
            projection = await self._required_stage_projection(
                projection.tenant_id,
                projection.case_id,
                projection.current_attempt.attempt_id,
                projection.current_attempt.stage_runs[-1].stage_run_id,
            )
            agent = next(
                item for item in projection.agent_activity
                if item.agent_run_id == agent.agent_run_id
            )
        if agent.bridge_request is None:
            raise PolicyViolation("workflow_v3_agent_bridge_snapshot_missing")
        return projection, agent.bridge_request

    async def _run_evidence_worker(
        self,
        projection,
        *,
        actor_subject_id: str,
        query_phase: str,
    ) -> tuple[Any, EvidenceQueryResultV3]:
        """Execute one closed, code-owned query and persist its typed result.

        The query name is selected by FlowPulse code.  No model text is parsed
        as a query and no arbitrary expression reaches a telemetry backend.
        Re-running this method after a Temporal retry is safe: a RUNNING query
        is read again, while a terminal typed result is immutable and reused.
        """

        current = next(
            item for item in projection.current_attempt.stage_runs
            if item.stage == projection.current_attempt.current_stage
            and item.status != WorkflowStageStateV3.SUPERSEDED
        )
        if current.stage != WorkflowStageV3.INVESTIGATE:
            raise PolicyViolation("workflow_v3_evidence_worker_stage_forbidden")
        expected_attempt_id = projection.current_attempt.attempt_id
        expected_stage_run_id = current.stage_run_id
        query_name = EvidenceQueryNameV3.CURRENT_INCIDENT_SIGNALS
        if query_name not in SERVER_OWNED_EVIDENCE_QUERY_ALLOWLIST:
            raise PolicyViolation("workflow_v3_evidence_query_not_allowlisted")
        worker_key = "evidence-worker-{}".format(query_phase)
        command = AgentRunCommandV3(
            attempt_id=projection.current_attempt.attempt_id,
            expected_stage=current.stage,
            expected_workflow_revision=projection.workflow_revision,
            idempotency_key="auto-agent:{}:{}".format(
                current.stage_run_id, worker_key,
            ),
            component_id=(
                projection.impacted_path[0]
                if projection.impacted_path else None
            ),
            question=(
                "Execute the server-owned {} allowlisted evidence query."
            ).format(query_name.value),
        )
        receipt = await self.coordinator.start_agent_run(
            projection.tenant_id, projection.case_id, command,
            actor_subject_id, datetime.now(timezone.utc),
            role_override="EVIDENCE_WORKER",
        )
        worker_seed = receipt.projection.agent_activity[-1]
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        worker = next(
            item for item in projection.agent_activity
            if item.agent_run_id == worker_seed.agent_run_id
        )
        query_id = _stable_id(
            "evidence-query", projection.case_id, current.stage_run_id,
            query_name.value, query_phase,
        )
        existing = next((
            item for item in projection.evidence_queries
            if item.query_id == query_id
        ), None)
        if existing is not None and existing.state != EvidenceQueryStateV3.RUNNING:
            if existing.state == EvidenceQueryStateV3.FAILED:
                if worker.state == AgentRunStateV3.RUNNING:
                    projection = await self._persist_with_rebase(
                        lambda: self.coordinator.update_agent_run(
                            projection.tenant_id, projection.case_id,
                            worker.agent_run_id,
                            state=AgentRunStateV3.FAILED,
                            progress_percent=worker.progress_percent,
                            summary=existing.result_summary,
                            evidence_refs=existing.evidence_refs,
                            failure_code=existing.failure_code,
                            now=datetime.now(timezone.utc),
                        ),
                    )
                raise GuidedRuntimeStageFailed(
                    existing.failure_code
                    or "workflow_v3_evidence_query_failed",
                )
            if worker.state == AgentRunStateV3.RUNNING:
                projection = await self._persist_with_rebase(
                    lambda: self.coordinator.update_agent_run(
                        projection.tenant_id, projection.case_id,
                        worker.agent_run_id,
                        state=AgentRunStateV3.SUCCEEDED,
                        progress_percent=100,
                        summary=existing.result_summary,
                        evidence_refs=existing.evidence_refs,
                        now=datetime.now(timezone.utc),
                        ),
                    )
            projection = await self._required_stage_projection(
                projection.tenant_id, projection.case_id,
                expected_attempt_id, expected_stage_run_id,
            )
            return projection, existing

        started_at = (
            existing.started_at if existing is not None
            else datetime.now(timezone.utc)
        )
        parameters_hash = sha256(json.dumps({
            "tenant_id": projection.tenant_id,
            "case_id": projection.case_id,
            "attempt_id": projection.current_attempt.attempt_id,
            "stage_run_id": current.stage_run_id,
            "query_name": query_name.value,
        }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        if existing is None:
            running = EvidenceQueryResultV3(
                query_id=query_id,
                attempt_id=projection.current_attempt.attempt_id,
                stage_run_id=current.stage_run_id,
                stage=current.stage,
                worker_activity_id=worker.activity_id,
                query_name=query_name,
                state=EvidenceQueryStateV3.RUNNING,
                parameters_hash=parameters_hash,
                result_summary="Allowlisted current incident signal query started.",
                started_at=started_at,
            )
            projection = await self._persist_with_rebase(
                lambda: self.coordinator.record_evidence_query(
                    projection.tenant_id, projection.case_id, running,
                    now=datetime.now(timezone.utc),
                ),
            )
            worker = next(
                item for item in projection.agent_activity
                if item.agent_run_id == worker.agent_run_id
            )
            if worker.progress_percent < 25:
                projection = await self._persist_with_rebase(
                    lambda: self.coordinator.update_agent_run(
                        projection.tenant_id, projection.case_id,
                        worker.agent_run_id,
                        state=AgentRunStateV3.RUNNING,
                        progress_percent=25,
                        summary="Reading canonical connector-owned evidence.",
                        evidence_refs=[],
                        now=datetime.now(timezone.utc),
                    ),
                )

        source = await self.repository.realtime_projection(
            projection.tenant_id, projection.case_id,
        )
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        known_components = {item.component_id for item in projection.graph.nodes}
        known_edges = {item.edge_id for item in projection.graph.edges}
        signals = [] if source is None else [
            item for item in source.realtime_signals
            if source.tenant_id == projection.tenant_id
            and source.case_id == projection.case_id
            and source.incident_id == projection.incident_id
            and source.run_id == projection.run_id
            and item.freshness == FreshnessStatus.CURRENT
            and item.fresh_until > datetime.now(timezone.utc)
            and item.connector_state.value == "CONNECTED"
            and source.incident_clock.freshness == FreshnessStatus.CURRENT
            and source.incident_clock.fresh_until > datetime.now(timezone.utc)
            and set(item.component_ids).issubset(known_components)
            and set(item.edge_ids).issubset(known_edges)
            and bool(item.evidence_refs)
        ]
        # The bounded realtime projection intentionally stores only the newest
        # value per logical telemetry stream. Investigation still needs a
        # time-separated evidence window, so query the append-only source-event
        # ledger for recent samples from the exact admitted bindings. This is
        # code-owned provenance; no model output can enter the result.
        historical_events = []
        load_source = getattr(self.repository, "realtime_source_event", None)
        load_recent = getattr(
            self.repository, "recent_source_events_for_binding", None,
        )
        query_now = datetime.now(timezone.utc)
        if callable(load_source) and callable(load_recent):
            binding_ids = set()
            for signal in signals:
                source_event = await load_source(
                    projection.tenant_id, signal.source_event_id,
                )
                if source_event is not None:
                    binding_ids.add(source_event.binding_id)
            for binding_id in sorted(binding_ids):
                for source_event in await load_recent(
                    projection.tenant_id, binding_id, limit=12,
                ):
                    if (
                        source_event.case_id != projection.case_id
                        or source_event.incident_id != projection.incident_id
                        or source_event.run_id != projection.run_id
                        or source_event.topology_revision != projection.topology_revision
                        or source_event.freshness != FreshnessStatus.CURRENT
                        or set(source_event.component_ids).difference(known_components)
                        or set(source_event.edge_ids).difference(known_edges)
                    ):
                        continue
                    # Use the current stream's admitted freshness window. A
                    # historical sample outside that window is reference-only
                    # and cannot satisfy the causal coverage gate.
                    matching_signal = next((
                        item for item in signals
                        if item.source_event_id == source_event.source_event_id
                        or (
                            item.provider == source_event.provider
                            and set(item.component_ids) == set(source_event.component_ids)
                            and set(item.edge_ids) == set(source_event.edge_ids)
                        )
                    ), None)
                    ttl = (
                        matching_signal.fresh_until - matching_signal.observed_at
                        if matching_signal is not None else timedelta(seconds=30)
                    )
                    if source_event.observed_at + ttl <= query_now:
                        continue
                    historical_events.append(source_event)
        historical_events = sorted(
            {
                item.source_event_id: item for item in historical_events
            }.values(),
            key=lambda item: (item.observed_at, item.source_event_id),
        )[-32:]
        historical_refs = [
            "evidence-realtime-{}".format(item.normalization_hash[:24])
            for item in historical_events
        ]
        evidence_refs = list(dict.fromkeys([
            *[ref for signal in signals for ref in signal.evidence_refs],
            *historical_refs,
        ]))
        observation_timestamps = sorted({
            *[signal.observed_at for signal in signals],
            *[item.observed_at for item in historical_events],
        })
        terminal_at = datetime.now(timezone.utc)
        if not signals or not evidence_refs:
            terminal = EvidenceQueryResultV3(
                query_id=query_id,
                attempt_id=projection.current_attempt.attempt_id,
                stage_run_id=current.stage_run_id,
                stage=current.stage,
                worker_activity_id=worker.activity_id,
                query_name=query_name,
                state=EvidenceQueryStateV3.FAILED,
                parameters_hash=parameters_hash,
                result_summary="Allowlisted query returned no current canonical evidence.",
                started_at=started_at,
                completed_at=terminal_at,
                failure_code="canonical_current_evidence_missing",
            )
        else:
            prior_refs = set(current.evidence_refs)
            terminal = EvidenceQueryResultV3(
                query_id=query_id,
                attempt_id=projection.current_attempt.attempt_id,
                stage_run_id=current.stage_run_id,
                stage=current.stage,
                worker_activity_id=worker.activity_id,
                query_name=query_name,
                state=EvidenceQueryStateV3.SUCCEEDED,
                parameters_hash=parameters_hash,
                result_summary=(
                    "Allowlisted query persisted {} evidence records from {} "
                    "observed samples."
                ).format(len(evidence_refs), len(observation_timestamps)),
                component_ids=sorted({
                    *[
                        component for signal in signals
                        for component in signal.component_ids
                    ],
                    *[
                        component for item in historical_events
                        for component in item.component_ids
                    ],
                }),
                edge_ids=sorted({
                    *[edge for signal in signals for edge in signal.edge_ids],
                    *[edge for item in historical_events for edge in item.edge_ids],
                }),
                evidence_refs=evidence_refs,
                observation_timestamps=observation_timestamps,
                triggered_replan=(
                    query_phase == "refresh"
                    and bool(set(evidence_refs) - prior_refs)
                ),
                started_at=started_at,
                completed_at=terminal_at,
            )
        projection = await self._persist_with_rebase(
            lambda: self.coordinator.record_evidence_query(
                projection.tenant_id, projection.case_id, terminal,
                now=terminal_at,
            ),
        )
        worker = next(
            item for item in projection.agent_activity
            if item.agent_run_id == worker.agent_run_id
        )
        if terminal.state == EvidenceQueryStateV3.FAILED:
            projection = await self._persist_with_rebase(
                lambda: self.coordinator.update_agent_run(
                    projection.tenant_id, projection.case_id,
                    worker.agent_run_id,
                    state=AgentRunStateV3.FAILED,
                    progress_percent=worker.progress_percent,
                    summary=terminal.result_summary,
                    evidence_refs=[],
                    failure_code=terminal.failure_code,
                    now=datetime.now(timezone.utc),
                ),
            )
            raise GuidedRuntimeStageFailed(
                terminal.failure_code
                or "workflow_v3_evidence_query_failed",
            )
        projection = await self._persist_with_rebase(
            lambda: self.coordinator.update_agent_run(
                projection.tenant_id, projection.case_id,
                worker.agent_run_id,
                state=AgentRunStateV3.SUCCEEDED,
                progress_percent=100,
                summary=terminal.result_summary,
                evidence_refs=terminal.evidence_refs,
                now=datetime.now(timezone.utc),
            ),
        )
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        return projection, terminal

    async def _canonical_stage_facts(
        self,
        projection,
        stage: WorkflowStageV3,
        now: datetime,
    ) -> tuple[List[StageFactV3], List[str], Optional[str], Dict[str, Any]]:
        """Build success evidence only from the persisted connector projection.

        Codex prose is deliberately absent from this return value.  The model
        can explain or challenge the facts in ``agent_activity``; it cannot
        manufacture a StageFact or make a stage pass.
        """
        source = await self.repository.realtime_projection(
            projection.tenant_id, projection.case_id,
        )
        if source is None:
            return [], [], "canonical_realtime_projection_missing", {}
        known_components = {item.component_id for item in projection.graph.nodes}
        known_edges = {item.edge_id for item in projection.graph.edges}
        signals = [
            item for item in source.realtime_signals
            if item.freshness == FreshnessStatus.CURRENT
            and item.fresh_until > now
            and item.connector_state.value == "CONNECTED"
            and source.incident_clock.freshness == FreshnessStatus.CURRENT
            and source.incident_clock.fresh_until > now
            and set(item.component_ids).issubset(known_components)
            and set(item.edge_ids).issubset(known_edges)
            and bool(item.evidence_refs)
        ]
        if stage == WorkflowStageV3.INVESTIGATE:
            query_results = [
                item for item in projection.evidence_queries
                if item.stage_run_id == projection.current_attempt.stage_runs[-1].stage_run_id
                and item.query_name == EvidenceQueryNameV3.CURRENT_INCIDENT_SIGNALS
                and item.state == EvidenceQueryStateV3.SUCCEEDED
            ]
            if not query_results:
                return [], [], "investigation_evidence_query_missing", {}
            admitted_refs = {
                ref for result in query_results for ref in result.evidence_refs
            }
            admitted_timestamps = {
                observed_at for result in query_results
                for observed_at in result.observation_timestamps
            }
            signals = [
                item for item in signals
                if set(item.evidence_refs).issubset(admitted_refs)
                and item.observed_at in admitted_timestamps
            ]
        if not signals:
            return [], [], "canonical_current_evidence_missing", {}
        evidence_refs = list(dict.fromkeys(
            ref for signal in signals for ref in signal.evidence_refs
        ))
        if stage == WorkflowStageV3.INVESTIGATE:
            query_edge_ids = {
                edge_id for result in query_results for edge_id in result.edge_ids
            }
            query_refs = list(dict.fromkeys(
                ref for result in query_results for ref in result.evidence_refs
            ))
            query_times = {
                observed_at for result in query_results
                for observed_at in result.observation_timestamps
            }
            evidence_refs = list(dict.fromkeys([*evidence_refs, *query_refs]))
            edge_signals = [item for item in signals if item.edge_ids]
            if (
                not edge_signals
                or len(evidence_refs) < 2
                or len(query_times) < 2
                or not query_edge_ids
            ):
                return [], evidence_refs, "investigation_evidence_coverage_insufficient", {}
        if stage == WorkflowStageV3.DECIDE:
            investigate = next((
                item for item in reversed(projection.current_attempt.stage_runs)
                if item.stage == WorkflowStageV3.INVESTIGATE
                and item.status == WorkflowStageStateV3.SUCCEEDED
                and item.output is not None
            ), None)
            if investigate is None or not investigate.evidence_refs:
                return [], evidence_refs, "decision_investigation_result_missing", {}
        facts = [StageFactV3(
            fact_id="canonical-signal:{}".format(item.signal_id),
            label=item.title,
            value=item.display_value,
            evidence_refs=item.evidence_refs,
        ) for item in signals[:12]]
        details: Dict[str, Any] = {}
        if stage == WorkflowStageV3.TRIAGE:
            impact_refs = list(dict.fromkeys(
                ref for item in signals
                if set(item.component_ids).intersection(set(projection.impacted_path))
                for ref in item.evidence_refs
            )) or evidence_refs
            facts = [
                StageFactV3(
                    fact_id="canonical-triage-severity",
                    label="Evidence-backed severity",
                    value=projection.severity,
                    evidence_refs=impact_refs,
                ),
                StageFactV3(
                    fact_id="canonical-triage-impact",
                    label="Affected user path",
                    value=" -> ".join(projection.impacted_path),
                    evidence_refs=impact_refs,
                ),
                *facts,
            ][:32]
            covered = {
                component
                for item in signals
                for component in item.component_ids
            }
            missing = [
                component for component in projection.impacted_path
                if component not in covered
            ]
            unknowns = [
                "No current signal directly covers component {}.".format(component)
                for component in missing
            ]
            if not any("change" in item.signal_kind.lower() for item in signals):
                unknowns.append("No admitted change event is correlated in the current window.")
            details["unknowns"] = unknowns[:32]
            details["questions"] = ([
                "What new evidence would disambiguate the affected dependency path?"
            ] if not unknowns else [
                "Can the missing component or change evidence be collected before diagnosis?"
            ])
        if stage == WorkflowStageV3.INVESTIGATE:
            facts.append(StageFactV3(
                fact_id="canonical-investigation-coverage",
                label="Independent evidence coverage",
                value="{} evidence records across {} dependency signals".format(
                    len(evidence_refs), len(query_times),
                ),
                evidence_refs=evidence_refs,
            ))
            edge_by_id = {item.edge_id: item for item in projection.graph.edges}
            hypotheses = []
            for edge_id in sorted(query_edge_ids):
                edge = edge_by_id.get(edge_id)
                if edge is None:
                    continue
                supporting = list(dict.fromkeys(
                    ref for item in signals
                    if edge_id in item.edge_ids
                    and item.status == RealtimeSignalStatus.CRITICAL
                    for ref in item.evidence_refs
                ))
                supporting = list(dict.fromkeys([
                    *supporting,
                    *[
                        ref for result in query_results
                        if edge_id in result.edge_ids
                        for ref in result.evidence_refs
                    ],
                ]))
                contradicting = list(dict.fromkeys(
                    ref for item in signals
                    if edge_id in item.edge_ids
                    and item.status != RealtimeSignalStatus.CRITICAL
                    for ref in item.evidence_refs
                ))
                if not supporting:
                    continue
                confidence = min(0.95, 0.55 + 0.05 * len(supporting))
                hypotheses.append(WorkflowHypothesisV3(
                    hypothesis_id=_stable_id(
                        "hypothesis", projection.case_id,
                        projection.current_attempt.stage_runs[-1].stage_run_id,
                        edge_id,
                    ),
                    stage_run_id=projection.current_attempt.stage_runs[-1].stage_run_id,
                    statement=(
                        "The evidenced {} -> {} dependency failure is the leading "
                        "cause of the current impacted path."
                    ).format(edge.source_component_id, edge.target_component_id),
                    confidence=float(confidence),
                    supporting_evidence_refs=supporting,
                    contradicting_evidence_refs=contradicting,
                    falsification_condition=(
                        "A fresh healthy {} -> {} trace while the user-path failure "
                        "continues would falsify this hypothesis."
                    ).format(edge.source_component_id, edge.target_component_id),
                    status="CONTESTED" if contradicting else "SUPPORTED",
                ))
            if not hypotheses:
                return facts, evidence_refs, "investigation_causal_hypothesis_missing", {}
            details["hypotheses"] = hypotheses[:32]
        if stage == WorkflowStageV3.DECIDE:
            candidates = [
                item for item in projection.hypotheses
                if item.stage_run_id in {
                    run.stage_run_id for run in projection.current_attempt.stage_runs
                    if run.stage == WorkflowStageV3.INVESTIGATE
                    and run.status == WorkflowStageStateV3.SUCCEEDED
                }
            ]
            if not candidates:
                return facts, evidence_refs, "decision_supported_hypothesis_missing", {}
            details["root_hypothesis"] = sorted(
                candidates, key=lambda item: (-item.confidence, item.hypothesis_id),
            )[0]
        return facts, evidence_refs, None, details

    async def _run_agent(
        self, projection, *, role: str, actor_subject_id: str,
        run_key: Optional[str] = None,
        context_hypotheses: Optional[List[WorkflowHypothesisV3]] = None,
    ) -> tuple[Any, Optional[GuidedAgentBridgeResponseV3]]:
        current = next(
            item for item in projection.current_attempt.stage_runs
            if item.stage == projection.current_attempt.current_stage
            and item.status != WorkflowStageStateV3.SUPERSEDED
        )
        expected_attempt_id = projection.current_attempt.attempt_id
        expected_stage_run_id = current.stage_run_id
        run_key = run_key or role.lower()
        idempotency_key = "auto-agent:{}:{}".format(current.stage_run_id, run_key)
        command = AgentRunCommandV3(
            attempt_id=projection.current_attempt.attempt_id,
            expected_stage=current.stage,
            expected_workflow_revision=projection.workflow_revision,
            idempotency_key=idempotency_key,
            component_id=(projection.impacted_path[0] if projection.impacted_path else None),
            question="Run the bounded {} review using only canonical evidence.".format(role.lower()),
        )
        agent_run_id = _stable_id(
            "agent-run", projection.case_id, current.stage_run_id, idempotency_key,
        )
        existing = next((
            item for item in projection.agent_activity
            if item.agent_run_id == agent_run_id
        ), None)
        if existing is None:
            receipt = await self.coordinator.start_agent_run(
                projection.tenant_id, projection.case_id, command,
                actor_subject_id, datetime.now(timezone.utc),
                role_override=role.upper(),
            )
            if not any(
                item.agent_run_id == agent_run_id
                for item in receipt.projection.agent_activity
            ):
                raise PolicyViolation("workflow_v3_agent_run_identity_mismatch")
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        agent = next(
            item for item in projection.agent_activity
            if item.agent_run_id == agent_run_id
        )
        if agent.state == AgentRunStateV3.SUCCEEDED:
            return projection, None
        if agent.state != AgentRunStateV3.RUNNING:
            raise GuidedRuntimeStageFailed(
                agent.failure_code or "workflow_v3_agent_already_terminal",
            )
        projection, frozen_request = await self._freeze_agent_request(
            projection,
            agent,
            role,
            hypotheses_override=context_hypotheses,
        )
        try:
            response = await self.bridge.run_agent(frozen_request)
            if response.tool_requests:
                raise PolicyViolation("workflow_v3_agent_tool_request_not_executed")
        except GuidedRuntimeBridgeUnavailable as error:
            if _activity_attempt() < GUIDED_ACTIVITY_MAX_ATTEMPTS:
                # The Node bridge may have durably completed after the HTTP
                # response was lost. Leave the same agent run RUNNING so the
                # next Temporal attempt reuses its stable request id.
                raise
            failure_code = str(error)
            projection = await self._required_stage_projection(
                projection.tenant_id, projection.case_id,
                expected_attempt_id, expected_stage_run_id,
            )
            current_agent = next(
                item for item in projection.agent_activity
                if item.agent_run_id == agent_run_id
            )
            if current_agent.state == AgentRunStateV3.RUNNING:
                projection = await self._persist_with_rebase(lambda: self.coordinator.update_agent_run(
                    projection.tenant_id, projection.case_id, agent_run_id,
                    state=AgentRunStateV3.FAILED,
                    progress_percent=current_agent.progress_percent,
                    summary="Agent provider remained unavailable after bounded reconciliation.",
                    evidence_refs=current_agent.evidence_refs,
                    failure_code=failure_code,
                    now=datetime.now(timezone.utc),
                ))
            raise GuidedRuntimeStageFailed(failure_code) from error
        except Exception as error:
            failure_code = (
                str(error) if isinstance(error, GuidedRuntimeBridgeRejected)
                else type(error).__name__
            )
            projection = await self._required_stage_projection(
                projection.tenant_id, projection.case_id,
                expected_attempt_id, expected_stage_run_id,
            )
            current_agent = next(
                item for item in projection.agent_activity
                if item.agent_run_id == agent_run_id
            )
            if current_agent.state != AgentRunStateV3.RUNNING:
                raise GuidedRuntimeStageFailed(failure_code) from error
            projection = await self._persist_with_rebase(lambda: self.coordinator.update_agent_run(
                projection.tenant_id, projection.case_id, agent_run_id,
                state=AgentRunStateV3.FAILED,
                progress_percent=current_agent.progress_percent,
                summary="Agent provider failed explicitly.",
                evidence_refs=current_agent.evidence_refs,
                failure_code=failure_code,
                now=datetime.now(timezone.utc),
            ))
            raise GuidedRuntimeStageFailed(failure_code) from error
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        current_agent = next(
            item for item in projection.agent_activity
            if item.agent_run_id == agent_run_id
        )
        if current_agent.state == AgentRunStateV3.RUNNING and current_agent.progress_percent < 75:
            projection = await self._persist_with_rebase(lambda: self.coordinator.update_agent_run(
                projection.tenant_id, projection.case_id, agent_run_id,
                state=AgentRunStateV3.RUNNING, progress_percent=75,
                summary="Checking evidence coverage.",
                evidence_refs=response.evidence_refs,
                now=datetime.now(timezone.utc),
            ))
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        current_agent = next(
            item for item in projection.agent_activity
            if item.agent_run_id == agent_run_id
        )
        if current_agent.state == AgentRunStateV3.RUNNING:
            projection = await self._persist_with_rebase(lambda: self.coordinator.update_agent_run(
                projection.tenant_id, projection.case_id, agent_run_id,
                state=AgentRunStateV3.SUCCEEDED, progress_percent=100,
                summary=response.answer,
                evidence_refs=response.evidence_refs,
                now=datetime.now(timezone.utc),
            ))
        projection = await self._required_stage_projection(
            projection.tenant_id, projection.case_id,
            expected_attempt_id, expected_stage_run_id,
        )
        return projection, response

    async def run_stage(
        self, packet_data: Dict[str, Any], *, now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        packet = GuidedStageActivityPacketV3.parse_obj(packet_data)
        now = now or datetime.now(timezone.utc)
        projection = await self.coordinator._required_projection(
            packet.tenant_id, packet.case_id,
        )
        self._required_current(projection, packet)
        current = projection.current_attempt.stage_runs[-1]
        if current.status != WorkflowStageStateV3.RUNNING:
            status = (
                GuidedStageActivityStatusV3.SUCCEEDED
                if current.status == WorkflowStageStateV3.SUCCEEDED
                else GuidedStageActivityStatusV3.FAILED
            )
            return GuidedStageActivityOutcomeV3(
                status=status, projection=projection,
                reason=current.failure_code,
            ).dict()
        if current.progress_percent == 0:
            projection = await self.coordinator.record_stage_progress(
                packet.tenant_id, packet.case_id, progress_percent=10,
                summary="Current stage accepted by Temporal.",
                evidence_refs=self._evidence_refs(projection), now=now,
                expected_stage_run_id=packet.stage_run_id,
            )

        if packet.stage in {
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
        }:
            responses = []
            try:
                if packet.stage == WorkflowStageV3.INVESTIGATE:
                    projection, _ = await self._run_evidence_worker(
                        projection,
                        actor_subject_id=packet.actor_subject_id,
                        query_phase="initial",
                    )
                    projection, response = await self._run_agent(
                        projection, role="investigator",
                        actor_subject_id=packet.actor_subject_id,
                    )
                    responses.append(response)
                    projection, refresh = await self._run_evidence_worker(
                        projection,
                        actor_subject_id=packet.actor_subject_id,
                        query_phase="refresh",
                    )
                    if refresh.triggered_replan:
                        projection, response = await self._run_agent(
                            projection, role="investigator",
                            actor_subject_id=packet.actor_subject_id,
                            run_key="investigator-replan",
                        )
                        responses.append(response)
                    _, _, _, critic_details = await self._canonical_stage_facts(
                        projection, WorkflowStageV3.INVESTIGATE,
                        datetime.now(timezone.utc),
                    )
                    projection, response = await self._run_agent(
                        projection, role="critic",
                        actor_subject_id=packet.actor_subject_id,
                        context_hypotheses=critic_details.get("hypotheses", []),
                    )
                    responses.append(response)
                else:
                    role = {
                        WorkflowStageV3.TRIAGE: "observer",
                        WorkflowStageV3.DECIDE: "evaluator",
                    }[packet.stage]
                    projection, response = await self._run_agent(
                        projection, role=role,
                        actor_subject_id=packet.actor_subject_id,
                    )
                    responses.append(response)
            except GuidedRuntimeBridgeUnavailable:
                # Let Temporal retry the same stage-run packet and stable Node
                # request IDs. The final attempt is converted to an explicit
                # GuidedRuntimeStageFailed by _run_agent.
                raise
            except GuidedRuntimeStageObsolete as error:
                projection = await self.coordinator._required_projection(
                    packet.tenant_id, packet.case_id,
                )
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.WAITING,
                    projection=projection, reason=str(error),
                ).dict()
            except GuidedRuntimeStageFailed as error:
                projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                    packet.tenant_id, packet.case_id, success=False,
                    summary="Agent provider unavailable.", evidence_refs=[],
                    failure_code=str(error), now=datetime.now(timezone.utc),
                    expected_stage_run_id=packet.stage_run_id,
                ))
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.FAILED,
                    projection=projection, reason=str(error),
                ).dict()
            facts, evidence_refs, gate_failure, details = await self._canonical_stage_facts(
                projection, packet.stage, datetime.now(timezone.utc),
            )
            try:
                projection = await self._required_stage_projection(
                    packet.tenant_id, packet.case_id,
                    packet.attempt_id, packet.stage_run_id,
                )
            except GuidedRuntimeStageObsolete as error:
                projection = await self.coordinator._required_projection(
                    packet.tenant_id, packet.case_id,
                )
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.WAITING,
                    projection=projection, reason=str(error),
                ).dict()
            # Investigate must have both the bounded investigator and an
            # independent critic plus a typed server-owned query result.
            if packet.stage == WorkflowStageV3.INVESTIGATE:
                successful_roles = {
                    item.role for item in projection.agent_activity
                    if item.stage_run_id == projection.current_attempt.stage_runs[-1].stage_run_id
                    and item.state == AgentRunStateV3.SUCCEEDED
                }
                if not {
                    "EVIDENCE_WORKER", "INVESTIGATOR", "CRITIC",
                }.issubset(successful_roles):
                    gate_failure = "investigation_worker_or_critic_missing"
            if gate_failure is not None:
                projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                    packet.tenant_id, packet.case_id, success=False,
                    summary="Canonical evidence gate did not pass.",
                    evidence_refs=evidence_refs, failure_code=gate_failure,
                    now=datetime.now(timezone.utc),
                    expected_stage_run_id=packet.stage_run_id,
                ))
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.FAILED,
                    projection=projection, reason=gate_failure,
                ).dict()
            # Model answers stay visible in agent_activity, but the terminal
            # stage output is deterministic and evidence-derived.
            summary = {
                WorkflowStageV3.TRIAGE: "Canonical current signals establish incident scope for investigation.",
                WorkflowStageV3.INVESTIGATE: "Canonical dependency evidence passed investigator and independent critic coverage checks.",
                WorkflowStageV3.DECIDE: "Canonical investigation evidence satisfies the bounded response decision preconditions.",
            }[packet.stage]
            completion: Dict[str, Any] = {}
            if packet.stage == WorkflowStageV3.TRIAGE:
                completion.update(
                    unknowns=details.get("unknowns", []),
                    questions=details.get("questions", []),
                )
            elif packet.stage == WorkflowStageV3.INVESTIGATE:
                completion["hypotheses"] = details["hypotheses"]
            elif packet.stage == WorkflowStageV3.DECIDE:
                root_hypothesis = details["root_hypothesis"]
                preflight_request = GuidedActionPreflightRequestV3(
                    request_id=_stable_id(
                        "action-preflight", projection.case_id,
                        projection.current_attempt.attempt_id,
                        projection.decision_revision + 1,
                    ),
                    case_id=projection.case_id,
                    attempt_id=projection.current_attempt.attempt_id,
                    stage_run_id=projection.current_attempt.stage_runs[-1].stage_run_id,
                    command_id=ALLOWLISTED_ASTRONOMY_COMMAND,
                    target_component_id="checkout",
                    decision_revision=projection.decision_revision + 1,
                )
                try:
                    preflight = await self.bridge.preflight_action(preflight_request)
                except GuidedRuntimeBridgeUnavailable as error:
                    if _activity_attempt() < GUIDED_ACTIVITY_MAX_ATTEMPTS:
                        raise
                    failure_code = str(error)
                    projection = await self.coordinator.complete_current_stage(
                        packet.tenant_id, packet.case_id, success=False,
                        summary="Action preflight remained unavailable after bounded reconciliation.",
                        evidence_refs=evidence_refs,
                        failure_code="decision_preflight_failed:{}".format(failure_code),
                        now=datetime.now(timezone.utc),
                        expected_stage_run_id=packet.stage_run_id,
                    )
                    return GuidedStageActivityOutcomeV3(
                        status=GuidedStageActivityStatusV3.FAILED,
                        projection=projection,
                        reason="decision_preflight_failed",
                    ).dict()
                except Exception as error:
                    failure_code = (
                        str(error) if isinstance(error, GuidedRuntimeBridgeRejected)
                        else type(error).__name__
                    )
                    projection = await self.coordinator.complete_current_stage(
                        packet.tenant_id, packet.case_id, success=False,
                        summary="Action preflight failed explicitly.",
                        evidence_refs=evidence_refs,
                        failure_code="decision_preflight_failed:{}".format(failure_code),
                        now=datetime.now(timezone.utc),
                        expected_stage_run_id=packet.stage_run_id,
                    )
                    return GuidedStageActivityOutcomeV3(
                        status=GuidedStageActivityStatusV3.FAILED,
                        projection=projection,
                        reason="decision_preflight_failed",
                    ).dict()
                try:
                    projection = await self._required_stage_projection(
                        packet.tenant_id, packet.case_id,
                        packet.attempt_id, packet.stage_run_id,
                    )
                except GuidedRuntimeStageObsolete as error:
                    projection = await self.coordinator._required_projection(
                        packet.tenant_id, packet.case_id,
                    )
                    return GuidedStageActivityOutcomeV3(
                        status=GuidedStageActivityStatusV3.WAITING,
                        projection=projection, reason=str(error),
                    ).dict()
                if (
                    not preflight.passed
                    or preflight.observed_variant != preflight.expected_variant
                    or preflight.flag_name != "paymentUnreachable"
                ):
                    projection = await self.coordinator.complete_current_stage(
                        packet.tenant_id, packet.case_id, success=False,
                        summary=preflight.summary,
                        evidence_refs=evidence_refs,
                        failure_code="decision_preflight_preconditions_not_met",
                        now=datetime.now(timezone.utc),
                        expected_stage_run_id=packet.stage_run_id,
                    )
                    return GuidedStageActivityOutcomeV3(
                        status=GuidedStageActivityStatusV3.FAILED,
                        projection=projection,
                        reason="decision_preflight_preconditions_not_met",
                    ).dict()
                conditions = [
                    "At least three fresh healthy post-action samples are observed.",
                    "A fresh Checkout to Payment trace succeeds after execution.",
                    "Error, latency, and request-traffic series recover within the bounded window.",
                ]
                rollback_plan = (
                    "Use the configured safe rollback port if verification fails."
                    if preflight.rollback_supported
                    else "No safe automatic rollback is declared; verification failure requires human recovery."
                )
                candidate = DecisionActionCandidateV3(
                    candidate_id=_stable_id(
                        "candidate", projection.case_id,
                        projection.current_attempt.attempt_id,
                        projection.decision_revision + 1,
                    ),
                    command_id=preflight.command_id,
                    component_id=preflight.target_component_id,
                    title="Restore Payment reachability",
                    summary="Set paymentUnreachable to off and recreate only Checkout.",
                    blast_radius=preflight.blast_radius,
                    risk="Bounded mutation of the exact preflight manifest targets.",
                    rollback_plan=rollback_plan,
                    verification_conditions=conditions,
                    dry_run_state=DecisionDryRunStateV3.PASSED,
                    dry_run_summary=preflight.summary,
                    preflight_receipt_id=preflight.receipt_id,
                    preflight_manifest_hash=preflight.manifest_hash,
                    preflight_checked_at=preflight.checked_at,
                    expected_before="{}={}".format(
                        preflight.flag_name, preflight.expected_variant,
                    ),
                    observed_before="{}={}".format(
                        preflight.flag_name, preflight.observed_variant,
                    ),
                    mutation_targets=preflight.mutation_targets,
                    decision_revision=projection.decision_revision + 1,
                )
                completion.update(
                    root_cause=root_hypothesis.statement,
                    recommendation=candidate.summary,
                    risk=candidate.risk,
                    rollback=candidate.rollback_plan,
                    verification_conditions=conditions,
                    action_candidate=candidate,
                    premise_fingerprint=projection.current_premise_fingerprint,
                )
            projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                packet.tenant_id, packet.case_id, success=True,
                summary=summary, evidence_refs=evidence_refs, facts=facts,
                now=datetime.now(timezone.utc),
                expected_stage_run_id=packet.stage_run_id,
                **completion,
            ))
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.SUCCEEDED,
                projection=projection,
            ).dict()

        if packet.stage == WorkflowStageV3.RESPOND:
            current = projection.current_attempt.stage_runs[-1]
            current_actions = [
                item for item in projection.actions
                if item.attempt_id == projection.current_attempt.attempt_id
                and item.stage_run_id == current.stage_run_id
            ]
            if not current_actions:
                decide_run = next((
                    item for item in reversed(projection.current_attempt.stage_runs)
                    if item.stage == WorkflowStageV3.DECIDE
                    and item.status == WorkflowStageStateV3.SUCCEEDED
                    and item.output is not None
                    and item.output.action_candidate is not None
                ), None)
                if decide_run is None:
                    raise PolicyViolation("workflow_v3_response_decision_candidate_required")
                candidate = decide_run.output.action_candidate
                if candidate.decision_revision != projection.decision_revision:
                    raise PolicyViolation("workflow_v3_action_revalidation_required")
                action = IncidentActionV3(
                    action_id=_stable_id(
                        "action", candidate.candidate_id,
                        projection.current_attempt.attempt_id,
                        current.stage_run_id,
                    ),
                    attempt_id=projection.current_attempt.attempt_id,
                    stage_run_id=current.stage_run_id,
                    title=candidate.title,
                    summary=candidate.summary,
                    component_id=candidate.component_id,
                    command_id=candidate.command_id,
                    command_label=candidate.title,
                    decision_revision=candidate.decision_revision,
                    required_permission="incident:execute",
                    approval_state=ActionApprovalStateV3.PENDING,
                    execution_state=ActionExecutionStateV3.NOT_STARTED,
                    status=IncidentActionStatusV3.AWAITING_APPROVAL,
                    blast_radius=candidate.blast_radius,
                    risk=candidate.risk,
                    rollback_plan=candidate.rollback_plan,
                    verification_conditions=candidate.verification_conditions,
                )
                projection = await self._persist_with_rebase(lambda: self.coordinator.add_action(
                    packet.tenant_id, packet.case_id, action,
                    datetime.now(timezone.utc),
                ))
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.AWAITING_APPROVAL,
                projection=projection,
            ).dict()

        if packet.stage == WorkflowStageV3.VERIFY:
            action = next((
                item for item in projection.actions
                if item.receipt is not None
                and item.receipt.receipt_id == projection.current_attempt.action_receipt_id
            ), None)
            if action is None or action.receipt is None:
                raise PolicyViolation("workflow_v3_verify_action_receipt_required")
            source = await self.repository.realtime_projection(
                packet.tenant_id, packet.case_id,
            )
            checkout_payment_edges = {
                edge.edge_id for edge in projection.graph.edges
                if edge.source_component_id == "checkout"
                and edge.target_component_id == "payment"
            }
            fresh = [] if source is None else [
                signal for signal in source.realtime_signals
                if signal.observed_at > action.receipt.completed_at
                and signal.freshness == FreshnessStatus.CURRENT
                and signal.fresh_until > now
                and signal.connector_state.value == "CONNECTED"
                and signal.status == RealtimeSignalStatus.INFO
                and {"checkout", "payment"}.issubset(set(signal.component_ids))
                and bool(set(signal.edge_ids).intersection(checkout_payment_edges))
                and bool(signal.evidence_refs)
            ]
            series = await self.repository.realtime_series(
                packet.tenant_id, packet.case_id,
            )
            healthy_connector_ids = set() if source is None else {
                item.connector_id for item in source.connector_health
                if item.state.value == "CONNECTED"
                and item.fresh_until is not None
                and item.fresh_until > now
            }
            def category(metric_key: str) -> Optional[str]:
                lowered = metric_key.lower()
                if lowered == "trace.error_indicator" or "error_rate" in lowered:
                    return "error"
                if "duration" in lowered or "latency" in lowered:
                    return "latency"
                if (
                    lowered == "trace.request_rate"
                    or "traffic" in lowered
                    or "request_count" in lowered
                ):
                    return "traffic"
                return None

            categorized: Dict[str, List[Any]] = {
                "error": [], "latency": [], "traffic": [],
            }
            for metric in series.series:
                metric_category = category(metric.metric_key)
                if (
                    metric_category is None
                    or metric.freshness != FreshnessStatus.CURRENT
                    or metric.source_connector_id not in healthy_connector_ids
                ):
                    continue
                points = [
                    point for point in metric.points
                    if point.timestamp > action.receipt.completed_at
                    and point.interval_start_at is not None
                    and point.interval_start_at >= action.receipt.completed_at
                    and point.freshness == FreshnessStatus.CURRENT
                    and point.value is not None
                    and point.evidence_refs
                ]
                if len(points) >= 3:
                    categorized[metric_category].append((metric, points))

            selected = {}
            for name, candidates in categorized.items():
                if candidates:
                    selected[name] = sorted(
                        candidates,
                        # Prefer the incident-bound Collector histogram over
                        # trace-derived fallback indicators whenever both have
                        # a complete post-action window.
                        key=lambda item: (
                            item[0].metric_key.startswith("checkout.payment."),
                            item[1][-1].timestamp,
                            item[0].series_id,
                        ),
                        reverse=True,
                    )[0]

            def latest_three_healthy(name: str, metric, points) -> bool:
                recent = points[-3:]
                if name in {"error", "latency"}:
                    recovery_threshold = metric.thresholds.warning
                    if recovery_threshold is None:
                        return False
                    return all(
                        point.value < recovery_threshold for point in recent
                    )
                if name == "traffic":
                    return all(point.value > 0 for point in recent)
                return False

            all_post_points = [
                point for _, points in selected.values() for point in points
            ]
            distinct_samples = {point.timestamp for point in all_post_points}
            bounded_window = False
            if distinct_samples:
                window_seconds = (
                    max(distinct_samples) - min(distinct_samples)
                ).total_seconds()
                bounded_window = 4 <= window_seconds <= 300
            metrics_recovered = (
                set(selected) == {"error", "latency", "traffic"}
                and all(
                    latest_three_healthy(name, metric, points)
                    for name, (metric, points) in selected.items()
                )
            )
            observation_complete = (
                len(distinct_samples) >= 3
                and bounded_window
                and metrics_recovered
            )
            if fresh and observation_complete and packet.verification_deadline_reached:
                observed_at = max(item.observed_at for item in fresh)
                evidence_refs = list(dict.fromkeys(
                    [ref for signal in fresh for ref in signal.evidence_refs]
                    + [ref for point in all_post_points for ref in point.evidence_refs]
                ))
                metric_facts = []
                for name, (metric, points) in selected.items():
                    pre_points = [
                        point for point in metric.points
                        if point.timestamp <= action.receipt.completed_at
                        and point.value is not None
                    ]
                    post_average = sum(point.value for point in points[-3:]) / 3
                    comparison = "post={:.6g} {}".format(post_average, metric.unit)
                    if pre_points:
                        pre_window = pre_points[-3:]
                        pre_average = sum(point.value for point in pre_window) / len(pre_window)
                        comparison = "pre={:.6g}, post={:.6g} {}".format(
                            pre_average, post_average, metric.unit,
                        )
                    metric_facts.append(StageFactV3(
                        fact_id="verified-series:{}".format(metric.series_id),
                        label="{} recovery ({})".format(metric.label, name),
                        value=comparison,
                        evidence_refs=list(dict.fromkeys(
                            ref for point in points[-3:] for ref in point.evidence_refs
                        )),
                    ))
                projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                    packet.tenant_id, packet.case_id, success=True,
                    summary="Fresh post-action Checkout to Payment telemetry recovered.",
                    evidence_refs=evidence_refs,
                    evidence_observed_at=observed_at,
                    facts=[StageFactV3(
                        fact_id=signal.signal_id,
                        label=signal.title,
                        value=signal.display_value,
                        evidence_refs=signal.evidence_refs,
                    ) for signal in fresh[:12]] + metric_facts,
                    now=datetime.now(timezone.utc),
                    expected_stage_run_id=packet.stage_run_id,
                ))
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.SUCCEEDED,
                    projection=projection,
                ).dict()
            if not packet.verification_deadline_reached:
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.WAITING,
                    projection=projection,
                    reason="waiting_for_post_action_observation_window",
                ).dict()
            projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                packet.tenant_id, packet.case_id, success=False,
                summary="Verification window expired without a healthy post-action trace.",
                evidence_refs=[], failure_code="verification_window_expired",
                now=datetime.now(timezone.utc),
                expected_stage_run_id=packet.stage_run_id,
            ))
            rollback_request = GuidedActionBridgeRequestV3(
                execution_key=_stable_id(
                    "action-rollback", packet.case_id, action.action_id,
                    action.decision_revision,
                ),
                action_id=action.action_id,
                attempt_id=action.attempt_id,
                command_id=action.command_id,
                decision_revision=action.decision_revision,
            )
            try:
                rollback_result = GuidedRollbackBridgeResponseV3.parse_obj(
                    await self.bridge.rollback_action(rollback_request),
                )
                if (
                    rollback_result.execution_key != rollback_request.execution_key
                    or rollback_result.action_id != rollback_request.action_id
                    or rollback_result.command_id != rollback_request.command_id
                ):
                    raise PolicyViolation("workflow_v3_safe_rollback_scope_mismatch")
                rollback_succeeded = True
                rollback_summary = rollback_result.output_summary
                rollback_receipt = ActionRollbackReceiptV3.parse_obj({
                    **rollback_result.dict(),
                    "schema_version": "flowpulse.action-rollback-receipt.v3",
                })
            except Exception as error:
                rollback_succeeded = False
                rollback_summary = "Safe rollback unavailable or failed: {}".format(
                    str(error),
                )
                rollback_receipt = None
            projection = await self._persist_with_rebase(lambda: self.coordinator.record_action_rollback_outcome(
                packet.tenant_id, packet.case_id, action.action_id,
                succeeded=rollback_succeeded,
                summary=rollback_summary,
                rollback_receipt=rollback_receipt,
                now=datetime.now(timezone.utc),
            ))
            if rollback_succeeded:
                return GuidedStageActivityOutcomeV3(
                    status=GuidedStageActivityStatusV3.NEEDS_HUMAN,
                    projection=projection,
                    reason="verification_failed_action_rolled_back",
                ).dict()
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.NEEDS_HUMAN,
                projection=projection,
                reason="workflow_v3_safe_rollback_unavailable_or_failed",
            ).dict()

        raise PolicyViolation("workflow_v3_stage_activity_unsupported")

    async def run_existing_agent(
        self, packet_data: Dict[str, Any], *, now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        packet = GuidedAgentActivityPacketV3.parse_obj(packet_data)
        projection = await self.coordinator._required_projection(
            packet.tenant_id, packet.case_id,
        )
        self._required_current(projection, packet)
        agent = next((
            item for item in projection.agent_activity
            if item.agent_run_id == packet.agent_run_id
        ), None)
        if agent is None:
            raise PolicyViolation("workflow_v3_agent_run_not_found")
        if agent.state == AgentRunStateV3.SUCCEEDED:
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.SUCCEEDED,
                projection=projection,
            ).dict()
        if agent.state != AgentRunStateV3.RUNNING:
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.FAILED,
                projection=projection, reason=agent.failure_code,
            ).dict()
        role = agent.role.lower()
        try:
            projection, frozen_request = await self._freeze_agent_request(
                projection,
                agent,
                role,
                now=now,
            )
            response = await self.bridge.run_agent(frozen_request)
            if response.tool_requests:
                raise PolicyViolation("workflow_v3_agent_tool_request_not_executed")
            projection = await self._persist_with_rebase(lambda: self.coordinator.update_agent_run(
                packet.tenant_id, packet.case_id, agent.agent_run_id,
                state=AgentRunStateV3.SUCCEEDED, progress_percent=100,
                summary=response.answer, evidence_refs=response.evidence_refs,
                now=datetime.now(timezone.utc),
            ))
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.SUCCEEDED,
                projection=projection,
            ).dict()
        except GuidedRuntimeBridgeUnavailable as error:
            if _activity_attempt() < GUIDED_ACTIVITY_MAX_ATTEMPTS:
                raise
            failure_code = str(error)
        except Exception as error:
            failure_code = (
                str(error) if isinstance(error, GuidedRuntimeBridgeRejected)
                else type(error).__name__
            )
        projection = await self.coordinator._required_projection(
            packet.tenant_id, packet.case_id,
        )
        current_agent = next(
            item for item in projection.agent_activity
            if item.agent_run_id == packet.agent_run_id
        )
        if current_agent.state == AgentRunStateV3.RUNNING:
            projection = await self.coordinator.update_agent_run(
                packet.tenant_id, packet.case_id, packet.agent_run_id,
                state=AgentRunStateV3.FAILED,
                progress_percent=current_agent.progress_percent,
                summary="Agent provider failed explicitly.",
                evidence_refs=current_agent.evidence_refs,
                failure_code=failure_code, now=datetime.now(timezone.utc),
            )
        return GuidedStageActivityOutcomeV3(
            status=GuidedStageActivityStatusV3.FAILED,
            projection=projection, reason=failure_code,
        ).dict()

    async def execute_action(
        self, packet_data: Dict[str, Any], *, now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        packet = GuidedActionActivityPacketV3.parse_obj(packet_data)
        now = now or datetime.now(timezone.utc)
        projection = await self.coordinator._required_projection(
            packet.tenant_id, packet.case_id,
        )
        self._required_current(projection, packet)
        action = next((
            item for item in projection.actions if item.action_id == packet.action_id
        ), None)
        if action is None or action.command_id != ALLOWLISTED_ASTRONOMY_COMMAND:
            raise PolicyViolation("workflow_v3_action_not_allowlisted")
        if (
            action.attempt_id != projection.current_attempt.attempt_id
            or action.stage_run_id != packet.stage_run_id
        ):
            raise PolicyViolation("workflow_v3_action_execution_scope_mismatch")
        if action.decision_revision != projection.decision_revision:
            raise PolicyViolation("workflow_v3_action_revalidation_required")
        current_run = projection.current_attempt.stage_runs[-1]
        if action.receipt is not None:
            if (
                action.receipt.status == ActionExecutionStateV3.SUCCEEDED
                and current_run.status == WorkflowStageStateV3.RUNNING
            ):
                projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                    packet.tenant_id, packet.case_id, success=True,
                    summary=action.receipt.output_summary, evidence_refs=[],
                    facts=[StageFactV3(
                        fact_id=action.receipt.receipt_id,
                        label="Execution receipt",
                        value=action.receipt.output_summary,
                        evidence_refs=[],
                    )],
                    now=datetime.now(timezone.utc),
                    expected_stage_run_id=packet.stage_run_id,
                ))
            status = (
                GuidedStageActivityStatusV3.SUCCEEDED
                if action.receipt.status == ActionExecutionStateV3.SUCCEEDED
                else GuidedStageActivityStatusV3.NEEDS_HUMAN
                if action.receipt.status == ActionExecutionStateV3.NEEDS_HUMAN
                else GuidedStageActivityStatusV3.FAILED
            )
            return GuidedStageActivityOutcomeV3(
                status=status, projection=projection,
                reason=None if status == GuidedStageActivityStatusV3.SUCCEEDED else "action_execution_terminal",
            ).dict()
        projection = await self._persist_with_rebase(lambda: self.coordinator.mark_action_execution_started(
            packet.tenant_id, packet.case_id, packet.action_id, now=now,
        ))
        action = next(item for item in projection.actions if item.action_id == packet.action_id)
        execution_key = _stable_id(
            "action-execution", packet.case_id, action.attempt_id,
            action.action_id, action.decision_revision,
        )
        request = GuidedActionBridgeRequestV3(
            execution_key=execution_key,
            action_id=action.action_id,
            attempt_id=action.attempt_id,
            command_id=action.command_id,
            decision_revision=action.decision_revision,
        )
        terminal_error = None
        ambiguous = False
        try:
            external = await self.bridge.execute_action(request)
            receipt = ActionExecutionReceiptV3(
                receipt_id=_stable_id("receipt", execution_key),
                executor_id="astronomy-local-node-adapter",
                command_id=external.command_id,
                status=ActionExecutionStateV3.SUCCEEDED,
                started_at=external.started_at,
                completed_at=external.completed_at,
                output_summary=external.output_summary,
                rollback_status="NOT_CONFIGURED",
            )
        except GuidedRuntimeBridgeUnavailable as error:
            if _activity_attempt() < GUIDED_ACTIVITY_MAX_ATTEMPTS:
                # Do not manufacture a failure after an HTTP response loss.
                # Temporal retries this exact packet; Node reconciles the same
                # execution_key from its append-only receipt ledger.
                raise
            terminal_error = str(error)
            ambiguous = True
        except GuidedRuntimeBridgeRejected as error:
            terminal_error = error.code
            ambiguous = error.code == "guided_action_reconciliation_requires_human"
        except Exception as error:
            terminal_error = type(error).__name__
            ambiguous = False
        if terminal_error is not None:
            completed_at = datetime.now(timezone.utc)
            receipt = ActionExecutionReceiptV3(
                receipt_id=_stable_id("receipt", execution_key),
                executor_id="astronomy-local-node-adapter",
                command_id=action.command_id,
                status=(
                    ActionExecutionStateV3.NEEDS_HUMAN
                    if ambiguous else ActionExecutionStateV3.FAILED
                ),
                started_at=now,
                completed_at=completed_at,
                output_summary=(
                    "Action result is ambiguous after bounded durable reconciliation: {}"
                    if ambiguous else "Action executor rejected the request explicitly: {}"
                ).format(terminal_error),
                rollback_status="REQUIRES_HUMAN" if ambiguous else "NOT_ATTEMPTED",
            )
        projection = await self._persist_with_rebase(lambda: self.coordinator.record_action_execution(
            packet.tenant_id, packet.case_id, packet.action_id,
            receipt, now=datetime.now(timezone.utc),
        ))
        if receipt.status == ActionExecutionStateV3.SUCCEEDED:
            projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                packet.tenant_id, packet.case_id, success=True,
                summary=receipt.output_summary, evidence_refs=[],
                facts=[StageFactV3(
                    fact_id=receipt.receipt_id,
                    label="Execution receipt",
                    value=receipt.output_summary,
                    evidence_refs=[],
                )],
                now=datetime.now(timezone.utc),
                expected_stage_run_id=packet.stage_run_id,
            ))
            status = GuidedStageActivityStatusV3.SUCCEEDED
        elif receipt.status == ActionExecutionStateV3.NEEDS_HUMAN:
            projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                packet.tenant_id, packet.case_id, success=False,
                summary=receipt.output_summary, evidence_refs=[],
                failure_code="action_execution_result_ambiguous",
                now=datetime.now(timezone.utc),
                expected_stage_run_id=packet.stage_run_id,
            ))
            escalation = WorkflowEscalationCommandV3(
                attempt_id=projection.current_attempt.attempt_id,
                expected_stage=projection.current_attempt.current_stage,
                expected_workflow_revision=projection.workflow_revision,
                idempotency_key="action-needs-human:{}".format(action.action_id),
                reason=receipt.output_summary,
            )
            projection = (await self.coordinator.escalate(
                packet.tenant_id, packet.case_id, escalation,
                "flowpulse-worker", datetime.now(timezone.utc),
            )).projection
            status = GuidedStageActivityStatusV3.NEEDS_HUMAN
        else:
            projection = await self._persist_with_rebase(lambda: self.coordinator.complete_current_stage(
                packet.tenant_id, packet.case_id, success=False,
                summary=receipt.output_summary, evidence_refs=[],
                failure_code="action_execution_failed",
                now=datetime.now(timezone.utc),
                expected_stage_run_id=packet.stage_run_id,
            ))
            status = GuidedStageActivityStatusV3.FAILED
        return GuidedStageActivityOutcomeV3(
            status=status, projection=projection,
            reason=(
                None if status == GuidedStageActivityStatusV3.SUCCEEDED
                else "action_execution_result_ambiguous"
                if status == GuidedStageActivityStatusV3.NEEDS_HUMAN
                else "action_execution_failed"
            ),
        ).dict()

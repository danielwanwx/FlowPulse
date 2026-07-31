"""Temporal activities that turn immutable connector facts into V2 transitions."""

from datetime import timedelta
from typing import Any, Dict, List

from .models import (
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    ProofScope,
    SourceKind,
)
from .policy import PolicyViolation
from .realtime_models import (
    AgentActivity,
    AgentActivityState,
    AgentRole,
    AgentWorkspace,
    ConnectorDispatchState,
    ConnectorHealthState,
    ConnectorPollResult,
    ConnectorProvider,
    ConnectorTruthLabel,
    RealtimeDeliveryMode,
    RealtimeEventType,
    GraphPulse,
    IncidentClock,
    IncidentClockState,
    IncidentProjectionV2,
    RealtimeCitation,
    RealtimeCommit,
    RealtimeCommitActivityPacket,
    RealtimeFreshnessExpiryActivityOutcome,
    RealtimeFreshnessExpiryActivityPacket,
    RealtimeFreshnessTimerLoadPacket,
    RealtimeIncidentEvent,
    RealtimePollActivityPacket,
    RealtimeSignal,
    RealtimeSignalStatus,
    RealtimeUpdateOutcome,
    TemporalFreshnessTimer,
)
from .workspace_models import IncidentEvent, IncidentProjection, ProjectionState
from .realtime_observability import realtime_telemetry


def realtime_signal_presentation(source, component_label: str):
    """Return a truthful title/kind for the admitted telemetry class."""
    if source.provider != ConnectorProvider.OTEL:
        return (
            "{} error rate".format(component_label),
            source.metric_key.upper().replace(".", "_"),
        )
    metric_titles = {
        "checkout.payment.error_rate": "Checkout to Payment error rate",
        "checkout.payment.mean_latency": "Checkout to Payment mean latency",
        "checkout.payment.request_count": "Checkout to Payment request count",
        "log.severity_number": "{} log severity".format(component_label),
    }
    if source.event_kind == "TRACE_PARENT_CHILD_OBSERVED":
        return "{} dependency trace".format(component_label), "TRACE_STATUS"
    if source.event_kind == "TRACE_COMPONENT_ERROR_OBSERVED":
        return "{} client error".format(component_label), "TRACE_STATUS"
    if source.event_kind == "LOG_RECORD_OBSERVED":
        return metric_titles["log.severity_number"], "LOG_RECORD"
    return (
        metric_titles.get(
            source.metric_key,
            "{} metric".format(component_label),
        ),
        source.metric_key.upper().replace(".", "_"),
    )


def realtime_activity_surface() -> List[str]:
    return [
        "workspace_poll_realtime_connector_activity",
        "workspace_load_realtime_dispatch_activity",
        "workspace_commit_realtime_source_event_activity",
        "workspace_load_realtime_freshness_timer_activity",
        "workspace_expire_realtime_freshness_activity",
    ]


def build_realtime_activities(dispatcher: "RealtimeActivityDispatcher") -> List[Any]:
    from temporalio import activity
    from temporalio.exceptions import ApplicationError

    def definition(name: str):
        @activity.defn(name=name)
        async def run(packet: Dict[str, Any]) -> Dict[str, Any]:
            try:
                return await dispatcher.dispatch(name, packet)
            except (PolicyViolation, ValueError) as error:
                raise ApplicationError(str(error), non_retryable=True) from error
        return run

    return [definition(name) for name in realtime_activity_surface()]


def _binding_matches(projection: IncidentProjection, command) -> bool:
    return (
        projection.tenant_id == command.tenant_id
        and projection.case_id == command.case_id
        and projection.incident_id == command.incident_id
        and projection.run_id == command.run_id
        and projection.topology_revision == command.topology_revision
    )


class RealtimeActivityDispatcher:
    def __init__(self, repository: Any, adapters: Dict[str, Any]) -> None:
        self.repository = repository
        self.adapters = dict(adapters)

    async def dispatch(self, name: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        if name in {
            "workspace_poll_realtime_connector_activity",
            "workspace_load_realtime_dispatch_activity",
        }:
            packet = RealtimePollActivityPacket.parse_obj(packet_data)
            if not _binding_matches(packet.projection, packet.command):
                raise PolicyViolation("realtime_poll_projection_binding_mismatch")
            if not await self.repository.workspace_subject_authorized(
                packet.command.tenant_id,
                packet.command.case_id,
                packet.command.actor_subject_id,
            ):
                raise PolicyViolation("realtime_poll_subject_not_authorized")
            if name == "workspace_load_realtime_dispatch_activity":
                result = await self.repository.load_connector_fact_family(
                    packet.command.tenant_id,
                    packet.command.source_event_id,
                    packet.command.dispatch_id,
                )
            else:
                adapter = self.adapters.get(packet.command.connector_id)
                if adapter is None:
                    raise PolicyViolation("realtime_connector_unavailable")
                result = await adapter.poll(
                    packet.projection,
                    acl_subjects=[packet.command.actor_subject_id],
                )
            if not result.accepted or result.source_event is None:
                raise PolicyViolation(
                    result.reason_code or "realtime_connector_unavailable",
                )
            if (
                result.source_event.tenant_id != packet.command.tenant_id
                or result.source_event.case_id != packet.command.case_id
                or result.source_event.run_id != packet.command.run_id
            ):
                raise PolicyViolation("realtime_poll_source_binding_mismatch")
            return result.dict()

        if name == "workspace_commit_realtime_source_event_activity":
            packet = RealtimeCommitActivityPacket.parse_obj(packet_data)
            if not _binding_matches(packet.projection, packet.command):
                raise PolicyViolation("realtime_commit_projection_binding_mismatch")
            commit = self._build_commit(packet)
            with realtime_telemetry.span(
                commit.source_event.provider.value,
                "commit",
                {
                    "delivery_id": commit.source_event.delivery_id,
                    "source_event_id": commit.source_event.source_event_id,
                    "case_id": commit.source_event.case_id,
                    "run_id": commit.source_event.run_id,
                    "workflow_run_id": commit.projection.workflow_run_id,
                },
            ):
                stored = await self.repository.commit_realtime_transition(commit)
            if hasattr(self.repository, "workspace_projection_v3"):
                from .workspace_v3_guided import GuidedWorkflowCoordinatorV3
                coordinator = GuidedWorkflowCoordinatorV3(self.repository)
                existing = await self.repository.workspace_projection_v3(
                    stored.projection.tenant_id, stored.projection.case_id,
                )
                if existing is None and stored.projection.impacted_path:
                    # The first impact-bearing fact creates Detect. Later facts
                    # refresh telemetry without behaving like a user command.
                    await coordinator.bootstrap(
                        stored.projection,
                        actor_subject_id=stored.source_event.acl_subjects[0],
                        now=stored.events[-1].occurred_at,
                    )
                else:
                    await coordinator.sync_realtime(
                        stored.projection,
                        actor_subject_id=stored.source_event.acl_subjects[0],
                        now=stored.events[-1].occurred_at,
                    )
            return RealtimeUpdateOutcome(
                accepted=True,
                projection=stored.projection,
                workspace_projection=stored.v1_projection,
                source_event_id=stored.source_event.source_event_id,
                transition_key=stored.transition_key,
            ).dict()

        if name == "workspace_load_realtime_freshness_timer_activity":
            packet = RealtimeFreshnessTimerLoadPacket.parse_obj(packet_data)
            command = packet.command
            if (
                command.source_event_id != packet.committed_source_event_id
                or not command.source_event_id
            ):
                raise PolicyViolation(
                    "realtime_freshness_timer_source_identity_mismatch",
                )
            deadline = await self.repository.latest_freshness_deadline(
                command.tenant_id, command.case_id, command.connector_id,
            )
            if (
                deadline is None
                or deadline.source_event_id != packet.committed_source_event_id
            ):
                raise RuntimeError("realtime_freshness_deadline_not_durable")
            return TemporalFreshnessTimer(
                deadline=deadline,
                actor_subject_id=command.actor_subject_id,
            ).dict()

        if name == "workspace_expire_realtime_freshness_activity":
            packet = RealtimeFreshnessExpiryActivityPacket.parse_obj(packet_data)
            expected = packet.deadline
            current = await self.repository.latest_freshness_deadline(
                expected.tenant_id, expected.case_id, expected.connector_id,
            )
            if current is None:
                return RealtimeFreshnessExpiryActivityOutcome(
                    expired=False,
                    reason="realtime_freshness_deadline_missing",
                ).dict()
            exact_armed = current == expected
            exact_expired = (
                current.source_event_id == expected.source_event_id
                and current.deadline == expected.deadline
                and current.deadline_revision == expected.deadline_revision + 1
                and current.state.value == "EXPIRED"
            )
            if exact_armed:
                await self.repository.expire_freshness_deadlines(
                    packet.fired_at,
                    tenant_id=expected.tenant_id,
                    case_id=expected.case_id,
                    connector_id=expected.connector_id,
                    expected_deadline_revision=expected.deadline_revision,
                    expected_source_event_id=expected.source_event_id,
                )
                current = await self.repository.latest_freshness_deadline(
                    expected.tenant_id, expected.case_id, expected.connector_id,
                )
                exact_expired = bool(
                    current is not None
                    and current.source_event_id == expected.source_event_id
                    and current.deadline == expected.deadline
                    and current.deadline_revision == expected.deadline_revision + 1
                    and current.state.value == "EXPIRED"
                )
            if not exact_expired:
                return RealtimeFreshnessExpiryActivityOutcome(
                    expired=False,
                    reason="realtime_freshness_deadline_superseded",
                    deadline=current,
                ).dict()
            projection = await self.repository.realtime_projection(
                expected.tenant_id, expected.case_id,
            )
            workspace_projection = await self.repository.workspace_projection(
                expected.tenant_id, expected.case_id,
            )
            if projection is None or workspace_projection is None:
                raise RuntimeError("realtime_freshness_expiry_projection_missing")
            if hasattr(self.repository, "workspace_projection_v3"):
                from .workspace_v3_guided import GuidedWorkflowCoordinatorV3
                coordinator = GuidedWorkflowCoordinatorV3(self.repository)
                existing = await self.repository.workspace_projection_v3(
                    expected.tenant_id, expected.case_id,
                )
                if existing is not None:
                    await coordinator.sync_realtime(
                        projection,
                        actor_subject_id=packet.actor_subject_id,
                        now=packet.fired_at,
                    )
            return RealtimeFreshnessExpiryActivityOutcome(
                expired=True,
                deadline=current,
                projection=projection,
                workspace_projection=workspace_projection,
            ).dict()
        raise RuntimeError("realtime_activity_unknown")

    @staticmethod
    def validate_activity_sequence(states: List[AgentActivityState]) -> None:
        if states not in (
            [AgentActivityState.STARTED, AgentActivityState.COMPLETED],
            [AgentActivityState.STARTED, AgentActivityState.DEGRADED],
        ):
            raise ValueError("activity_state_sequence_invalid")

    def _build_commit(self, packet: RealtimeCommitActivityPacket) -> RealtimeCommit:
        prior = packet.projection
        source = packet.poll_result.source_event
        health = packet.poll_result.health
        dispatch = packet.poll_result.dispatch
        if source is None or dispatch is None or packet.poll_result.receipt is None:
            raise PolicyViolation("realtime_commit_authoritative_fact_family_missing")
        expected_health = (
            ConnectorHealthState.CONNECTED
            if source.freshness == FreshnessStatus.CURRENT
            else ConnectorHealthState.STALE
        )
        if (
            source.tenant_id != prior.tenant_id
            or source.case_id != prior.case_id
            or source.incident_id != prior.incident_id
            or source.run_id != prior.run_id
            or source.topology_revision != prior.topology_revision
            or health.state != expected_health
            or health.connector_id != source.connector_id
        ):
            raise PolicyViolation("realtime_commit_source_health_binding_mismatch")
        known_nodes = {node.component_id: node for node in prior.graph.nodes}
        known_edges = {edge.edge_id for edge in prior.graph.edges}
        if not set(source.component_ids).issubset(known_nodes):
            raise PolicyViolation("realtime_source_component_not_canonical")
        if not set(source.edge_ids).issubset(known_edges):
            raise PolicyViolation("realtime_source_edge_not_canonical")

        evidence_id = "evidence-realtime-" + source.normalization_hash[:24]
        evidence = EvidenceEnvelope(
            evidence_id=evidence_id,
            case_id=source.case_id,
            case_revision=prior.case_revision,
            tenant_id=source.tenant_id,
            acl_subjects=source.acl_subjects,
            source_kind=(
                SourceKind.LOG
                if source.event_kind == "LOG_RECORD_OBSERVED"
                else SourceKind.METRIC
                if (
                    source.provider == ConnectorProvider.PROMETHEUS
                    or source.event_kind == "METRIC_OBSERVED"
                )
                else SourceKind.TRACE
            ),
            source_uri="connector://{}/{}".format(
                source.connector_id, source.provider_event_id,
            ),
            source_anchor=source.provider_event_id,
            observed_at=source.observed_at,
            effective_at=source.effective_at,
            source_version=source.normalizer_version,
            content_hash=source.raw_content_hash,
            authority=source.authority,
            freshness=source.freshness,
            independence_key="connector:{}:{}".format(
                source.connector_id, source.source_event_id,
            ),
            schema_binding=source.schema_version,
            proof_scope=source.proof_scope,
            raw_artifact_key=source.raw_artifact_ref,
            adapter_version=health.adapter_version,
        )
        prior_realtime = packet.prior_realtime_projection
        expired_pulses = [
            item for item in (
                prior_realtime.active_graph_pulses if prior_realtime else []
            )
            if item.expires_at <= health.checked_at
        ]
        expiration_start_sequence = packet.first_event_sequence
        next_sequence = expiration_start_sequence + len(expired_pulses)
        projection_revision = prior.projection_revision + 1
        evidence_revision = prior.evidence_revision + 1
        connector_revision = health.health_revision
        source_revision = (
            packet.prior_realtime_projection.source_revision + 1
            if packet.prior_realtime_projection else 1
        )
        signal_id = "signal-" + source.normalization_hash[:24]
        citation_id = "citation-" + source.normalization_hash[:24]
        pulse_id = "pulse-" + source.normalization_hash[:24]
        activity_id = "agent-activity-" + source.normalization_hash[:24]
        source_label = "Prometheus" if source.provider == ConnectorProvider.PROMETHEUS else "OpenTelemetry"
        component_label = known_nodes[source.component_ids[0]].display_name
        signal_title, signal_kind = realtime_signal_presentation(
            source, component_label,
        )
        fresh_until = source.observed_at + timedelta(
            seconds=packet.poll_result.registration.freshness_sla_seconds,
        )
        signal = RealtimeSignal(
            signal_id=signal_id,
            source_event_id=source.source_event_id,
            provider=source.provider,
            source_label=source_label,
            signal_kind=signal_kind,
            title=signal_title,
            display_value=source.display_value,
            status=source.signal_status,
            trend=source.trend,
            component_ids=source.component_ids,
            edge_ids=source.edge_ids,
            observed_at=source.observed_at,
            fresh_until=fresh_until,
            freshness=source.freshness,
            authority=source.authority,
            evidence_refs=[evidence_id],
            citation_refs=[citation_id],
            connector_state=health.state,
            sequence=next_sequence + 2,
        )
        citation = RealtimeCitation(
            citation_id=citation_id,
            provider=source.provider,
            evidence_id=evidence_id,
            source_event_id=source.source_event_id,
            label="{} signal at {}".format(
                component_label, source.observed_at.strftime("%H:%M UTC"),
            ),
            observed_at=source.observed_at,
            freshness=source.freshness,
            safe_detail_path="/v2/incidents/{}/evidence/{}".format(
                source.case_id, evidence_id,
            ),
        )
        pulse = None
        if (
            source.edge_ids
            and (
                (
                    source.provider == ConnectorProvider.OTEL
                    and source.event_kind in {
                        "TRACE_PARENT_CHILD_OBSERVED",
                        "TRACE_COMPONENT_ERROR_OBSERVED",
                    }
                )
                # Preserve the frozen V2 deterministic contract only. LIVE
                # metrics never create path activity in V3.
                or source.truth_label == ConnectorTruthLabel.TEST_DETERMINISTIC
            )
            and source.freshness == FreshnessStatus.CURRENT
            and source.delivery_mode == RealtimeDeliveryMode.LIVE
        ):
            pulse = GraphPulse(
                pulse_id=pulse_id,
                source_event_id=source.source_event_id,
                event_sequence=next_sequence + 4,
                edge_ids=source.edge_ids,
                component_ids=source.component_ids,
                pulse_kind="BOUND_EDGE_ACTIVITY",
                severity=source.signal_status,
                started_at=health.checked_at,
                expires_at=health.checked_at + timedelta(seconds=10),
                evidence_refs=[evidence_id],
            )
        started_activity = AgentActivity(
            activity_id=activity_id + ":started",
            activity_key=activity_id,
            state_revision=1,
            sequence=next_sequence + 3,
            role=AgentRole.MONITOR,
            state=AgentActivityState.STARTED,
            trigger="CONNECTOR_EVENT",
            capability=packet.poll_result.registration.capabilities[0],
            capability_version=health.adapter_version,
            tool_label="{} metrics".format(source_label),
            component_ids=source.component_ids,
            started_at=source.received_at,
            summary="Reading admitted {} evidence.".format(component_label),
            source_event_ids=[source.source_event_id],
            evidence_refs=[evidence_id],
            citation_refs=[citation_id],
            truth_label=source.truth_label,
            external_write_performed=False,
        )
        final_state = (
            AgentActivityState.COMPLETED
            if source.freshness == FreshnessStatus.CURRENT
            else AgentActivityState.DEGRADED
        )
        final_sequence = next_sequence + (5 if pulse is not None else 4)
        completed_activity = started_activity.copy(update={
            "activity_id": activity_id + ":final",
            "state_revision": 2,
            "sequence": final_sequence,
            "state": final_state,
            "completed_at": health.checked_at,
            "summary": (
                "Observed a current {} operational signal.".format(component_label)
                if final_state == AgentActivityState.COMPLETED
                else "Observed stale {} evidence; no current diagnosis advanced.".format(
                    component_label,
                )
            ),
            "degraded_code": (
                None
                if final_state == AgentActivityState.COMPLETED
                else "freshness_sla_exceeded"
            ),
        })
        self.validate_activity_sequence([
            started_activity.state, completed_activity.state,
        ])
        signals = list(prior_realtime.realtime_signals) if prior_realtime else []
        signals = [
            item for item in signals
            if (
                item.freshness != FreshnessStatus.CURRENT
                or item.fresh_until > health.checked_at
            )
        ]
        signals = [item for item in signals if item.signal_id != signal.signal_id]
        signals.append(signal)
        # A realtime projection is a current-state view, not a severity-sorted
        # sample log. Collapse every logical telemetry stream to its newest
        # admitted observation before prioritizing the bounded UI surface.
        # Otherwise an older critical sample can mask a newer healthy sample
        # for the entire freshness window and repeated trace samples can evict
        # the independent metric streams required by Detect and Verify.
        latest_by_stream = {}
        for item in signals:
            stream_key = (
                item.provider.value,
                item.signal_kind,
                tuple(sorted(item.component_ids)),
                tuple(sorted(item.edge_ids)),
            )
            prior_item = latest_by_stream.get(stream_key)
            if prior_item is None or (
                item.observed_at, item.sequence, item.signal_id
            ) > (
                prior_item.observed_at, prior_item.sequence, prior_item.signal_id
            ):
                latest_by_stream[stream_key] = item
        signals = list(latest_by_stream.values())
        signals = sorted(
            signals,
            key=lambda item: (
                item.freshness == FreshnessStatus.CURRENT
                and item.fresh_until > health.checked_at
                and item.connector_state == ConnectorHealthState.CONNECTED,
                item.status.priority, item.observed_at, item.signal_id,
            ),
            reverse=True,
        )[:12]
        current_signals = [
            item for item in signals
            if item.freshness == FreshnessStatus.CURRENT
            and item.fresh_until > health.checked_at
            and item.connector_state == ConnectorHealthState.CONNECTED
        ]
        dominant = (
            sorted(
                current_signals,
                key=lambda item: (
                    item.status.priority, item.observed_at, item.signal_id,
                ),
                reverse=True,
            )[0]
            if current_signals else None
        )
        health_items = (
            list(prior_realtime.connector_health) if prior_realtime else []
        )
        health_items = [
            item for item in health_items
            if item.connector_id != health.connector_id
        ] + [health]
        activities = (
            list(prior_realtime.agent_workspace.activities)
            if prior_realtime else []
        )
        citations = (
            list(prior_realtime.agent_workspace.citations)
            if prior_realtime else []
        )
        activities.extend([started_activity, completed_activity])
        if not any(item.citation_id == citation.citation_id for item in citations):
            citations.append(citation)
        evidence_refs = list(dict.fromkeys(prior.evidence_refs + [evidence_id]))
        clock_sequence = final_sequence + 1
        runtime_by_status = {
            RealtimeSignalStatus.CRITICAL: "critical",
            RealtimeSignalStatus.WARNING: "warning",
            RealtimeSignalStatus.INFO: "healthy",
        }

        def projected_node(node):
            matches = [
                item for item in current_signals
                if node.component_id in item.component_ids
            ]
            if not matches:
                return node
            status = max(matches, key=lambda item: item.status.priority).status
            return node.copy(update={
                "runtime_status": runtime_by_status[status],
                "impact_status": (
                    "not_impacted"
                    if status == RealtimeSignalStatus.INFO else "impacted"
                ),
            })

        def projected_edge(edge):
            matches = [
                item for item in current_signals if edge.edge_id in item.edge_ids
            ]
            if not matches:
                return edge
            status = max(matches, key=lambda item: item.status.priority).status
            return edge.copy(update={
                "status": (
                    "observed"
                    if status == RealtimeSignalStatus.INFO else "impacted"
                ),
            })

        updated_graph = prior.graph.copy(update={
            "nodes": [projected_node(node) for node in prior.graph.nodes],
            "edges": [projected_edge(edge) for edge in prior.graph.edges],
        })
        incident_status = (
            {
                RealtimeSignalStatus.CRITICAL: "SEV-1",
                RealtimeSignalStatus.WARNING: "SEV-2",
                RealtimeSignalStatus.INFO: "RECOVERING",
            }[dominant.status]
            if dominant is not None else prior.status
        )
        operator_title = (
            (
                "{} detected".format(dominant.title)
                if dominant.status != RealtimeSignalStatus.INFO
                else "{} under observation".format(
                    known_nodes[dominant.component_ids[0]].display_name,
                )
            )
            if dominant is not None else prior.operator_title
        )
        operator_summary = (
            "{} accepted {} at {} from a current admitted {} sample.".format(
                dominant.title, dominant.display_value,
                dominant.observed_at.isoformat(), dominant.source_label,
            )
            if dominant is not None
            else "No current admitted telemetry sample is available."
        )
        updated_v1 = prior.copy(update={
            "projection_revision": projection_revision,
            "sequence": clock_sequence,
            "generated_at": health.checked_at,
            "evidence_revision": evidence_revision,
            "evidence_refs": evidence_refs,
            "graph": updated_graph,
            "lifecycle_state": (
                ProjectionState.ACTIVE
                if current_signals else ProjectionState.DEGRADED
            ),
            "status": incident_status,
            "operator_title": operator_title,
            "operator_summary": operator_summary,
            "degraded_code": (
                None if current_signals else "freshness_sla_exceeded"
            ),
            "impacted_path": (
                prior.impacted_path or list(dominant.component_ids)
                if dominant is not None
                and dominant.status != RealtimeSignalStatus.INFO
                else prior.impacted_path
            ),
        })
        clock_signal = max(
            current_signals,
            key=lambda item: (item.observed_at, item.signal_id),
        ) if current_signals else None
        clock = IncidentClock(
            state=IncidentClockState.RUNNING,
            started_at=prior.created_at,
            last_signal_at=(
                clock_signal.observed_at if clock_signal is not None else None
            ),
            as_of=health.checked_at,
            elapsed_seconds=max(
                0, int((health.checked_at - prior.created_at).total_seconds()),
            ),
            freshness=(
                FreshnessStatus.CURRENT
                if clock_signal is not None else FreshnessStatus.STALE
            ),
            fresh_until=(
                max(item.fresh_until for item in current_signals)
                if current_signals else health.checked_at
            ),
            max_interpolation_seconds=30,
        )
        projection = IncidentProjectionV2.parse_obj({
            **updated_v1.dict(),
            "schema_version": "flowpulse.incident-projection.v2",
            "source_revision": source_revision,
            "connector_revision": connector_revision,
            "incident_clock": clock.dict(),
            "connector_health": [item.dict() for item in health_items],
            "realtime_signals": [item.dict() for item in signals],
            "active_graph_pulses": (
                [
                    item.dict()
                    for item in (
                        list(prior_realtime.active_graph_pulses)
                        if prior_realtime else []
                    )
                    if item.expires_at > health.checked_at
                ]
                + ([pulse.dict()] if pulse is not None else [])
            ),
            "agent_workspace": AgentWorkspace(
                workspace_revision=source_revision,
                activities=activities[-64:],
                citations=citations[-64:],
            ).dict(),
        })
        event_binding = {
            field: getattr(projection, field)
            for field in (
                "tenant_id", "incident_id", "run_id", "topology_revision",
                "case_id", "case_revision", "workflow_id",
                "workflow_run_id", "created_at",
            )
        }
        def event(sequence: int, event_type: RealtimeEventType, **payload):
            return RealtimeIncidentEvent(
                **event_binding,
                source_event_id=source.source_event_id,
                projection_revision=projection_revision,
                sequence=sequence,
                event_type=event_type,
                occurred_at=health.checked_at,
                **payload,
            )

        events = [
            event(
                expiration_start_sequence + index,
                RealtimeEventType.GRAPH_PULSE_EXPIRED,
                pulse=expired_pulse.copy(update={
                    "event_sequence": expiration_start_sequence + index,
                }),
            )
            for index, expired_pulse in enumerate(expired_pulses)
        ] + [
            event(
                next_sequence,
                RealtimeEventType.CONNECTOR_HEALTH_CHANGED,
                health=health,
            ),
            event(
                next_sequence + 1,
                RealtimeEventType.CONNECTOR_SOURCE_ACCEPTED,
            ),
            event(
                next_sequence + 2,
                (
                    RealtimeEventType.SIGNAL_OBSERVED
                    if source.freshness == FreshnessStatus.CURRENT
                    else RealtimeEventType.SIGNAL_STALE
                ),
                signal=signal,
                citation=citation,
            ),
            event(
                next_sequence + 3,
                RealtimeEventType.AGENT_ACTIVITY_STARTED,
                activity=started_activity,
                citation=citation,
            ),
        ]
        if pulse is not None:
            events.append(event(
                next_sequence + 4,
                RealtimeEventType.GRAPH_PULSE_STARTED,
                pulse=pulse,
                citation=citation,
            ))
        events.extend([
            event(
                final_sequence,
                (
                    RealtimeEventType.AGENT_ACTIVITY_COMPLETED
                    if final_state == AgentActivityState.COMPLETED
                    else RealtimeEventType.AGENT_ACTIVITY_DEGRADED
                ),
                activity=completed_activity,
                citation=citation,
            ),
            event(
                clock_sequence,
                RealtimeEventType.INCIDENT_CLOCK_CHANGED,
                incident_clock=clock,
            ),
        ])
        v1_event = IncidentEvent(
            **{
                field: getattr(updated_v1, field)
                for field in (
                    "tenant_id", "incident_id", "run_id", "topology_revision",
                    "case_id", "case_revision", "workflow_id",
                    "workflow_run_id", "created_at",
                )
            },
            projection_revision=projection_revision,
            sequence=clock_sequence,
            event_type="workspace.realtime.source_event.accepted",
            occurred_at=health.checked_at,
            payload={
                "source_event_id": source.source_event_id,
                "signal_id": signal_id,
                "truth_label": source.truth_label.value,
            },
            evidence_refs=[evidence_id],
        )
        transition_key = "connector_event:{}:{}:{}:{}".format(
            source.tenant_id,
            source.run_id,
            source.source_event_id,
            source.normalization_hash,
        )
        return RealtimeCommit(
            transition_key=transition_key,
            source_event=source,
            evidence=evidence,
            prior_projection=prior,
            v1_projection=updated_v1,
            v1_event=v1_event,
            projection=projection,
            events=events,
            signal=signal,
            pulse=pulse,
            citation=citation,
            activities=[started_activity, completed_activity],
            health=health,
            dispatch=dispatch.copy(update={"state": ConnectorDispatchState.PENDING}),
        )

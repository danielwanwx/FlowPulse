"""Temporal activities that turn immutable connector facts into one V2 transition."""

from datetime import timedelta
from hashlib import sha256
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
    ConnectorPollResult,
    ConnectorProvider,
    GraphPulse,
    IncidentClock,
    IncidentClockState,
    IncidentProjectionV2,
    RealtimeCitation,
    RealtimeCommit,
    RealtimeCommitActivityPacket,
    RealtimeIncidentEvent,
    RealtimePollActivityPacket,
    RealtimeSignal,
    RealtimeUpdateOutcome,
)
from .workspace_models import IncidentEvent, IncidentProjection
from .realtime_observability import realtime_telemetry


def realtime_activity_surface() -> List[str]:
    return [
        "workspace_poll_realtime_connector_activity",
        "workspace_commit_realtime_source_event_activity",
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
        if name == "workspace_poll_realtime_connector_activity":
            packet = RealtimePollActivityPacket.parse_obj(packet_data)
            if not _binding_matches(packet.projection, packet.command):
                raise PolicyViolation("realtime_poll_projection_binding_mismatch")
            if not await self.repository.workspace_subject_authorized(
                packet.command.tenant_id,
                packet.command.case_id,
                packet.command.actor_subject_id,
            ):
                raise PolicyViolation("realtime_poll_subject_not_authorized")
            adapter = self.adapters.get(packet.command.connector_id)
            if adapter is None:
                raise PolicyViolation("realtime_connector_unavailable")
            result = await adapter.poll(
                packet.projection,
                acl_subjects=[packet.command.actor_subject_id],
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
            return RealtimeUpdateOutcome(
                accepted=True,
                projection=stored.projection,
                workspace_projection=stored.v1_projection,
                source_event_id=stored.source_event.source_event_id,
                transition_key=stored.transition_key,
            ).dict()
        raise RuntimeError("realtime_activity_unknown")

    def _build_commit(self, packet: RealtimeCommitActivityPacket) -> RealtimeCommit:
        prior = packet.projection
        source = packet.poll_result.source_event
        health = packet.poll_result.health
        dispatch = packet.poll_result.dispatch
        if (
            source.tenant_id != prior.tenant_id
            or source.case_id != prior.case_id
            or source.incident_id != prior.incident_id
            or source.run_id != prior.run_id
            or source.topology_revision != prior.topology_revision
            or health.state.value != "CONNECTED"
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
                SourceKind.METRIC
                if source.provider == ConnectorProvider.PROMETHEUS
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
            authority=EvidenceAuthority.T0,
            freshness=FreshnessStatus.CURRENT,
            independence_key="connector:{}:{}".format(
                source.connector_id, source.source_event_id,
            ),
            schema_binding=source.schema_version,
            proof_scope=ProofScope.CURRENT_OBSERVATION,
            raw_artifact_key=source.raw_artifact_ref,
            adapter_version=health.adapter_version,
        )
        sequence = packet.event_sequence
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
        fresh_until = source.observed_at + timedelta(
            seconds=packet.poll_result.registration.freshness_sla_seconds,
        )
        signal = RealtimeSignal(
            signal_id=signal_id,
            source_event_id=source.source_event_id,
            provider=source.provider,
            source_label=source_label,
            signal_kind="ERROR_RATE" if source.provider == ConnectorProvider.PROMETHEUS else "TRACE_STATUS",
            title="{} error rate".format(component_label),
            display_value=source.display_value,
            status=source.signal_status,
            trend="RISING",
            component_ids=source.component_ids,
            edge_ids=source.edge_ids,
            observed_at=source.observed_at,
            fresh_until=fresh_until,
            freshness=source.freshness,
            authority=source.authority,
            evidence_refs=[evidence_id],
            citation_refs=[citation_id],
            connector_state=health.state,
            sequence=sequence,
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
        pulse = GraphPulse(
            pulse_id=pulse_id,
            source_event_id=source.source_event_id,
            event_sequence=sequence,
            edge_ids=source.edge_ids,
            component_ids=source.component_ids,
            pulse_kind="ERROR_PROPAGATION",
            severity=source.signal_status,
            started_at=source.observed_at,
            expires_at=source.observed_at + timedelta(seconds=10),
            evidence_refs=[evidence_id],
        )
        activity = AgentActivity(
            activity_id=activity_id,
            sequence=sequence,
            role=AgentRole.MONITOR,
            state=AgentActivityState.COMPLETED,
            trigger="CONNECTOR_EVENT",
            capability=packet.poll_result.registration.capabilities[0],
            capability_version=health.adapter_version,
            tool_label="{} metrics".format(source_label),
            component_ids=source.component_ids,
            started_at=source.received_at,
            completed_at=health.checked_at,
            summary="Observed a current {} operational signal.".format(
                component_label,
            ),
            source_event_ids=[source.source_event_id],
            evidence_refs=[evidence_id],
            citation_refs=[citation_id],
            truth_label=source.truth_label,
            external_write_performed=False,
        )
        prior_realtime = packet.prior_realtime_projection
        signals = list(prior_realtime.realtime_signals) if prior_realtime else []
        signals = [item for item in signals if item.signal_id != signal.signal_id]
        signals.append(signal)
        signals = sorted(
            signals,
            key=lambda item: (item.status.value, item.observed_at, item.signal_id),
            reverse=True,
        )[:12]
        activities = (
            list(prior_realtime.agent_workspace.activities)
            if prior_realtime else []
        )
        citations = (
            list(prior_realtime.agent_workspace.citations)
            if prior_realtime else []
        )
        if not any(item.activity_id == activity.activity_id for item in activities):
            activities.append(activity)
        if not any(item.citation_id == citation.citation_id for item in citations):
            citations.append(citation)
        evidence_refs = list(dict.fromkeys(prior.evidence_refs + [evidence_id]))
        updated_v1 = prior.copy(update={
            "projection_revision": projection_revision,
            "sequence": sequence,
            "generated_at": health.checked_at,
            "evidence_revision": evidence_revision,
            "evidence_refs": evidence_refs,
        })
        clock = IncidentClock(
            state=IncidentClockState.RUNNING,
            started_at=prior.created_at,
            last_signal_at=source.observed_at,
            as_of=health.checked_at,
            elapsed_seconds=max(
                0, int((health.checked_at - prior.created_at).total_seconds()),
            ),
            freshness=FreshnessStatus.CURRENT,
            fresh_until=health.checked_at + timedelta(seconds=30),
            max_interpolation_seconds=30,
        )
        projection = IncidentProjectionV2.parse_obj({
            **updated_v1.dict(),
            "schema_version": "flowpulse.incident-projection.v2",
            "source_revision": source_revision,
            "connector_revision": connector_revision,
            "incident_clock": clock.dict(),
            "connector_health": [health.dict()],
            "realtime_signals": [item.dict() for item in signals],
            "active_graph_pulses": [pulse.dict()],
            "agent_workspace": AgentWorkspace(
                workspace_revision=source_revision,
                activities=activities[-64:],
                citations=citations[-64:],
            ).dict(),
        })
        event = RealtimeIncidentEvent(
            **{
                field: getattr(projection, field)
                for field in (
                    "tenant_id", "incident_id", "run_id", "topology_revision",
                    "case_id", "case_revision", "workflow_id",
                    "workflow_run_id", "created_at",
                )
            },
            source_event_id=source.source_event_id,
            projection_revision=projection_revision,
            sequence=sequence,
            event_type="incident.signal.accepted",
            occurred_at=health.checked_at,
            signal=signal,
            pulse=pulse,
            activity=activity,
            citation=citation,
        )
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
            sequence=sequence,
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
            event=event,
            health=health,
            dispatch=dispatch.copy(update={"state": ConnectorDispatchState.PENDING}),
        )

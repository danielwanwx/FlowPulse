"""Bounded server-owned connector polling and durable outbox dispatch."""

from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List

from .realtime_models import ConfiguredBindingTemplate, ConnectorDispatchState
from .realtime_observability import realtime_telemetry


class RealtimeIngestScheduler:
    """One bounded scheduler tick; production cadence remains deployment-owned."""

    def __init__(
        self,
        *,
        repository: Any,
        connectors: Dict[str, Any],
        temporal_dispatch: Callable[[Any, Any], Awaitable[Any]],
        tenant_id: str,
        binding_templates: List[ConfiguredBindingTemplate],
        actor_subject_id: str = "",
    ) -> None:
        self.repository = repository
        self.connectors = dict(connectors)
        self.temporal_dispatch = temporal_dispatch
        self.tenant_id = tenant_id
        self.binding_templates = list(binding_templates)
        self.actor_subject_id = actor_subject_id

    async def dispatch_pending_once(self, limit: int = 100) -> int:
        accepted = 0
        for dispatch in await self.repository.pending_dispatches(
            self.tenant_id, limit=limit,
        ):
            if dispatch.state != ConnectorDispatchState.PENDING:
                continue
            source = await self.repository.source_event(
                self.tenant_id, dispatch.source_event_id,
            )
            if source is None:
                raise ValueError("connector_dispatch_source_missing")
            try:
                await self.temporal_dispatch(source, dispatch)
            except Exception as error:
                # The append-only PENDING state is authoritative until Temporal
                # accepts and commits the transition. A later tick retries it.
                realtime_telemetry.record(
                    source.provider.value,
                    "dispatch",
                    "pending",
                    reason_code=type(error).__name__,
                    queue_depth=1,
                    correlation={
                        "delivery_id": source.delivery_id,
                        "source_event_id": source.source_event_id,
                        "case_id": source.case_id,
                        "run_id": source.run_id,
                    },
                )
                continue
            realtime_telemetry.record(
                source.provider.value,
                "dispatch",
                "accepted",
                queue_depth=0,
                correlation={
                    "delivery_id": source.delivery_id,
                    "source_event_id": source.source_event_id,
                    "case_id": source.case_id,
                    "run_id": source.run_id,
                },
            )
            accepted += 1
        return accepted

    async def run_once(self) -> Dict[str, int]:
        summaries = await self.repository.workspace_active_incidents(
            self.tenant_id, 50,
        )
        polled = 0
        unavailable = 0
        now = datetime.now(timezone.utc)
        for summary in summaries:
            projection = await self.repository.workspace_projection(
                self.tenant_id, summary.case_id,
            )
            if projection is None:
                continue
            await self.repository.materialize_realtime_baseline(
                projection, now=now,
            )
            for connector_id, connector in self.connectors.items():
                for template in self.binding_templates:
                    binding = template.materialize(
                        connector.registration,
                        projection,
                        valid_from=projection.created_at,
                    )
                    await self.repository.append_external_identity_binding(
                        binding,
                    )
                result = await connector.poll(
                    projection,
                    acl_subjects=[self.actor_subject_id],
                    now=now,
                )
                if result.accepted:
                    polled += 1
                else:
                    unavailable += 1
        dispatched = await self.dispatch_pending_once()
        return {
            "polled": polled,
            "unavailable": unavailable,
            "dispatched": dispatched,
        }

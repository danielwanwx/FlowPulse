"""Bounded server-owned connector polling and durable outbox dispatch."""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .realtime_models import ConfiguredBindingTemplate, ConnectorDispatchState
from .realtime_observability import realtime_telemetry


class TerminalRealtimeDispatchError(RuntimeError):
    """A dispatch failure that cannot succeed for this immutable target."""

    def __init__(
        self,
        reason_code: str,
        *,
        error_type: str = "",
        error_code: str = "",
    ) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.error_type = error_type
        self.error_code = error_code


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
        workflow_eligible: Optional[Callable[[Any], Awaitable[bool]]] = None,
        dispatch_timeout_seconds: float = 5.0,
        retry_delay_seconds: float = 5.0,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.repository = repository
        self.connectors = dict(connectors)
        self.temporal_dispatch = temporal_dispatch
        self.tenant_id = tenant_id
        self.binding_templates = list(binding_templates)
        self.actor_subject_id = actor_subject_id
        self.workflow_eligible = workflow_eligible
        self.dispatch_timeout_seconds = dispatch_timeout_seconds
        self.retry_delay_seconds = retry_delay_seconds
        self.clock = clock

    async def dispatch_pending_once(self, limit: int = 100) -> int:
        dispatches = await self.repository.pending_dispatches(
            self.tenant_id, limit=limit, now=self.clock(),
        )

        async def dispatch_one(dispatch) -> int:
            if dispatch.state != ConnectorDispatchState.PENDING:
                return 0
            source = await self.repository.source_event(
                self.tenant_id, dispatch.source_event_id,
            )
            if source is None:
                await self.repository.record_dispatch_failure(
                    dispatch,
                    reason_code="connector_dispatch_source_missing",
                    error_type="ValueError",
                    error_code="SOURCE_NOT_FOUND",
                    terminal=True,
                    created_at=self.clock(),
                )
                return 0
            try:
                await asyncio.wait_for(
                    self.temporal_dispatch(source, dispatch),
                    timeout=self.dispatch_timeout_seconds,
                )
            except TerminalRealtimeDispatchError as error:
                await self.repository.record_dispatch_failure(
                    dispatch,
                    reason_code=error.reason_code,
                    error_type=error.error_type or type(error).__name__,
                    error_code=error.error_code or "TERMINAL",
                    terminal=True,
                    created_at=self.clock(),
                )
                realtime_telemetry.record(
                    source.provider.value,
                    "dispatch",
                    "error",
                    reason_code=error.reason_code,
                    queue_depth=0,
                    correlation={
                        "delivery_id": source.delivery_id,
                        "source_event_id": source.source_event_id,
                        "case_id": source.case_id,
                        "run_id": source.run_id,
                    },
                )
                return 0
            except Exception as error:
                now = self.clock()
                await self.repository.record_dispatch_failure(
                    dispatch,
                    reason_code=type(error).__name__,
                    error_type=(
                        type(error).__module__ + "." + type(error).__name__
                    ),
                    error_code="RETRYABLE",
                    terminal=False,
                    created_at=now,
                    retry_after=now + timedelta(
                        seconds=self.retry_delay_seconds
                        * min(2 ** max(dispatch.attempt - 1, 0), 32),
                    ),
                )
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
                return 0
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
            return 1

        if not dispatches:
            return 0
        return sum(await asyncio.gather(*(
            dispatch_one(dispatch) for dispatch in dispatches
        )))

    async def run_once(self) -> Dict[str, int]:
        summaries = await self.repository.workspace_active_incidents(
            self.tenant_id, 50,
        )
        polled = 0
        unavailable = 0
        ineligible = 0
        now = datetime.now(timezone.utc)
        for summary in summaries:
            projection = await self.repository.workspace_projection(
                self.tenant_id, summary.case_id,
            )
            if projection is None:
                continue
            if self.workflow_eligible is None:
                ineligible += 1
                continue
            try:
                eligible = await self.workflow_eligible(projection)
            except Exception as error:
                ineligible += 1
                realtime_telemetry.record(
                    "TEMPORAL",
                    "eligibility",
                    "error",
                    reason_code=type(error).__name__,
                    correlation={
                        "case_id": projection.case_id,
                        "run_id": projection.run_id,
                    },
                )
                continue
            if not eligible:
                ineligible += 1
                realtime_telemetry.record(
                    "TEMPORAL",
                    "eligibility",
                    "unavailable",
                    reason_code="workflow_execution_not_running",
                    correlation={
                        "case_id": projection.case_id,
                        "run_id": projection.run_id,
                    },
                )
                continue
            for connector_id, connector in self.connectors.items():
                try:
                    await self.repository.materialize_realtime_baseline(
                        projection, now=now,
                    )
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
                    )
                except Exception as error:
                    unavailable += 1
                    realtime_telemetry.record(
                        connector.registration.provider.value,
                        "poll",
                        "error",
                        reason_code=type(error).__name__,
                        correlation={
                            "case_id": projection.case_id,
                            "run_id": projection.run_id,
                        },
                    )
                    continue
                if result.accepted:
                    polled += 1
                else:
                    unavailable += 1
        dispatched = await self.dispatch_pending_once()
        return {
            "polled": polled,
            "unavailable": unavailable,
            "ineligible": ineligible,
            "dispatched": dispatched,
        }

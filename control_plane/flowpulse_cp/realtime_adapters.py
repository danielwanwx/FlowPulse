"""Server-owned, read-only Prometheus/OTEL connector boundaries."""

import asyncio
import ipaddress
import json
import socket
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .realtime_models import (
    ConnectorAdmissionResult,
    ConnectorDispatch,
    ConnectorDispatchState,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorPollResult,
    ConnectorProvider,
    ConnectorRegistration,
    ExternalIdentityBinding,
    RealtimeDeliveryMode,
    RealtimeSourceEvent,
    RealtimeTrend,
)
from .models import EvidenceAuthority, FreshnessStatus, ProofScope
from .workspace_models import IncidentProjection
from .realtime_observability import realtime_telemetry


class ConnectorReadError(RuntimeError):
    pass


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ConnectorReadError("connector_redirect_forbidden")


class ConnectorEndpointPolicy:
    """Exact-origin allowlist plus resolved-address SSRF enforcement."""

    def __init__(
        self,
        allowed_origins: Iterable[str],
        allow_private_origins: bool = False,
        resolver: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.allowed_origins = {
            self._origin(value) for value in allowed_origins if value
        }
        self.allow_private_origins = allow_private_origins
        self.resolver = resolver or socket.getaddrinfo
        if not self.allowed_origins:
            raise ValueError("connector_endpoint_allowlist_empty")

    @staticmethod
    def _origin(value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("connector_endpoint_scheme_or_host_invalid")
        if parsed.username or parsed.password or parsed.fragment:
            raise ValueError("connector_endpoint_userinfo_or_fragment_forbidden")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return "{}://{}:{}".format(parsed.scheme, parsed.hostname.lower(), port)

    def validate(self, value: str) -> str:
        parsed = urlsplit(value)
        origin = self._origin(value)
        if origin not in self.allowed_origins:
            raise ValueError("connector_endpoint_origin_not_allowlisted")
        if parsed.query and len(parsed.query) > 4096:
            raise ValueError("connector_endpoint_query_too_large")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            resolved = self.resolver(parsed.hostname, port, type=socket.SOCK_STREAM)
        except OSError as error:
            raise ValueError("connector_endpoint_resolution_failed") from error
        addresses = {item[4][0] for item in resolved}
        if not addresses:
            raise ValueError("connector_endpoint_resolution_empty")
        for address in addresses:
            ip = ipaddress.ip_address(address)
            unsafe = (
                ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified
            )
            if unsafe and not self.allow_private_origins:
                raise ValueError("connector_endpoint_resolved_address_forbidden")
        return value


class BoundedJsonReader:
    """No-redirect JSON GET with explicit time and byte ceilings."""

    def __init__(
        self,
        policy: ConnectorEndpointPolicy,
        timeout_seconds: float = 5.0,
        max_response_bytes: int = 1024 * 1024,
    ) -> None:
        if timeout_seconds <= 0 or timeout_seconds > 10:
            raise ValueError("connector_timeout_out_of_bounds")
        if max_response_bytes < 1 or max_response_bytes > 5 * 1024 * 1024:
            raise ValueError("connector_response_limit_out_of_bounds")
        self.policy = policy
        self.timeout_seconds = timeout_seconds
        self.max_response_bytes = max_response_bytes
        self.opener = build_opener(_RejectRedirects())

    def read(self, url: str) -> bytes:
        safe_url = self.policy.validate(url)
        try:
            response = self.opener.open(
                Request(safe_url, headers={"Accept": "application/json"}),
                timeout=self.timeout_seconds,
            )
            content = response.read(self.max_response_bytes + 1)
        except (HTTPError, URLError, TimeoutError, ConnectorReadError) as error:
            raise ConnectorReadError("connector_read_failed") from error
        if len(content) > self.max_response_bytes:
            raise ConnectorReadError("connector_response_size_exceeded")
        return content


class PrometheusNormalizer:
    def __init__(self, max_series: int = 128, max_samples: int = 1024) -> None:
        if max_series < 1 or max_series > 1000:
            raise ValueError("prometheus_series_limit_invalid")
        if max_samples < 1 or max_samples > 10000:
            raise ValueError("prometheus_sample_limit_invalid")
        self.max_series = max_series
        self.max_samples = max_samples

    def normalize(
        self,
        *,
        payload: Dict[str, Any],
        registration: ConnectorRegistration,
        binding: ExternalIdentityBinding,
        provider_event_id: str,
        received_at: datetime,
        raw_artifact_ref: str,
        raw_content_hash: str,
        acl_subjects: List[str],
        trend: RealtimeTrend = RealtimeTrend.UNKNOWN,
        delivery_mode: RealtimeDeliveryMode = RealtimeDeliveryMode.LIVE,
    ) -> RealtimeSourceEvent:
        if registration.provider != ConnectorProvider.PROMETHEUS:
            raise ValueError("prometheus_registration_provider_mismatch")
        if (
            binding.tenant_id != registration.tenant_id
            or binding.connector_id != registration.connector_id
            or binding.provider != registration.provider
        ):
            raise ValueError("prometheus_binding_registration_mismatch")
        if payload.get("status") != "success":
            raise ValueError("prometheus_response_unsuccessful")
        data = payload.get("data")
        if not isinstance(data, dict) or data.get("resultType") not in {"vector", "matrix"}:
            raise ValueError("prometheus_result_type_unsupported")
        result = data.get("result")
        if not isinstance(result, list) or not result:
            raise ValueError("prometheus_result_empty_or_malformed")
        if len(result) > self.max_series:
            raise ValueError("prometheus_series_cardinality_exceeded")
        samples: List[List[Any]] = []
        for series in result:
            if not isinstance(series, dict) or not isinstance(series.get("metric"), dict):
                raise ValueError("prometheus_series_malformed")
            values = series.get("values")
            if values is None:
                values = [series.get("value")]
            if not isinstance(values, list) or any(
                not isinstance(item, list) or len(item) != 2 for item in values
            ):
                raise ValueError("prometheus_samples_malformed")
            samples.extend(values)
        if len(samples) > self.max_samples:
            raise ValueError("prometheus_sample_cardinality_exceeded")
        latest = max(samples, key=lambda item: float(item[0]))
        observed_at = datetime.fromtimestamp(float(latest[0]), tz=timezone.utc)
        try:
            numeric = float(latest[1])
        except (TypeError, ValueError) as error:
            raise ValueError("prometheus_sample_value_invalid") from error
        if numeric < 0 or numeric > 1:
            raise ValueError("prometheus_ratio_sample_out_of_bounds")
        fresh_until = observed_at + timedelta(
            seconds=registration.freshness_sla_seconds,
        )
        current = fresh_until >= received_at
        event_values = {
            "source_event_id": "pending",
            "schema_version": "flowpulse.connector-source-event.v1",
            "tenant_id": registration.tenant_id,
            "connector_id": registration.connector_id,
            "provider": registration.provider,
            "provider_event_id": provider_event_id,
            "delivery_id": "pending",
            "raw_artifact_ref": raw_artifact_ref,
            "raw_content_hash": raw_content_hash,
            "event_kind": "METRIC_THRESHOLD_OBSERVED",
            "binding_id": binding.binding_id,
            "binding_revision": binding.binding_revision,
            "case_id": binding.case_id,
            "incident_id": binding.incident_id,
            "run_id": binding.run_id,
            "topology_revision": binding.topology_revision,
            "component_ids": binding.component_ids,
            "edge_ids": binding.edge_ids,
            "observed_at": observed_at,
            "effective_at": observed_at,
            "received_at": received_at,
            "display_value": "{:.1f}%".format(numeric * 100),
            "numeric_value": float(numeric),
            "signal_status": "CRITICAL" if numeric >= 0.05 else "WARNING",
            "trend": trend,
            "delivery_mode": delivery_mode,
            "freshness": (
                FreshnessStatus.CURRENT if current else FreshnessStatus.STALE
            ),
            "authority": (
                EvidenceAuthority.T0 if current else EvidenceAuthority.T1
            ),
            "proof_scope": (
                ProofScope.CURRENT_OBSERVATION
                if current else ProofScope.REFERENCE_ONLY
            ),
            "acl_subjects": acl_subjects,
            "normalizer_version": "prometheus-normalizer.v1",
            "normalization_hash": "0" * 64,
            "truth_label": registration.truth_label,
        }
        provisional = RealtimeSourceEvent.parse_obj(event_values)
        normalization_hash = provisional.canonical_hash()
        identity = normalization_hash[:24]
        return provisional.copy(update={
            "source_event_id": "source-" + identity,
            "delivery_id": "delivery-" + identity,
            "normalization_hash": normalization_hash,
        })


class PrometheusReadAdapter:
    """Fixed-expression adapter; command callers cannot provide URL or query."""

    def __init__(
        self,
        registration: ConnectorRegistration,
        binding: ExternalIdentityBinding,
        base_url: str,
        expression: str,
        reader: BoundedJsonReader,
        artifact_store: Any,
        repository: Any,
    ) -> None:
        if not expression or len(expression) > 256:
            raise ValueError("prometheus_expression_invalid")
        self.registration = registration
        self.binding = binding
        self.base_url = base_url.rstrip("/")
        self.expression = expression
        self.reader = reader
        self.artifact_store = artifact_store
        self.repository = repository
        self.normalizer = PrometheusNormalizer()

    async def poll(
        self,
        *,
        acl_subjects: List[str],
        now: Optional[datetime] = None,
        delivery_mode: RealtimeDeliveryMode = RealtimeDeliveryMode.LIVE,
    ) -> ConnectorPollResult:
        checked_at = now or datetime.now(timezone.utc)
        url = self.base_url + "/api/v1/query?" + urlencode({"query": self.expression})
        try:
            with realtime_telemetry.span(
                "PROMETHEUS",
                "poll",
                {"case_id": self.binding.case_id, "run_id": self.binding.run_id},
            ):
                raw = await asyncio.get_running_loop().run_in_executor(None, self.reader.read, url)
                parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ConnectorReadError, ValueError) as error:
            await self.repository.append_connector_health(ConnectorHealth(
                connector_id=self.registration.connector_id,
                tenant_id=self.registration.tenant_id,
                provider=self.registration.provider,
                state=ConnectorHealthState.DEGRADED,
                checked_at=checked_at,
                consecutive_failures=1,
                lag_seconds=0,
                reason_code=type(error).__name__,
                adapter_version=self.registration.adapter_version,
                health_revision=await self.repository.next_health_revision(
                    self.registration.tenant_id, self.registration.connector_id,
                ),
                truth_label=self.registration.truth_label,
            ))
            raise ConnectorReadError("prometheus_poll_failed") from error
        if len(raw) > self.reader.max_response_bytes:
            raise ConnectorReadError("connector_response_size_exceeded")
        raw_hash = sha256(raw).hexdigest()
        artifact_ref = self.artifact_store.put(self.registration.tenant_id, raw)
        cursor = "cursor-{}".format(raw_hash[:24])
        received_at = now or datetime.now(timezone.utc)
        prior_samples = await self.repository.recent_source_events_for_binding(
            self.registration.tenant_id,
            self.binding.binding_id,
            limit=2,
        )
        trend = RealtimeTrend.UNKNOWN
        if prior_samples:
            latest_prior = max(prior_samples, key=lambda item: item.observed_at)
            candidate_values = parsed.get("data", {}).get("result", [])
            candidate_samples = []
            for series in candidate_values:
                values = series.get("values") or [series.get("value")]
                candidate_samples.extend(values)
            if candidate_samples:
                latest_value = float(max(
                    candidate_samples, key=lambda item: float(item[0]),
                )[1])
                if latest_value > latest_prior.numeric_value:
                    trend = RealtimeTrend.RISING
                elif latest_value < latest_prior.numeric_value:
                    trend = RealtimeTrend.FALLING
                else:
                    trend = RealtimeTrend.STABLE
        try:
            source = self.normalizer.normalize(
                payload=parsed,
                registration=self.registration,
                binding=self.binding,
                provider_event_id="poll:" + cursor,
                received_at=received_at,
                raw_artifact_ref=artifact_ref,
                raw_content_hash=raw_hash,
                acl_subjects=acl_subjects,
                trend=trend,
                delivery_mode=delivery_mode,
            )
        except (TypeError, ValueError) as error:
            health = ConnectorHealth(
                connector_id=self.registration.connector_id,
                tenant_id=self.registration.tenant_id,
                provider=self.registration.provider,
                state=ConnectorHealthState.DEGRADED,
                checked_at=received_at,
                consecutive_failures=1,
                lag_seconds=0,
                reason_code=type(error).__name__,
                adapter_version=self.registration.adapter_version,
                health_revision=await self.repository.next_health_revision(
                    self.registration.tenant_id, self.registration.connector_id,
                ),
                truth_label=self.registration.truth_label,
            )
            await self.repository.append_connector_health(health)
            realtime_telemetry.record(
                "PROMETHEUS",
                "normalize",
                "error",
                reason_code=type(error).__name__,
                correlation={
                    "case_id": self.binding.case_id,
                    "run_id": self.binding.run_id,
                },
            )
            raise ConnectorReadError("prometheus_normalization_failed") from error
        dispatch = ConnectorDispatch(
            dispatch_id="dispatch-" + source.normalization_hash[:24],
            tenant_id=source.tenant_id,
            connector_id=source.connector_id,
            source_event_id=source.source_event_id,
            case_id=source.case_id,
            run_id=source.run_id,
            normalization_hash=source.normalization_hash,
            state=ConnectorDispatchState.PENDING,
            attempt=1,
            created_at=received_at,
        )
        admitted: ConnectorAdmissionResult = await self.repository.admit_source_event(
            source,
            dispatch=dispatch,
        )
        source = admitted.source_event
        dispatch = admitted.dispatch
        receipt = admitted.receipt
        if receipt.duplicate:
            realtime_telemetry.record(
                "PROMETHEUS", "normalize", "duplicate",
                correlation={
                    "delivery_id": source.delivery_id,
                    "source_event_id": source.source_event_id,
                    "case_id": source.case_id,
                    "run_id": source.run_id,
                },
            )
        lag = max(0, int((received_at - source.observed_at).total_seconds()))
        stale = source.freshness == FreshnessStatus.STALE
        health = ConnectorHealth(
            connector_id=self.registration.connector_id,
            tenant_id=self.registration.tenant_id,
            provider=self.registration.provider,
            state=(
                ConnectorHealthState.STALE
                if stale else ConnectorHealthState.CONNECTED
            ),
            checked_at=source.received_at,
            last_success_at=(None if stale else source.received_at),
            last_event_observed_at=source.observed_at,
            fresh_until=source.observed_at + timedelta(
                seconds=self.registration.freshness_sla_seconds,
            ),
            cursor="cursor-" + source.raw_content_hash[:24],
            consecutive_failures=0,
            lag_seconds=lag,
            reason_code=("freshness_sla_exceeded" if stale else None),
            adapter_version=self.registration.adapter_version,
            health_revision=await self.repository.next_health_revision(
                self.registration.tenant_id, self.registration.connector_id,
            ),
            truth_label=self.registration.truth_label,
        )
        await self.repository.append_connector_health(health)
        realtime_telemetry.record(
            "PROMETHEUS", "freshness", "stale" if stale else "success",
            lag_seconds=lag,
            queue_depth=1,
            correlation={
                "delivery_id": source.delivery_id,
                "source_event_id": source.source_event_id,
                "case_id": source.case_id,
                "run_id": source.run_id,
            },
        )
        return ConnectorPollResult(
            registration=self.registration,
            health=health,
            receipt=receipt,
            source_event=source,
            dispatch=dispatch,
        )


class ConfiguredPrometheusConnector:
    """Resolve a server-owned case binding before invoking the fixed adapter."""

    def __init__(
        self,
        registration: ConnectorRegistration,
        base_url: str,
        expression: str,
        reader: BoundedJsonReader,
        artifact_store: Any,
        repository: Any,
    ) -> None:
        self.registration = registration
        self.base_url = base_url
        self.expression = expression
        self.reader = reader
        self.artifact_store = artifact_store
        self.repository = repository

    async def poll(
        self,
        projection: IncidentProjection,
        *,
        acl_subjects: List[str],
        now: Optional[datetime] = None,
        delivery_mode: RealtimeDeliveryMode = RealtimeDeliveryMode.LIVE,
    ) -> ConnectorPollResult:
        if projection.tenant_id != self.registration.tenant_id:
            raise ConnectorReadError("connector_tenant_not_configured")
        checked_at = now or datetime.now(timezone.utc)
        try:
            binding = await self.repository.resolve_external_identity_binding(
                projection,
                self.registration.connector_id,
                self.expression,
                checked_at,
            )
        except ValueError as error:
            reason_code = str(error)
            health = ConnectorHealth(
                connector_id=self.registration.connector_id,
                tenant_id=self.registration.tenant_id,
                provider=self.registration.provider,
                state=ConnectorHealthState.UNAVAILABLE,
                checked_at=checked_at,
                consecutive_failures=0,
                lag_seconds=0,
                reason_code=reason_code,
                adapter_version=self.registration.adapter_version,
                health_revision=await self.repository.next_health_revision(
                    self.registration.tenant_id,
                    self.registration.connector_id,
                ),
                truth_label=self.registration.truth_label,
            )
            await self.repository.append_connector_health(health)
            realtime_telemetry.record(
                "PROMETHEUS",
                "poll",
                "unavailable",
                reason_code=reason_code,
                correlation={
                    "case_id": projection.case_id,
                    "run_id": projection.run_id,
                },
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=reason_code,
                registration=self.registration,
                health=health,
            )
        return await PrometheusReadAdapter(
            registration=self.registration,
            binding=binding,
            base_url=self.base_url,
            expression=self.expression,
            reader=self.reader,
            artifact_store=self.artifact_store,
            repository=self.repository,
        ).poll(
            acl_subjects=acl_subjects,
            now=checked_at,
            delivery_mode=delivery_mode,
        )


class UnavailableOtelAdapter:
    """Truthful Phase 1A boundary when no safe local OTEL query endpoint is bound."""

    def __init__(self, registration: ConnectorRegistration, repository: Any) -> None:
        self.registration = registration
        self.repository = repository

    async def health(self, now: Optional[datetime] = None) -> ConnectorHealth:
        checked_at = now or datetime.now(timezone.utc)
        health = ConnectorHealth(
            connector_id=self.registration.connector_id,
            tenant_id=self.registration.tenant_id,
            provider=ConnectorProvider.OTEL,
            state=ConnectorHealthState.UNAVAILABLE,
            checked_at=checked_at,
            consecutive_failures=0,
            lag_seconds=0,
            reason_code="otel_query_endpoint_unconfigured",
            adapter_version=self.registration.adapter_version,
            health_revision=await self.repository.next_health_revision(
                self.registration.tenant_id, self.registration.connector_id,
            ),
            truth_label=self.registration.truth_label,
        )
        return await self.repository.append_connector_health(health)

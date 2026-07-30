"""Safe structured connector telemetry with bounded provider-class labels."""

import json
import logging
import time
from collections import defaultdict
from contextlib import contextmanager
from threading import Lock
from typing import Dict, Optional


SAFE_PROVIDERS = {"PROMETHEUS", "OTEL"}
SAFE_OPERATIONS = {"poll", "normalize", "dispatch", "commit", "freshness"}
SAFE_OUTCOMES = {
    "success", "error", "duplicate", "conflict", "stale", "unavailable",
    "pending", "accepted",
}


class RealtimeTelemetry:
    """Small dependency-free RED/lag surface; IDs appear only in safe logs."""

    def __init__(self, logger: Optional[logging.Logger] = None) -> None:
        self.logger = logger or logging.getLogger("flowpulse.realtime")
        self._counters = defaultdict(int)
        self._durations = defaultdict(list)
        self._gauges = {}
        self._lock = Lock()

    @staticmethod
    def _labels(provider: str, operation: str, outcome: str):
        if provider not in SAFE_PROVIDERS:
            provider = "OTEL"
        if operation not in SAFE_OPERATIONS:
            raise ValueError("realtime_metric_operation_label_unbounded")
        if outcome not in SAFE_OUTCOMES:
            raise ValueError("realtime_metric_outcome_label_unbounded")
        return provider, operation, outcome

    def record(
        self,
        provider: str,
        operation: str,
        outcome: str,
        duration_ms: int = 0,
        lag_seconds: Optional[int] = None,
        queue_depth: Optional[int] = None,
        correlation: Optional[Dict[str, str]] = None,
        reason_code: Optional[str] = None,
    ) -> None:
        labels = self._labels(provider, operation, outcome)
        provider = labels[0]
        with self._lock:
            self._counters[labels] += 1
            self._durations[labels].append(max(0, min(duration_ms, 600000)))
            if lag_seconds is not None:
                self._gauges[(provider, "lag_seconds")] = max(0, min(lag_seconds, 86400))
            if queue_depth is not None:
                self._gauges[(provider, "queue_depth")] = max(0, min(queue_depth, 100000))
        record = {
            "event": "connector_operation",
            "provider_class": provider,
            "operation": operation,
            "outcome": outcome,
            "duration_ms": max(0, duration_ms),
        }
        if correlation:
            record["correlation"] = {
                key: value for key, value in correlation.items()
                if key in {"delivery_id", "source_event_id", "case_id", "run_id", "workflow_run_id"}
                and isinstance(value, str) and len(value) <= 160
            }
        if reason_code:
            record["reason_code"] = reason_code[:96]
        # Never pass raw payload, endpoint, query, credential, token, or secret
        # values to this logger.
        self.logger.info(json.dumps(record, sort_keys=True, separators=(",", ":")))

    @contextmanager
    def span(self, provider: str, operation: str, correlation=None):
        started = time.monotonic()
        try:
            yield
        except Exception as error:
            self.record(
                provider, operation, "error",
                duration_ms=int((time.monotonic() - started) * 1000),
                correlation=correlation,
                reason_code=type(error).__name__,
            )
            raise
        else:
            self.record(
                provider, operation, "success",
                duration_ms=int((time.monotonic() - started) * 1000),
                correlation=correlation,
            )

    def snapshot(self):
        with self._lock:
            return {
                "counters": {
                    "{}:{}:{}".format(*key): value
                    for key, value in sorted(self._counters.items())
                },
                "duration_ms": {
                    "{}:{}:{}".format(*key): list(values)
                    for key, values in sorted(self._durations.items())
                },
                "gauges": {
                    "{}:{}".format(*key): value
                    for key, value in sorted(self._gauges.items())
                },
            }


realtime_telemetry = RealtimeTelemetry()

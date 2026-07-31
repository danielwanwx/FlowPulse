"""Replay/evaluation record interfaces; they report observations, never benefits."""

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence

from .models import EvaluationMetrics


REQUIRED_METRICS = (
    "time_to_first_useful_evidence_ms",
    "time_to_verified_diagnosis_ms",
    "tool_calls",
    "tokens",
    "specialist_fanout",
    "citation_precision",
    "false_confident_rca",
    "stale_kb_failure",
    "abstained",
)


@dataclass(frozen=True)
class PairedReplayResult:
    case_key: str
    no_kb: EvaluationMetrics
    p0_kb: EvaluationMetrics


def validate_metrics(metrics: EvaluationMetrics) -> None:
    missing = [name for name in REQUIRED_METRICS if not hasattr(metrics, name)]
    if missing:
        raise ValueError("missing_required_metrics:" + ",".join(missing))


def compare_no_kb_to_p0_kb(pairs: Sequence[PairedReplayResult]) -> Dict[str, Optional[float]]:
    """Return paired deltas only; caller must add CIs/release gates from real corpus."""
    if not pairs:
        return {"paired_runs": 0, "mean_tool_call_delta": None, "mean_token_delta": None}
    for pair in pairs:
        validate_metrics(pair.no_kb)
        validate_metrics(pair.p0_kb)
    return {
        "paired_runs": len(pairs),
        "mean_tool_call_delta": sum(pair.p0_kb.tool_calls - pair.no_kb.tool_calls for pair in pairs) / len(pairs),
        "mean_token_delta": sum(pair.p0_kb.tokens - pair.no_kb.tokens for pair in pairs) / len(pairs),
    }

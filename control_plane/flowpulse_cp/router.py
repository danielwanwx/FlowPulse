"""Deterministic router; an optional model may propose only within this boundary."""

from typing import List

from .models import IncidentIntake, RouteDecision


def route_case(
    intake: IncidentIntake,
    evidence_families: int,
    material_contradiction: bool = False,
    specialized_domain: str = "",
) -> RouteDecision:
    reasons: List[str] = ["deterministic_primary_default"]
    specialists: List[str] = []
    if evidence_families > 2:
        specialists.extend(["metrics", "logs"])
        reasons.append("multiple_evidence_families")
    if len(intake.affected_entities) > 1:
        specialists.append("topology")
        reasons.append("cross_entity_scope")
    if specialized_domain in {"database", "network", "code", "change"}:
        specialists.append(specialized_domain)
        reasons.append("specialized_access_or_schema")
    if material_contradiction:
        specialists.append("discriminator")
        reasons.append("material_contradiction")
    # Deduplicate while retaining deterministic ordering and reserve verifier budget.
    ordered = list(dict.fromkeys(specialists))[:4]
    return RouteDecision(
        specialist_roles=ordered,
        knowledge_needs=["service_catalog", "runbook", "invariant"],
        reason_codes=reasons,
        fanout_suppressed_reason=("single_small_scope" if not ordered else None),
    )

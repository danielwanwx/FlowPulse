"""V3 identity and command contracts for long-running Incident Workspaces.

These models are additive. Frozen V2 projection, binding, and action schemas
remain unchanged while the persistence and Temporal migration is implemented.
"""

from datetime import datetime
from hashlib import sha256
from typing import Any

from pydantic import root_validator

from .models import NonEmpty, PositiveInt, StrictModel


class IncidentExecutionIdentityV3(StrictModel):
    """Stable public identity that survives Temporal continue-as-new."""

    schema_version: NonEmpty = "flowpulse.incident-execution-identity.v3"
    tenant_id: NonEmpty
    incident_id: NonEmpty
    incident_run_id: NonEmpty
    topology_revision: NonEmpty
    case_id: NonEmpty
    case_revision: PositiveInt
    temporal_workflow_id: NonEmpty
    created_at: datetime

    @root_validator(allow_reuse=True)
    def public_run_is_not_temporal_workflow_identity(cls, values):
        if values.get("incident_run_id") == values.get("temporal_workflow_id"):
            raise ValueError("incident_run_id_must_not_equal_temporal_workflow_id")
        return values


class TemporalExecutionPointerV3(StrictModel):
    """Current physical Temporal execution for one stable incident run."""

    schema_version: NonEmpty = "flowpulse.temporal-execution-pointer.v3"
    tenant_id: NonEmpty
    incident_run_id: NonEmpty
    temporal_workflow_id: NonEmpty
    temporal_run_id: NonEmpty
    temporal_generation: PositiveInt
    updated_at: datetime

    @root_validator(allow_reuse=True)
    def physical_run_is_not_stable_identity(cls, values):
        temporal_run_id = values.get("temporal_run_id")
        if temporal_run_id in {
            values.get("incident_run_id"),
            values.get("temporal_workflow_id"),
        }:
            raise ValueError("temporal_run_id_must_be_physical_execution_identity")
        return values


class TemporalExecutionRolloverV3(StrictModel):
    """Compare-and-swap input for an exact execution-generation rollover."""

    identity: IncidentExecutionIdentityV3
    expected: TemporalExecutionPointerV3
    replacement: TemporalExecutionPointerV3

    @root_validator(allow_reuse=True)
    def replacement_is_exact_next_generation(cls, values):
        identity = values.get("identity")
        expected = values.get("expected")
        replacement = values.get("replacement")
        if identity is None or expected is None or replacement is None:
            return values
        stable = (
            identity.tenant_id,
            identity.incident_run_id,
            identity.temporal_workflow_id,
        )
        if stable != (
            expected.tenant_id,
            expected.incident_run_id,
            expected.temporal_workflow_id,
        ) or stable != (
            replacement.tenant_id,
            replacement.incident_run_id,
            replacement.temporal_workflow_id,
        ):
            raise ValueError("temporal_rollover_stable_identity_mismatch")
        if replacement.temporal_generation != expected.temporal_generation + 1:
            raise ValueError("temporal_rollover_generation_must_increment_once")
        if replacement.temporal_run_id == expected.temporal_run_id:
            raise ValueError("temporal_rollover_requires_new_physical_run")
        return values


class TemporalExecutionTargetV3(StrictModel):
    """Resolved execution target used immediately before describe/signal."""

    temporal_workflow_id: NonEmpty
    temporal_run_id: NonEmpty
    temporal_generation: PositiveInt
    source: NonEmpty


async def resolve_temporal_execution_target_v3(
    repository: Any, binding: Any,
) -> TemporalExecutionTargetV3:
    """Prefer the V3 current pointer and fall back to a frozen V2 binding."""
    resolver = getattr(repository, "current_temporal_execution_v3", None)
    pointer = (
        await resolver(binding.tenant_id, binding.run_id)
        if callable(resolver)
        else None
    )
    if pointer is not None:
        if (
            pointer.tenant_id != binding.tenant_id
            or pointer.incident_run_id != binding.run_id
            or pointer.temporal_workflow_id != binding.workflow_id
        ):
            raise ValueError("workspace_v3_execution_target_binding_mismatch")
        return TemporalExecutionTargetV3(
            temporal_workflow_id=pointer.temporal_workflow_id,
            temporal_run_id=pointer.temporal_run_id,
            temporal_generation=pointer.temporal_generation,
            source="V3_CURRENT_POINTER",
        )
    return TemporalExecutionTargetV3(
        temporal_workflow_id=binding.workflow_id,
        temporal_run_id=binding.workflow_run_id,
        temporal_generation=1,
        source="V2_IMMUTABLE_BINDING",
    )


class ActionInvocationCommandV3(StrictModel):
    """V3 opaque action command, independent of realtime projection ticks."""

    schema_version: NonEmpty = "flowpulse.action-invocation-command.v3"
    incident_id: NonEmpty
    incident_run_id: NonEmpty
    topology_revision: NonEmpty
    decision_revision: PositiveInt
    action_id: NonEmpty
    idempotency_key: NonEmpty
    idempotency_valid_until: datetime

    def canonical_hash(self) -> str:
        return sha256(
            self.json(sort_keys=True, separators=(",", ":")).encode("utf-8"),
        ).hexdigest()

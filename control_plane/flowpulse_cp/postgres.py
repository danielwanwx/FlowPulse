"""Tenant-scoped Postgres projections; Temporal remains the state authority."""

import inspect
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Tuple, TypeVar
from uuid import NAMESPACE_URL, uuid4, uuid5

import asyncpg

from .models import (
    ActivityOutcome,
    AuthContext,
    AuthCommandIntent,
    AuthCommandKind,
    CaseState,
    ClaimRecord,
    CoverageEntry,
    DryRunReceipt,
    EvidenceEnvelope,
    IncidentCase,
    InvestigatorAssignment,
    OwnerApproval,
    RemediationProposal,
    TemporalActivityPacket,
    VerificationDecision,
    VerificationReport,
)
from .policy import (
    PolicyViolation,
    repair_contract_hash,
    validate_claim_evidence,
    validate_evidence_admission,
)
from .capabilities import CapabilityAuditRecord, CapabilityInvocationContext, CapabilityScope
from .workspace_models import (
    IncidentEvent,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanation,
    NodeExplanationStart,
)
from .workspace_actions import (
    ActionInvocationCommand,
    Gate1Lease,
    NextBestAction,
    WorkspaceSubjectGrant,
    WorkspaceActionCommit,
    WorkspaceActionReceipt,
    validate_authoritative_gate1_read_card,
    validate_authoritative_gate1_grant_transition,
    validate_consumed_gate1_lease_transition,
    validate_fresh_read_evidence_admission,
    validate_workspace_action_commit_kind,
)


T = TypeVar("T")


def _payload(record: Any) -> str:
    return record.json() if hasattr(record, "json") else json.dumps(record, default=str, sort_keys=True)


def _decode(value: Any) -> Dict[str, Any]:
    return json.loads(value) if isinstance(value, str) else value


def _workspace_binding(record: Any) -> IncidentRunBinding:
    """Extract only the immutable binding fields from richer workspace records."""
    fields = IncidentRunBinding.__fields__
    if isinstance(record, Mapping):
        return IncidentRunBinding.parse_obj({name: record[name] for name in fields})
    return IncidentRunBinding.parse_obj({name: getattr(record, name) for name in fields})


def _coverage_entry_id(entry: CoverageEntry):
    """Stable coverage identity includes the tenant before it reaches the global PK."""
    return uuid5(
        NAMESPACE_URL,
        "coverage:{}:{}:{}:{}".format(
            entry.tenant_id, entry.case_id, entry.field, entry.status.value,
        ),
    )


async def _lock_workspace_mapping(connection: asyncpg.Connection, binding: IncidentRunBinding) -> None:
    """Serialize every immutable identity axis before a workspace projection write.

    A topology revision is a child of the public run, not a competing lock
    namespace.  Taking each stable mapping lock in lexical order makes a
    concurrent cross-key attempt observe the first authoritative binding
    instead of racing through independent run/topology locks.
    """
    names = sorted([
        "workspace-case:{}:{}".format(binding.tenant_id, binding.case_id),
        "workspace-public-run:{}:{}".format(binding.tenant_id, binding.run_id),
        "workspace-temporal:{}:{}:{}".format(
            binding.tenant_id, binding.workflow_id, binding.workflow_run_id,
        ),
    ])
    for name in names:
        await connection.execute("SELECT pg_advisory_xact_lock(hashtext($1))", name)


def activity_event_identity(packet: TemporalActivityPacket, activity_id: str) -> str:
    """Stable retry identity: a committed activity is never recorded twice."""
    return str(uuid5(
        NAMESPACE_URL,
        "event:{}:{}:{}:{}".format(packet.workflow_run_id, activity_id, packet.stage, packet.sequence),
    ))


class PostgresCaseRepository:
    def __init__(self, dsn: str, failure_injector=None) -> None:
        self.dsn = dsn
        self.pool: Optional[asyncpg.Pool] = None
        self.failure_injector = failure_injector
        self.workspace_capability_registry = None

    def configure_workspace_capability_registry(self, registry) -> None:
        """Attach the worker registry used by locked Gate 1 transition checks."""
        if (
            self.workspace_capability_registry is not None
            and self.workspace_capability_registry is not registry
            and self.workspace_capability_registry.policy_version != registry.policy_version
        ):
            raise PolicyViolation("workspace_capability_registry_rebind_forbidden")
        self.workspace_capability_registry = registry

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def _pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("postgres_repository_not_connected")
        return self.pool

    async def _tenant(
        self, tenant_id: str, operation: Callable[[asyncpg.Connection], Awaitable[T]], subject_id: Optional[str] = None,
    ) -> T:
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                await connection.execute("SELECT set_config('app.tenant_id', $1, true)", tenant_id)
                if subject_id is not None:
                    await connection.execute("SELECT set_config('app.subject_id', $1, true)", subject_id)
                return await operation(connection)

    async def _action_checkpoint(self, checkpoint: str) -> None:
        if self.failure_injector is None:
            return
        result = self.failure_injector(checkpoint)
        if inspect.isawaitable(result):
            await result

    async def _workspace_transition_now(self, connection: asyncpg.Connection) -> datetime:
        """Return the database transaction clock used by final Gate 1 checks."""
        return await connection.fetchval("SELECT statement_timestamp()")

    async def get_case(self, tenant_id: str, case_id: str) -> Optional[IncidentCase]:
        async def operation(connection: asyncpg.Connection) -> Optional[IncidentCase]:
            row = await connection.fetchrow(
                "SELECT payload FROM incident_cases WHERE tenant_id=$1 AND case_id=$2", tenant_id, case_id
            )
            return IncidentCase.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def put_workspace_binding(self, binding: IncidentRunBinding) -> IncidentRunBinding:
        """Persist the immutable public-run to Temporal mapping from an activity only."""
        binding = _workspace_binding(binding)
        async def operation(connection: asyncpg.Connection) -> IncidentRunBinding:
            await _lock_workspace_mapping(connection, binding)
            existing = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND run_id=$2""",
                binding.tenant_id, binding.run_id,
            )
            if existing is not None:
                current = _workspace_binding(_decode(existing["payload"]))
                if current != binding:
                    if current.topology_revision != binding.topology_revision:
                        raise PolicyViolation("workspace_run_rebound_to_different_topology")
                    raise PolicyViolation("workspace_public_internal_binding_mismatch")
                return current
            rebound = await connection.fetchrow(
                "SELECT payload FROM incident_run_bindings WHERE tenant_id=$1 AND case_id=$2",
                binding.tenant_id, binding.case_id,
            )
            if rebound is not None:
                raise PolicyViolation("workspace_case_rebound_to_different_temporal_run")
            temporal_rebound = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND workflow_id=$2 AND workflow_run_id=$3""",
                binding.tenant_id, binding.workflow_id, binding.workflow_run_id,
            )
            if temporal_rebound is not None:
                raise PolicyViolation("workspace_temporal_run_rebound_to_different_case")
            await connection.execute(
                """INSERT INTO incident_run_bindings
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision,
                    workflow_id, workflow_run_id, created_at, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)""",
                binding.tenant_id, binding.incident_id, binding.run_id, binding.topology_revision,
                binding.case_id, binding.case_revision, binding.workflow_id, binding.workflow_run_id,
                binding.created_at, _payload(binding),
            )
            return binding
        return await self._tenant(binding.tenant_id, operation)

    async def workspace_binding(self, tenant_id: str, case_id: str) -> Optional[IncidentRunBinding]:
        async def operation(connection: asyncpg.Connection) -> Optional[IncidentRunBinding]:
            row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 1""",
                tenant_id, case_id,
            )
            return _workspace_binding(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def workspace_binding_by_public_identity(
        self, tenant_id: str, incident_id: str, run_id: str, topology_revision: str,
    ) -> Optional[IncidentRunBinding]:
        async def operation(connection: asyncpg.Connection) -> Optional[IncidentRunBinding]:
            row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND incident_id=$2 AND run_id=$3 AND topology_revision=$4""",
                tenant_id, incident_id, run_id, topology_revision,
            )
            return _workspace_binding(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def grant_workspace_subject(
        self, binding: IncidentRunBinding, subject_id: str, roles=None, permissions=None,
    ) -> None:
        """Append the initializer's trusted subject grant independently of evidence ACLs."""
        grant = WorkspaceSubjectGrant(
            tenant_id=binding.tenant_id, case_id=binding.case_id, subject_id=subject_id,
            roles=list(roles or []), permissions=list(permissions or []), created_at=binding.created_at,
        )
        async def operation(connection: asyncpg.Connection) -> None:
            row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND case_id=$2""",
                binding.tenant_id, binding.case_id,
            )
            if row is None or _workspace_binding(_decode(row["payload"])) != _workspace_binding(binding):
                raise PolicyViolation("workspace_subject_grant_binding_mismatch")
            existing = await connection.fetchrow(
                """SELECT roles, permissions, created_at FROM workspace_subject_grants
                   WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3""",
                binding.tenant_id, binding.case_id, subject_id,
            )
            if existing is not None:
                recorded = WorkspaceSubjectGrant(
                    tenant_id=binding.tenant_id, case_id=binding.case_id, subject_id=subject_id,
                    roles=_decode(existing["roles"]), permissions=_decode(existing["permissions"]),
                    created_at=existing["created_at"],
                )
                if recorded != grant:
                    raise PolicyViolation("workspace_subject_grant_immutable")
                return
            await connection.execute(
                """INSERT INTO workspace_subject_grants
                   (tenant_id, case_id, subject_id, roles, permissions, created_at)
                   VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)""",
                binding.tenant_id, binding.case_id, subject_id,
                json.dumps(grant.roles), json.dumps(grant.permissions), binding.created_at,
            )
        await self._tenant(binding.tenant_id, operation, subject_id=subject_id)

    async def workspace_subject_authorized(self, tenant_id: str, case_id: str, subject_id: str) -> bool:
        async def operation(connection: asyncpg.Connection) -> bool:
            return bool(await connection.fetchval(
                """SELECT EXISTS(
                       SELECT 1 FROM workspace_subject_grants
                       WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3
                   )""",
                tenant_id, case_id, subject_id,
            ))
        return await self._tenant(tenant_id, operation, subject_id=subject_id)

    async def workspace_subject_grant(
        self, tenant_id: str, case_id: str, subject_id: str,
    ) -> Optional[WorkspaceSubjectGrant]:
        async def operation(connection: asyncpg.Connection) -> Optional[WorkspaceSubjectGrant]:
            row = await connection.fetchrow(
                """SELECT roles, permissions, created_at FROM workspace_subject_grants
                   WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3""",
                tenant_id, case_id, subject_id,
            )
            if row is None:
                return None
            return WorkspaceSubjectGrant(
                tenant_id=tenant_id, case_id=case_id, subject_id=subject_id,
                roles=_decode(row["roles"]), permissions=_decode(row["permissions"]),
                created_at=row["created_at"],
            )
        return await self._tenant(tenant_id, operation, subject_id=subject_id)

    async def put_workspace_projection(self, projection: IncidentProjection) -> IncidentProjection:
        async def operation(connection: asyncpg.Connection) -> IncidentProjection:
            await _lock_workspace_mapping(connection, _workspace_binding(projection))
            binding_row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND run_id=$2""",
                projection.tenant_id, projection.run_id,
            )
            if binding_row is None or _workspace_binding(_decode(binding_row["payload"])) != _workspace_binding(projection):
                raise PolicyViolation("workspace_public_internal_binding_mismatch")
            duplicate = await connection.fetchrow(
                """SELECT payload FROM incident_projections
                   WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3
                     AND (projection_revision=$4 OR sequence=$5)
                   ORDER BY projection_revision DESC LIMIT 1""",
                projection.tenant_id, projection.run_id, projection.topology_revision,
                projection.projection_revision, projection.sequence,
            )
            if duplicate is not None:
                recorded = IncidentProjection.parse_obj(_decode(duplicate["payload"]))
                if recorded == projection:
                    return recorded
            latest = await connection.fetchrow(
                """SELECT projection_revision, sequence FROM incident_projections
                   WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3
                   ORDER BY projection_revision DESC LIMIT 1""",
                projection.tenant_id, projection.run_id, projection.topology_revision,
            )
            if latest is not None and (
                projection.projection_revision <= latest["projection_revision"] or projection.sequence <= latest["sequence"]
            ):
                raise PolicyViolation("workspace_projection_revision_or_sequence_not_monotonic")
            await connection.execute(
                """INSERT INTO incident_projections
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id,
                    projection_revision, sequence, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)""",
                projection.tenant_id, projection.incident_id, projection.run_id, projection.topology_revision,
                projection.case_id, projection.case_revision, projection.workflow_id, projection.workflow_run_id,
                projection.projection_revision, projection.sequence, _payload(projection), projection.generated_at,
            )
            return projection
        return await self._tenant(projection.tenant_id, operation)

    async def workspace_projection(self, tenant_id: str, case_id: str) -> Optional[IncidentProjection]:
        async def operation(connection: asyncpg.Connection) -> Optional[IncidentProjection]:
            row = await connection.fetchrow(
                """SELECT payload FROM incident_projections
                   WHERE tenant_id=$1 AND case_id=$2
                   ORDER BY projection_revision DESC LIMIT 1""",
                tenant_id, case_id,
            )
            return IncidentProjection.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def append_workspace_event(self, event: IncidentEvent) -> IncidentEvent:
        event_id = uuid5(
            NAMESPACE_URL,
            "workspace-event:{}:{}:{}:{}".format(
                event.tenant_id, event.run_id, event.topology_revision, event.sequence,
            ),
        )
        async def operation(connection: asyncpg.Connection) -> IncidentEvent:
            await _lock_workspace_mapping(connection, _workspace_binding(event))
            binding_row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND run_id=$2""",
                event.tenant_id, event.run_id,
            )
            if binding_row is None or _workspace_binding(_decode(binding_row["payload"])) != _workspace_binding(event):
                raise PolicyViolation("workspace_public_internal_binding_mismatch")
            prior = await connection.fetchrow(
                """SELECT sequence FROM incident_projection_events
                   WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3
                   ORDER BY sequence DESC LIMIT 1""",
                event.tenant_id, event.run_id, event.topology_revision,
            )
            if prior is not None and event.sequence <= prior["sequence"]:
                same = await connection.fetchrow(
                    """SELECT payload FROM incident_projection_events
                       WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3 AND sequence=$4""",
                    event.tenant_id, event.run_id, event.topology_revision, event.sequence,
                )
                if same is not None:
                    recorded = IncidentEvent.parse_obj(_decode(same["payload"]))
                    if recorded.copy(update={"occurred_at": event.occurred_at}) == event:
                        return recorded
                raise PolicyViolation("workspace_event_sequence_not_monotonic")
            await connection.execute(
                """INSERT INTO incident_projection_events
                   (event_id, tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, projection_revision, sequence, event_type, payload, occurred_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)""",
                event_id, event.tenant_id, event.incident_id, event.run_id, event.topology_revision,
                event.case_id, event.case_revision, event.workflow_id, event.workflow_run_id,
                event.projection_revision, event.sequence, event.event_type, _payload(event), event.occurred_at,
            )
            return event
        return await self._tenant(event.tenant_id, operation)

    async def workspace_events_after(self, tenant_id: str, case_id: str, after: int) -> List[IncidentEvent]:
        async def operation(connection: asyncpg.Connection) -> List[IncidentEvent]:
            rows = await connection.fetch(
                """SELECT payload FROM incident_projection_events
                   WHERE tenant_id=$1 AND case_id=$2 AND sequence > $3
                   ORDER BY sequence ASC""",
                tenant_id, case_id, after,
            )
            return [IncidentEvent.parse_obj(_decode(row["payload"])) for row in rows]
        return await self._tenant(tenant_id, operation)

    async def start_or_reuse_workspace_explanation(
        self, explanation: NodeExplanation,
    ) -> Tuple[NodeExplanation, bool]:
        async def operation(connection: asyncpg.Connection) -> Tuple[NodeExplanation, bool]:
            await _lock_workspace_mapping(connection, _workspace_binding(explanation))
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "workspace-explanation:{}:{}".format(explanation.tenant_id, explanation.selection_key),
            )
            binding_row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND run_id=$2""",
                explanation.tenant_id, explanation.run_id,
            )
            if binding_row is None or _workspace_binding(_decode(binding_row["payload"])) != _workspace_binding(explanation):
                raise PolicyViolation("workspace_public_internal_binding_mismatch")
            existing = await connection.fetchrow(
                "SELECT payload FROM node_explanations WHERE tenant_id=$1 AND selection_key=$2",
                explanation.tenant_id, explanation.selection_key,
            )
            if existing is not None:
                return NodeExplanation.parse_obj(_decode(existing["payload"])), True
            inserted = await connection.fetchrow(
                """INSERT INTO node_explanations
                   (explanation_id, tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, projection_revision, component_id, conversation_schema_version,
                    selection_key, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
                   ON CONFLICT (tenant_id, selection_key) DO NOTHING RETURNING payload""",
                explanation.explanation_id, explanation.tenant_id, explanation.incident_id, explanation.run_id,
                explanation.topology_revision, explanation.case_id, explanation.case_revision,
                explanation.workflow_id, explanation.workflow_run_id, explanation.projection_revision,
                explanation.component_id, explanation.conversation_schema_version, explanation.selection_key,
                _payload(explanation), explanation.created_at,
            )
            if inserted is not None:
                return explanation, False
            existing = await connection.fetchrow(
                "SELECT payload FROM node_explanations WHERE tenant_id=$1 AND selection_key=$2",
                explanation.tenant_id, explanation.selection_key,
            )
            if existing is None:
                raise PolicyViolation("workspace_explanation_insert_failed")
            return NodeExplanation.parse_obj(_decode(existing["payload"])), True
        return await self._tenant(explanation.tenant_id, operation)

    async def workspace_explanation(
        self, tenant_id: str, case_id: str, explanation_id: str,
    ) -> Optional[NodeExplanation]:
        async def operation(connection: asyncpg.Connection) -> Optional[NodeExplanation]:
            row = await connection.fetchrow(
                """SELECT payload FROM node_explanations
                   WHERE tenant_id=$1 AND case_id=$2 AND explanation_id=$3""",
                tenant_id, case_id, explanation_id,
            )
            return NodeExplanation.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def append_gate1_lease(self, lease: Gate1Lease) -> Gate1Lease:
        """Append one Temporal-derived lease revision under the immutable binding."""
        async def operation(connection: asyncpg.Connection) -> Gate1Lease:
            await _lock_workspace_mapping(connection, _workspace_binding(lease))
            binding = await connection.fetchrow(
                "SELECT payload FROM incident_run_bindings WHERE tenant_id=$1 AND run_id=$2",
                lease.tenant_id, lease.run_id,
            )
            if binding is None or _workspace_binding(_decode(binding["payload"])) != _workspace_binding(lease):
                raise PolicyViolation("workspace_public_internal_binding_mismatch")
            prior = await connection.fetchrow(
                """SELECT payload FROM workspace_gate1_leases
                   WHERE tenant_id=$1 AND lease_id=$2 ORDER BY lease_revision DESC LIMIT 1""",
                lease.tenant_id, lease.lease_id,
            )
            if prior is not None:
                recorded = Gate1Lease.parse_obj(_decode(prior["payload"]))
                if lease.lease_revision <= recorded.lease_revision:
                    if lease == recorded:
                        return recorded
                    raise PolicyViolation("gate1_lease_revision_not_monotonic")
            await connection.execute(
                """INSERT INTO workspace_gate1_leases
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, lease_id, lease_revision, status, consumed_by_activity_id, expires_at, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)""",
                lease.tenant_id, lease.incident_id, lease.run_id, lease.topology_revision, lease.case_id,
                lease.case_revision, lease.workflow_id, lease.workflow_run_id, lease.lease_id, lease.lease_revision,
                lease.status.value, lease.consumed_by_activity_id, lease.expires_at, _payload(lease), lease.created_at,
            )
            return lease
        return await self._tenant(lease.tenant_id, operation, subject_id=lease.subject_id)

    async def workspace_gate1_lease(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[Gate1Lease]:
        async def operation(connection: asyncpg.Connection) -> Optional[Gate1Lease]:
            row = await connection.fetchrow(
                """SELECT payload FROM workspace_gate1_leases
                   WHERE tenant_id=$1 AND case_id=$2 AND lease_id=$3
                   ORDER BY lease_revision DESC LIMIT 1""",
                tenant_id, case_id, lease_id,
            )
            return Gate1Lease.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def workspace_gate1_grant_transition(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[WorkspaceActionCommit]:
        """Load the immutable transition which issued one exact Gate 1 lease."""
        async def operation(connection: asyncpg.Connection) -> Optional[WorkspaceActionCommit]:
            rows = await connection.fetch(
                """SELECT payload FROM workspace_action_transitions
                   WHERE tenant_id=$1 AND case_id=$2
                     AND payload #>> '{receipt,status}' = 'GATE1_GRANTED'
                     AND payload #>> '{lease,lease_id}' = $3""",
                tenant_id, case_id, lease_id,
            )
            if len(rows) > 1:
                raise PolicyViolation("gate1_lease_grant_transition_ambiguous")
            return WorkspaceActionCommit.parse_obj(_decode(rows[0]["payload"])) if rows else None
        return await self._tenant(tenant_id, operation)

    async def append_next_best_action(self, action: NextBestAction) -> NextBestAction:
        async def operation(connection: asyncpg.Connection) -> NextBestAction:
            await _lock_workspace_mapping(connection, _workspace_binding(action))
            binding = await connection.fetchrow(
                "SELECT payload FROM incident_run_bindings WHERE tenant_id=$1 AND run_id=$2",
                action.tenant_id, action.run_id,
            )
            if binding is None or _workspace_binding(_decode(binding["payload"])) != _workspace_binding(action):
                raise PolicyViolation("workspace_public_internal_binding_mismatch")
            prior = await connection.fetchrow(
                "SELECT payload FROM next_best_actions WHERE tenant_id=$1 AND action_id=$2",
                action.tenant_id, action.action_id,
            )
            if prior is not None:
                recorded = NextBestAction.parse_obj(_decode(prior["payload"]))
                if recorded != action:
                    raise PolicyViolation("next_best_action_immutable")
                return recorded
            await connection.execute(
                """INSERT INTO next_best_actions
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, action_id, card_version, projection_revision, action_revision, expires_at,
                    payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)""",
                action.tenant_id, action.incident_id, action.run_id, action.topology_revision, action.case_id,
                action.case_revision, action.workflow_id, action.workflow_run_id, action.action_id, action.card_version,
                action.projection_revision, action.action_revision, action.expires_at, _payload(action), action.created_at,
            )
            return action
        return await self._tenant(action.tenant_id, operation)

    async def workspace_next_best_action(
        self, tenant_id: str, case_id: str, action_id: str,
    ) -> Optional[NextBestAction]:
        async def operation(connection: asyncpg.Connection) -> Optional[NextBestAction]:
            row = await connection.fetchrow(
                "SELECT payload FROM next_best_actions WHERE tenant_id=$1 AND case_id=$2 AND action_id=$3",
                tenant_id, case_id, action_id,
            )
            return NextBestAction.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def workspace_next_best_actions(self, tenant_id: str, case_id: str) -> List[NextBestAction]:
        async def operation(connection: asyncpg.Connection) -> List[NextBestAction]:
            rows = await connection.fetch(
                """SELECT payload FROM next_best_actions
                   WHERE tenant_id=$1 AND case_id=$2 ORDER BY (payload->>'display_order')::integer ASC""",
                tenant_id, case_id,
            )
            return [NextBestAction.parse_obj(_decode(row["payload"])) for row in rows]
        return await self._tenant(tenant_id, operation)

    async def record_workspace_action_receipt(self, receipt: WorkspaceActionReceipt) -> WorkspaceActionReceipt:
        async def operation(connection: asyncpg.Connection) -> WorkspaceActionReceipt:
            await _lock_workspace_mapping(connection, _workspace_binding(receipt))
            existing = await connection.fetchrow(
                """SELECT payload FROM workspace_action_receipts
                   WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
                receipt.tenant_id, receipt.case_id, receipt.idempotency_key,
            )
            if existing is not None:
                prior = WorkspaceActionReceipt.parse_obj(_decode(existing["payload"]))
                if prior != receipt:
                    raise PolicyViolation("workspace_action_idempotency_conflict")
                return prior
            await connection.execute(
                """INSERT INTO workspace_action_receipts
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, action_id, idempotency_key, status, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)""",
                receipt.tenant_id, receipt.incident_id, receipt.run_id, receipt.topology_revision, receipt.case_id,
                receipt.case_revision, receipt.workflow_id, receipt.workflow_run_id, receipt.action_id,
                receipt.idempotency_key, receipt.status, _payload(receipt), receipt.created_at,
            )
            return receipt
        return await self._tenant(receipt.tenant_id, operation)

    async def workspace_action_receipt(
        self, tenant_id: str, case_id: str, idempotency_key: str,
    ) -> Optional[WorkspaceActionReceipt]:
        async def operation(connection: asyncpg.Connection) -> Optional[WorkspaceActionReceipt]:
            row = await connection.fetchrow(
                """SELECT payload FROM workspace_action_receipts
                   WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
                tenant_id, case_id, idempotency_key,
            )
            return WorkspaceActionReceipt.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def _persist_coverage_entry(
        self, connection: asyncpg.Connection, entry: CoverageEntry,
    ) -> CoverageEntry:
        """Append one tenant-bound coverage record or prove an exact prior append.

        Coverage is part of the action evidence ledger.  The primary key is
        globally unique, so its deterministic material must include tenant;
        the scoped natural-key lookup also recognizes an exact legacy row but
        rejects any conflicting payload instead of silently dropping it.
        """
        entry_id = _coverage_entry_id(entry)
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            "workspace-coverage:{}:{}:{}:{}".format(
                entry.tenant_id, entry.case_id, entry.field, entry.status.value,
            ),
        )
        rows = await connection.fetch(
            """SELECT entry_id, payload FROM coverage_entries
               WHERE tenant_id=$1 AND case_id=$2 AND field=$3 AND status=$4""",
            entry.tenant_id, entry.case_id, entry.field, entry.status.value,
        )
        if rows:
            if len(rows) != 1:
                raise PolicyViolation("workspace_action_coverage_ambiguous")
            existing = CoverageEntry.parse_obj(_decode(rows[0]["payload"]))
            if existing != entry:
                raise PolicyViolation("workspace_action_coverage_immutable")
            return existing
        await connection.execute(
            """INSERT INTO coverage_entries (entry_id, case_id, tenant_id, field, status, payload)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb)""",
            entry_id, entry.case_id, entry.tenant_id, entry.field, entry.status.value, _payload(entry),
        )
        return entry

    async def _persist_workspace_action_capability(
        self, connection: asyncpg.Connection, commit: WorkspaceActionCommit,
    ) -> None:
        """Admit fresh evidence and append its audit in the action transaction."""
        # Keep this private persistence seam fail-closed even if a future
        # caller reaches it without the public transition method.
        validate_workspace_action_commit_kind(commit)
        result = commit.capability_result
        audit = commit.capability_audit
        if result is None and audit is None:
            return
        if result is None or audit is None:
            raise PolicyViolation("workspace_action_capability_records_incomplete")
        if _workspace_binding(audit) != _workspace_binding(commit.projection):
            raise PolicyViolation("workspace_action_capability_binding_mismatch")
        context = CapabilityInvocationContext.parse_obj({
            **{field: getattr(audit, field) for field in IncidentRunBinding.__fields__},
            "projection_revision": audit.projection_revision,
            "evidence_revision": audit.evidence_revision,
            "activity_id": audit.activity_id,
            "scope": audit.scope,
            "subject_id": audit.subject_id,
            "component_ids": [audit.component_id],
            "authorized_subjects": [audit.subject_id], "subject_roles": [],
            "data_class": audit.data_class,
            "recorded_evidence_ids": audit.input_evidence_refs,
            "gate1_authorized": audit.required_gate.value == "GATE1",
            "system_authorized": audit.scope == CapabilityScope.AUTONOMOUS_DIAGNOSIS,
        })
        await self._assert_capability_scope_connection(connection, context)
        case = await connection.fetchrow(
            "SELECT case_revision FROM incident_cases WHERE tenant_id=$1 AND case_id=$2",
            commit.projection.tenant_id, commit.projection.case_id,
        )
        if case is None or case["case_revision"] != commit.projection.case_revision:
            raise PolicyViolation("evidence_case_tenant_or_revision_mismatch")
        immutable_input_evidence = {}
        for evidence_id in audit.input_evidence_refs:
            input_row = await connection.fetchrow(
                """SELECT payload FROM evidence_envelopes
                   WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3
                     AND evidence_id=$4 AND acl_subjects ? $5""",
                commit.projection.tenant_id, commit.projection.case_id,
                commit.projection.case_revision, evidence_id, audit.subject_id,
            )
            if input_row is not None:
                immutable_input_evidence[evidence_id] = EvidenceEnvelope.parse_obj(_decode(input_row["payload"]))
        validate_fresh_read_evidence_admission(
            result, audit, commit.projection, immutable_input_evidence,
        )
        for evidence in result.evidence:
            validate_evidence_admission(evidence, audit.subject_id)
            if (
                evidence.tenant_id, evidence.case_id, evidence.case_revision
            ) != (
                commit.projection.tenant_id, commit.projection.case_id, commit.projection.case_revision
            ):
                raise PolicyViolation("capability_result_evidence_scope_mismatch")
            existing = await connection.fetchrow(
                "SELECT payload FROM evidence_envelopes WHERE evidence_id=$1", evidence.evidence_id,
            )
            if existing is not None:
                if EvidenceEnvelope.parse_obj(_decode(existing["payload"])) != evidence:
                    raise PolicyViolation("evidence_id_immutable")
                continue
            for parent_evidence_id in evidence.parent_evidence_ids:
                if parent_evidence_id == evidence.evidence_id:
                    raise PolicyViolation("evidence_parent_self_reference")
                parent = await connection.fetchrow(
                    """SELECT evidence_id FROM evidence_envelopes
                       WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3 AND evidence_id=$4""",
                    evidence.tenant_id, evidence.case_id, evidence.case_revision, parent_evidence_id,
                )
                if parent is None:
                    raise PolicyViolation("unknown_parent_evidence")
            await connection.execute(
                """INSERT INTO evidence_envelopes
                   (evidence_id, case_id, tenant_id, case_revision, acl_subjects, proof_scope, source_uri,
                    source_anchor, content_hash, independence_key, payload)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)""",
                evidence.evidence_id, evidence.case_id, evidence.tenant_id, evidence.case_revision,
                json.dumps(evidence.acl_subjects), evidence.proof_scope.value, evidence.source_uri,
                evidence.source_anchor, evidence.content_hash, evidence.independence_key, _payload(evidence),
            )
        for claim in result.claims:
            if (
                claim.tenant_id, claim.case_id, claim.case_revision
            ) != (
                commit.projection.tenant_id, commit.projection.case_id, commit.projection.case_revision
            ):
                raise PolicyViolation("capability_result_claim_scope_mismatch")
            cited = []
            for evidence_id in claim.evidence_ids:
                evidence_row = await connection.fetchrow(
                    """SELECT payload FROM evidence_envelopes
                       WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3
                         AND evidence_id=$4 AND acl_subjects ? $5""",
                    claim.tenant_id, claim.case_id, claim.case_revision, evidence_id, audit.subject_id,
                )
                if evidence_row is not None:
                    cited.append(EvidenceEnvelope.parse_obj(_decode(evidence_row["payload"])))
            validate_claim_evidence(claim, cited, audit.subject_id)
            existing = await connection.fetchrow(
                "SELECT payload FROM claim_records WHERE claim_id=$1", claim.claim_id,
            )
            if existing is not None:
                if ClaimRecord.parse_obj(_decode(existing["payload"])) != claim:
                    raise PolicyViolation("claim_record_immutable")
            else:
                await connection.execute(
                    """INSERT INTO claim_records
                       (claim_id, case_id, tenant_id, case_revision, evidence_ids, status, payload)
                       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)""",
                    claim.claim_id, claim.case_id, claim.tenant_id, claim.case_revision,
                    json.dumps(claim.evidence_ids), claim.status.value, _payload(claim),
                )
                for evidence_id in claim.evidence_ids:
                    await connection.execute(
                        """INSERT INTO claim_evidence_links
                           (claim_id, evidence_id, case_id, tenant_id, case_revision)
                           VALUES ($1,$2,$3,$4,$5)""",
                        claim.claim_id, evidence_id, claim.case_id, claim.tenant_id, claim.case_revision,
                    )
        for coverage in result.coverage:
            if (coverage.tenant_id, coverage.case_id) != (commit.projection.tenant_id, commit.projection.case_id):
                raise PolicyViolation("capability_result_coverage_scope_mismatch")
            for evidence_id in coverage.evidence_ids:
                evidence_row = await connection.fetchrow(
                    """SELECT 1 FROM evidence_envelopes
                       WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3
                         AND evidence_id=$4 AND acl_subjects ? $5""",
                    commit.projection.tenant_id, commit.projection.case_id,
                    commit.projection.case_revision, evidence_id, audit.subject_id,
                )
                if evidence_row is None:
                    raise PolicyViolation("capability_result_coverage_evidence_unknown_or_unauthorized")
            await self._persist_coverage_entry(connection, coverage)
        await self._action_checkpoint("after_evidence_admission")
        existing_audit = await connection.fetchrow(
            "SELECT payload FROM tool_calls WHERE tenant_id=$1 AND tool_call_id=$2",
            audit.tenant_id, audit.audit_id,
        )
        if existing_audit is not None:
            if CapabilityAuditRecord.parse_obj(_decode(existing_audit["payload"])) != audit:
                raise PolicyViolation("workspace_capability_audit_immutable")
        else:
            await connection.execute(
                """INSERT INTO tool_calls
                   (tool_call_id, case_id, tenant_id, activity_id, capability, status, request_hash,
                    response_artifact_key, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8::jsonb,$9)""",
                audit.audit_id, audit.case_id, audit.tenant_id, audit.activity_id,
                audit.capability.value, audit.status, audit.request_hash, _payload(audit), audit.created_at,
            )
        await self._action_checkpoint("after_audit")

    async def _verify_workspace_action_commit(
        self, connection: asyncpg.Connection, commit: WorkspaceActionCommit,
    ) -> None:
        """Verify a stored outbox record still has its complete ledger set."""
        validate_workspace_action_commit_kind(commit)
        projection = await connection.fetchrow(
            """SELECT payload FROM incident_projections
               WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3 AND projection_revision=$4""",
            commit.projection.tenant_id, commit.projection.run_id,
            commit.projection.topology_revision, commit.projection.projection_revision,
        )
        receipt = await connection.fetchrow(
            """SELECT payload FROM workspace_action_receipts
               WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
            commit.receipt.tenant_id, commit.receipt.case_id, commit.receipt.idempotency_key,
        )
        event = await connection.fetchrow(
            """SELECT payload FROM incident_projection_events
               WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3 AND sequence=$4""",
            commit.event.tenant_id, commit.event.run_id, commit.event.topology_revision, commit.event.sequence,
        )
        if (
            projection is None or receipt is None or event is None
            or IncidentProjection.parse_obj(_decode(projection["payload"])) != commit.projection
            or WorkspaceActionReceipt.parse_obj(_decode(receipt["payload"])) != commit.receipt
            or IncidentEvent.parse_obj(_decode(event["payload"])) != commit.event
        ):
            raise PolicyViolation("workspace_action_transition_partial")
        if commit.lease is not None:
            lease = await connection.fetchrow(
                """SELECT payload FROM workspace_gate1_leases
                   WHERE tenant_id=$1 AND lease_id=$2 AND lease_revision=$3""",
                commit.lease.tenant_id, commit.lease.lease_id, commit.lease.lease_revision,
            )
            if lease is None or Gate1Lease.parse_obj(_decode(lease["payload"])) != commit.lease:
                raise PolicyViolation("workspace_action_transition_partial")
        for action in commit.actions:
            row = await connection.fetchrow(
                """SELECT payload FROM next_best_actions
                   WHERE tenant_id=$1 AND action_id=$2 AND card_version=$3""",
                action.tenant_id, action.action_id, action.card_version,
            )
            if row is None or NextBestAction.parse_obj(_decode(row["payload"])) != action:
                raise PolicyViolation("workspace_action_transition_partial")
        if commit.issued_action is not None:
            row = await connection.fetchrow(
                """SELECT payload FROM next_best_actions
                   WHERE tenant_id=$1 AND action_id=$2 AND card_version=$3""",
                commit.issued_action.tenant_id, commit.issued_action.action_id, commit.issued_action.card_version,
            )
            if row is None or NextBestAction.parse_obj(_decode(row["payload"])) != commit.issued_action:
                raise PolicyViolation("workspace_action_transition_partial")
        if commit.capability_result is not None:
            audit = commit.capability_audit
            if audit is None:
                raise PolicyViolation("workspace_action_transition_partial")
            audit_row = await connection.fetchrow(
                "SELECT payload FROM tool_calls WHERE tenant_id=$1 AND tool_call_id=$2",
                audit.tenant_id, audit.audit_id,
            )
            if audit_row is None or CapabilityAuditRecord.parse_obj(_decode(audit_row["payload"])) != audit:
                raise PolicyViolation("workspace_action_transition_partial")
            immutable_input_evidence = {}
            for evidence_id in audit.input_evidence_refs:
                input_row = await connection.fetchrow(
                    """SELECT payload FROM evidence_envelopes
                       WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3
                         AND evidence_id=$4 AND acl_subjects ? $5""",
                    commit.projection.tenant_id, commit.projection.case_id, commit.projection.case_revision,
                    evidence_id, audit.subject_id,
                )
                if input_row is None:
                    raise PolicyViolation("workspace_action_transition_partial")
                immutable_input_evidence[evidence_id] = EvidenceEnvelope.parse_obj(_decode(input_row["payload"]))
            try:
                validate_fresh_read_evidence_admission(
                    commit.capability_result, audit, commit.projection, immutable_input_evidence,
                )
            except PolicyViolation as error:
                raise PolicyViolation("workspace_action_transition_partial") from error
            for evidence in commit.capability_result.evidence:
                row = await connection.fetchrow(
                    "SELECT payload FROM evidence_envelopes WHERE tenant_id=$1 AND evidence_id=$2",
                    evidence.tenant_id, evidence.evidence_id,
                )
                if row is None or EvidenceEnvelope.parse_obj(_decode(row["payload"])) != evidence:
                    raise PolicyViolation("workspace_action_transition_partial")
            for claim in commit.capability_result.claims:
                row = await connection.fetchrow(
                    "SELECT payload FROM claim_records WHERE tenant_id=$1 AND claim_id=$2",
                    claim.tenant_id, claim.claim_id,
                )
                if row is None or ClaimRecord.parse_obj(_decode(row["payload"])) != claim:
                    raise PolicyViolation("workspace_action_transition_partial")
            for coverage in commit.capability_result.coverage:
                rows = await connection.fetch(
                    """SELECT payload FROM coverage_entries
                       WHERE tenant_id=$1 AND case_id=$2 AND field=$3 AND status=$4""",
                    coverage.tenant_id, coverage.case_id, coverage.field, coverage.status.value,
                )
                if (
                    len(rows) != 1
                    or CoverageEntry.parse_obj(_decode(rows[0]["payload"])) != coverage
                ):
                    raise PolicyViolation("workspace_action_transition_partial")

    async def workspace_action_commit(
        self, tenant_id: str, case_id: str, idempotency_key: str,
    ) -> Optional[WorkspaceActionCommit]:
        """Read only a complete action outbox record; partial legacy writes fail closed."""
        async def operation(connection: asyncpg.Connection) -> Optional[WorkspaceActionCommit]:
            row = await connection.fetchrow(
                """SELECT payload FROM workspace_action_transitions
                   WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
                tenant_id, case_id, idempotency_key,
            )
            if row is None:
                partial = await connection.fetchrow(
                    """SELECT 1 FROM workspace_action_receipts
                       WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
                    tenant_id, case_id, idempotency_key,
                )
                if partial is not None:
                    raise PolicyViolation("workspace_action_transition_partial")
                return None
            commit = WorkspaceActionCommit.parse_obj(_decode(row["payload"]))
            if (
                commit.receipt.tenant_id != tenant_id or commit.receipt.case_id != case_id
                or commit.receipt.idempotency_key != idempotency_key
            ):
                raise PolicyViolation("workspace_action_transition_partial")
            # The transition carries the only authoritative capability actor;
            # re-establish that subject-local ACL before verifying its evidence
            # ledger.  A caller cannot choose this value on the read API.
            if commit.capability_audit is not None:
                await connection.execute(
                    "SELECT set_config('app.subject_id', $1, true)",
                    commit.capability_audit.subject_id,
                )
            await self._verify_workspace_action_commit(connection, commit)
            return commit
        return await self._tenant(tenant_id, operation)

    async def commit_workspace_action_transition(self, commit: WorkspaceActionCommit) -> WorkspaceActionCommit:
        """Append every Gate 1 result in one transaction or persist none of it."""
        validate_workspace_action_commit_kind(commit)
        binding = _workspace_binding(commit.projection)
        if (
            _workspace_binding(commit.receipt) != binding
            or _workspace_binding(commit.event) != binding
            or (commit.lease is not None and _workspace_binding(commit.lease) != binding)
            or any(_workspace_binding(action) != binding for action in commit.actions)
            or (commit.issued_action is not None and _workspace_binding(commit.issued_action) != binding)
            or (commit.capability_audit is not None and _workspace_binding(commit.capability_audit) != binding)
        ):
            raise PolicyViolation("workspace_action_transition_binding_mismatch")

        async def operation(connection: asyncpg.Connection) -> WorkspaceActionCommit:
            await _lock_workspace_mapping(connection, binding)
            binding_row = await connection.fetchrow(
                "SELECT payload FROM incident_run_bindings WHERE tenant_id=$1 AND run_id=$2",
                binding.tenant_id, binding.run_id,
            )
            if binding_row is None or _workspace_binding(_decode(binding_row["payload"])) != binding:
                raise PolicyViolation("workspace_public_internal_binding_mismatch")
            existing = await connection.fetchrow(
                """SELECT payload FROM workspace_action_transitions
                   WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
                commit.receipt.tenant_id, commit.receipt.case_id, commit.receipt.idempotency_key,
            )
            if existing is not None:
                recorded = WorkspaceActionCommit.parse_obj(_decode(existing["payload"]))
                if recorded != commit:
                    raise PolicyViolation("workspace_action_idempotency_conflict")
                await self._verify_workspace_action_commit(connection, recorded)
                return recorded
            partial = await connection.fetchrow(
                """SELECT 1 FROM workspace_action_receipts
                   WHERE tenant_id=$1 AND case_id=$2 AND idempotency_key=$3""",
                commit.receipt.tenant_id, commit.receipt.case_id, commit.receipt.idempotency_key,
            )
            if partial is not None:
                raise PolicyViolation("workspace_action_transition_partial")

            if commit.issued_action is not None:
                stored_action = await connection.fetchrow(
                    """SELECT payload FROM next_best_actions
                       WHERE tenant_id=$1 AND case_id=$2 AND action_id=$3""",
                    commit.issued_action.tenant_id, commit.issued_action.case_id, commit.issued_action.action_id,
                )
                if (
                    stored_action is None
                    or NextBestAction.parse_obj(_decode(stored_action["payload"])) != commit.issued_action
                ):
                    raise PolicyViolation("workspace_action_issued_card_not_authoritative")
            if commit.lease is not None and commit.receipt.status == "GATE1_GRANTED":
                projection_row = await connection.fetchrow(
                    """SELECT payload FROM incident_projections
                       WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3 AND case_id=$4
                       ORDER BY projection_revision DESC LIMIT 1""",
                    binding.tenant_id, binding.run_id, binding.topology_revision, binding.case_id,
                )
                stored_card_row = await connection.fetchrow(
                    """SELECT payload FROM next_best_actions
                       WHERE tenant_id=$1 AND case_id=$2 AND action_id=$3""",
                    commit.receipt.tenant_id, commit.receipt.case_id, commit.receipt.action_id,
                )
                subject_grant_row = await connection.fetchrow(
                    """SELECT roles, permissions, created_at FROM workspace_subject_grants
                       WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3""",
                    commit.lease.tenant_id, commit.lease.case_id, commit.lease.subject_id,
                )
                if projection_row is None:
                    raise PolicyViolation("gate1_grant_projection_not_found")
                subject_grant = None
                if subject_grant_row is not None:
                    subject_grant = WorkspaceSubjectGrant(
                        tenant_id=commit.lease.tenant_id, case_id=commit.lease.case_id,
                        subject_id=commit.lease.subject_id,
                        roles=_decode(subject_grant_row["roles"]),
                        permissions=_decode(subject_grant_row["permissions"]),
                        created_at=subject_grant_row["created_at"],
                    )
                now = await self._workspace_transition_now(connection)
                validate_authoritative_gate1_grant_transition(
                    IncidentProjection.parse_obj(_decode(projection_row["payload"])),
                    NextBestAction.parse_obj(_decode(stored_card_row["payload"])) if stored_card_row else None,
                    subject_grant, self.workspace_capability_registry, commit, now,
                )
            if commit.lease is not None and commit.lease.status.value == "CONSUMED":
                active = await connection.fetchrow(
                    """SELECT payload FROM workspace_gate1_leases
                       WHERE tenant_id=$1 AND case_id=$2 AND lease_id=$3
                       ORDER BY lease_revision DESC LIMIT 1""",
                    commit.lease.tenant_id, commit.lease.case_id, commit.lease.lease_id,
                )
                if active is None:
                    raise PolicyViolation("gate1_lease_not_found")
                active_lease = Gate1Lease.parse_obj(_decode(active["payload"]))
                grant_rows = await connection.fetch(
                    """SELECT payload FROM workspace_action_transitions
                       WHERE tenant_id=$1 AND case_id=$2
                         AND payload #>> '{receipt,status}' = 'GATE1_GRANTED'
                         AND payload #>> '{lease,lease_id}' = $3""",
                    commit.lease.tenant_id, commit.lease.case_id, commit.lease.lease_id,
                )
                if len(grant_rows) > 1:
                    raise PolicyViolation("gate1_lease_grant_transition_ambiguous")
                now = await self._workspace_transition_now(connection)
                read_card = validate_authoritative_gate1_read_card(
                    active_lease,
                    WorkspaceActionCommit.parse_obj(_decode(grant_rows[0]["payload"])) if grant_rows else None,
                    commit, now,
                )
                validate_consumed_gate1_lease_transition(
                    active_lease, commit.lease, command_fingerprint=commit.command_fingerprint,
                    capability_audit=commit.capability_audit, receipt=commit.receipt,
                    activity_identity=commit.activity_identity, capability_result=commit.capability_result,
                    read_card=read_card, now=now,
                )

            # This happens before every action projection write but remains in
            # the same transaction.  A source/admission/audit/checkpoint
            # failure therefore cannot advance the authoritative Gate lease.
            await self._persist_workspace_action_capability(connection, commit)

            duplicate = await connection.fetchrow(
                """SELECT payload FROM incident_projections
                   WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3
                     AND (projection_revision=$4 OR sequence=$5)
                   ORDER BY projection_revision DESC LIMIT 1""",
                commit.projection.tenant_id, commit.projection.run_id, commit.projection.topology_revision,
                commit.projection.projection_revision, commit.projection.sequence,
            )
            if duplicate is not None:
                raise PolicyViolation("workspace_action_transition_partial")
            latest = await connection.fetchrow(
                """SELECT projection_revision, sequence FROM incident_projections
                   WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3
                   ORDER BY projection_revision DESC LIMIT 1""",
                commit.projection.tenant_id, commit.projection.run_id, commit.projection.topology_revision,
            )
            if latest is not None and (
                commit.projection.projection_revision <= latest["projection_revision"]
                or commit.projection.sequence <= latest["sequence"]
            ):
                raise PolicyViolation("workspace_projection_revision_or_sequence_not_monotonic")
            await connection.execute(
                """INSERT INTO incident_projections
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id, workflow_run_id,
                    projection_revision, sequence, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)""",
                commit.projection.tenant_id, commit.projection.incident_id, commit.projection.run_id,
                commit.projection.topology_revision, commit.projection.case_id, commit.projection.case_revision,
                commit.projection.workflow_id, commit.projection.workflow_run_id,
                commit.projection.projection_revision, commit.projection.sequence,
                _payload(commit.projection), commit.projection.generated_at,
            )
            await self._action_checkpoint("after_projection")

            if commit.lease is not None:
                await connection.execute(
                    """INSERT INTO workspace_gate1_leases
                       (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                        workflow_run_id, lease_id, lease_revision, status, consumed_by_activity_id, expires_at, payload, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)""",
                    commit.lease.tenant_id, commit.lease.incident_id, commit.lease.run_id,
                    commit.lease.topology_revision, commit.lease.case_id, commit.lease.case_revision,
                    commit.lease.workflow_id, commit.lease.workflow_run_id, commit.lease.lease_id,
                    commit.lease.lease_revision, commit.lease.status.value, commit.lease.consumed_by_activity_id,
                    commit.lease.expires_at, _payload(commit.lease), commit.lease.created_at,
                )
            await self._action_checkpoint("after_lease")

            for action in commit.actions:
                await connection.execute(
                    """INSERT INTO next_best_actions
                       (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                        workflow_run_id, action_id, card_version, projection_revision, action_revision, expires_at,
                        payload, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)""",
                    action.tenant_id, action.incident_id, action.run_id, action.topology_revision, action.case_id,
                    action.case_revision, action.workflow_id, action.workflow_run_id, action.action_id,
                    action.card_version, action.projection_revision, action.action_revision, action.expires_at,
                    _payload(action), action.created_at,
                )
            await self._action_checkpoint("after_cards")

            await connection.execute(
                """INSERT INTO workspace_action_receipts
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, action_id, idempotency_key, status, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)""",
                commit.receipt.tenant_id, commit.receipt.incident_id, commit.receipt.run_id,
                commit.receipt.topology_revision, commit.receipt.case_id, commit.receipt.case_revision,
                commit.receipt.workflow_id, commit.receipt.workflow_run_id, commit.receipt.action_id,
                commit.receipt.idempotency_key, commit.receipt.status, _payload(commit.receipt), commit.receipt.created_at,
            )
            await self._action_checkpoint("after_receipt")

            event_id = uuid5(
                NAMESPACE_URL,
                "workspace-event:{}:{}:{}:{}".format(
                    commit.event.tenant_id, commit.event.run_id, commit.event.topology_revision, commit.event.sequence,
                ),
            )
            await connection.execute(
                """INSERT INTO incident_projection_events
                   (event_id, tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, projection_revision, sequence, event_type, payload, occurred_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)""",
                event_id, commit.event.tenant_id, commit.event.incident_id, commit.event.run_id,
                commit.event.topology_revision, commit.event.case_id, commit.event.case_revision,
                commit.event.workflow_id, commit.event.workflow_run_id, commit.event.projection_revision,
                commit.event.sequence, commit.event.event_type, _payload(commit.event), commit.event.occurred_at,
            )
            await self._action_checkpoint("after_event")

            await connection.execute(
                """INSERT INTO workspace_action_transitions
                   (tenant_id, incident_id, run_id, topology_revision, case_id, case_revision, workflow_id,
                    workflow_run_id, idempotency_key, action_id, activity_identity, command_fingerprint,
                    projection_revision, event_sequence, event_type, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)""",
                binding.tenant_id, binding.incident_id, binding.run_id, binding.topology_revision,
                binding.case_id, binding.case_revision, binding.workflow_id, binding.workflow_run_id,
                commit.receipt.idempotency_key, commit.receipt.action_id, commit.activity_identity,
                commit.command_fingerprint, commit.projection.projection_revision, commit.event.sequence,
                commit.event.event_type, _payload(commit), commit.receipt.created_at,
            )
            await self._action_checkpoint("after_transition")
            return commit
        return await self._tenant(
            binding.tenant_id, operation,
            subject_id=(commit.capability_audit.subject_id if commit.capability_audit is not None else None),
        )

    async def _assert_capability_scope_connection(
        self, connection: asyncpg.Connection, context: CapabilityInvocationContext,
    ) -> None:
        """Resolve the full public/internal scope before every adapter execution/audit."""
        case_row = await connection.fetchrow(
            "SELECT payload FROM incident_cases WHERE tenant_id=$1 AND case_id=$2",
            context.tenant_id, context.case_id,
        )
        if case_row is None:
            raise PolicyViolation("capability_scope_case_not_found")
        case = IncidentCase.parse_obj(_decode(case_row["payload"]))
        if (
            case.case_revision != context.case_revision
            or case.workflow_id != context.workflow_id
            or case.workflow_run_id != context.workflow_run_id
        ):
            raise PolicyViolation("capability_scope_case_or_revision_mismatch")
        if context.scope == CapabilityScope.USER_QA:
            binding_row = await connection.fetchrow(
                "SELECT payload FROM incident_run_bindings WHERE tenant_id=$1 AND run_id=$2",
                context.tenant_id, context.run_id,
            )
            if binding_row is None or _workspace_binding(_decode(binding_row["payload"])) != _workspace_binding(context):
                raise PolicyViolation("capability_scope_public_internal_binding_mismatch")
            projection_row = await connection.fetchrow(
                """SELECT payload FROM incident_projections
                   WHERE tenant_id=$1 AND run_id=$2 AND topology_revision=$3
                     AND case_id=$4 AND case_revision=$5 AND projection_revision=$6""",
                context.tenant_id, context.run_id, context.topology_revision, context.case_id,
                context.case_revision, context.projection_revision,
            )
            if projection_row is None:
                raise PolicyViolation("capability_scope_projection_revision_mismatch")
            projection = IncidentProjection.parse_obj(_decode(projection_row["payload"]))
            if projection.evidence_revision != context.evidence_revision:
                raise PolicyViolation("capability_scope_evidence_revision_mismatch")
            if not set(context.component_ids).issubset({node.component_id for node in projection.graph.nodes}):
                raise PolicyViolation("capability_scope_component_binding_mismatch")
            if not await connection.fetchval(
                """SELECT EXISTS(
                       SELECT 1 FROM workspace_subject_grants
                       WHERE tenant_id=$1 AND case_id=$2 AND subject_id=$3
                   )""",
                context.tenant_id, context.case_id, context.subject_id,
            ):
                raise PolicyViolation("capability_scope_workspace_subject_acl_denied")
            for evidence_id in context.recorded_evidence_ids:
                evidence_row = await connection.fetchrow(
                    """SELECT payload FROM evidence_envelopes
                       WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3
                         AND evidence_id=$4 AND acl_subjects ? $5""",
                    context.tenant_id, context.case_id, context.case_revision, evidence_id, context.subject_id,
                )
                if evidence_row is None:
                    raise PolicyViolation("capability_scope_recorded_evidence_acl_or_lineage_denied")
            return
        if (
            case.public_incident_id != context.incident_id
            or case.public_run_id != context.run_id
            or case.public_topology_revision != context.topology_revision
        ):
            raise PolicyViolation("capability_scope_autonomous_public_binding_mismatch")
        if not set(context.component_ids).issubset(set(case.affected_entities)):
            raise PolicyViolation("capability_scope_component_binding_mismatch")

    async def assert_capability_scope(self, context: CapabilityInvocationContext) -> None:
        async def operation(connection: asyncpg.Connection) -> None:
            await self._assert_capability_scope_connection(connection, context)
        await self._tenant(context.tenant_id, operation, subject_id=context.subject_id)

    async def append_capability_audit(self, audit: CapabilityAuditRecord) -> CapabilityAuditRecord:
        """Append one shared audit after its full scope was resolved authoritatively."""
        async def operation(connection: asyncpg.Connection) -> CapabilityAuditRecord:
            context = CapabilityInvocationContext.parse_obj({
                **{
                    field: getattr(audit, field)
                    for field in IncidentRunBinding.__fields__
                },
                "projection_revision": audit.projection_revision,
                "evidence_revision": audit.evidence_revision,
                "activity_id": audit.activity_id,
                "scope": audit.scope,
                "subject_id": audit.subject_id,
                "component_ids": [audit.component_id],
                "authorized_subjects": [audit.subject_id], "subject_roles": [],
                "data_class": audit.data_class,
                "recorded_evidence_ids": audit.input_evidence_refs,
                "gate1_authorized": audit.required_gate.value == "GATE1",
                "system_authorized": audit.scope == CapabilityScope.AUTONOMOUS_DIAGNOSIS,
            })
            await self._assert_capability_scope_connection(connection, context)
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "capability-audit:{}:{}:{}".format(audit.tenant_id, audit.case_id, audit.audit_id),
            )
            existing = await connection.fetchrow(
                "SELECT payload FROM tool_calls WHERE tenant_id=$1 AND tool_call_id=$2",
                audit.tenant_id, audit.audit_id,
            )
            if existing is not None:
                recorded = CapabilityAuditRecord.parse_obj(_decode(existing["payload"]))
                if recorded != audit:
                    raise PolicyViolation("workspace_capability_audit_immutable")
                return recorded
            await connection.execute(
                """INSERT INTO tool_calls
                   (tool_call_id, case_id, tenant_id, activity_id, capability, status, request_hash,
                    response_artifact_key, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8::jsonb,$9)""",
                audit.audit_id, audit.case_id, audit.tenant_id, audit.activity_id,
                audit.capability.value, audit.status, audit.request_hash, _payload(audit), audit.created_at,
            )
            return audit
        return await self._tenant(audit.tenant_id, operation, subject_id=audit.subject_id)

    append_workspace_capability_audit = append_capability_audit

    async def create_auth_command_intent(
        self, actor: AuthContext, case: IncidentCase, proposal_id: Optional[str] = None,
        approval_id: Optional[str] = None,
    ) -> AuthCommandIntent:
        """Persist server-side mint scope from trusted HTTP identity and projection."""
        authoritative = await self.get_case(actor.tenant_id, case.case_id)
        if authoritative is None:
            raise PolicyViolation("authorization_intent_unknown_case")
        if authoritative.workflow_run_id != case.workflow_run_id:
            raise PolicyViolation("authorization_intent_workflow_run_mismatch")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=authoritative.case_id, case_revision=authoritative.case_revision,
            workflow_run_id=authoritative.workflow_run_id, proposal_id=proposal_id, approval_id=approval_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
        )
        await self._put_auth_command_intent(intent)
        return intent

    async def _put_auth_command_intent(self, intent: AuthCommandIntent) -> None:
        """Store an immutable server-issued scope; public workspace fields live in its typed payload."""
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """INSERT INTO auth_command_intents
                   (intent_id, tenant_id, case_id, case_revision, workflow_run_id, proposal_id, approval_id,
                    subject_id, roles, status, expires_at, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'PENDING',$10,$11::jsonb)""",
                intent.intent_id, intent.tenant_id, intent.case_id, intent.case_revision, intent.workflow_run_id,
                intent.proposal_id, intent.approval_id, intent.subject_id, json.dumps(intent.roles),
                intent.expires_at, _payload(intent),
            )
        await self._tenant(intent.tenant_id, operation, subject_id=intent.subject_id)

    async def create_workspace_node_explanation_intent(
        self, actor: AuthContext, projection: IncidentProjection, command: NodeExplanationStart,
    ) -> AuthCommandIntent:
        """Create the sole mintable scope after authoritative binding, revision, and subject checks."""
        binding = await self.workspace_binding(actor.tenant_id, projection.case_id)
        if binding is None or binding != _workspace_binding(projection):
            raise PolicyViolation("workspace_authorization_binding_not_authoritative")
        authoritative = await self.workspace_projection(actor.tenant_id, projection.case_id)
        if authoritative is None or authoritative != projection:
            raise PolicyViolation("workspace_authorization_projection_not_authoritative")
        if (
            command.incident_id != binding.incident_id or command.run_id != binding.run_id
            or command.topology_revision != binding.topology_revision
            or command.projection_revision != projection.projection_revision
            or command.component_id not in {node.component_id for node in projection.graph.nodes}
        ):
            raise PolicyViolation("workspace_authorization_command_scope_mismatch")
        if not await self.workspace_subject_authorized(actor.tenant_id, projection.case_id, actor.subject_id):
            raise PolicyViolation("workspace_authorization_subject_acl_denied")
        case = await self.get_case(actor.tenant_id, projection.case_id)
        if case is None or (
            case.case_revision != binding.case_revision or case.workflow_run_id != binding.workflow_run_id
        ):
            raise PolicyViolation("workspace_authorization_case_not_authoritative")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="workspace-intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=binding.case_id, case_revision=binding.case_revision, workflow_run_id=binding.workflow_run_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
            command_kind=AuthCommandKind.WORKSPACE_NODE_EXPLANATION,
            workspace_incident_id=binding.incident_id, workspace_run_id=binding.run_id,
            workspace_topology_revision=binding.topology_revision,
            workspace_projection_revision=projection.projection_revision,
            workspace_component_id=command.component_id, workspace_command_hash=command.canonical_hash(),
        )
        await self._put_auth_command_intent(intent)
        return intent

    async def create_workspace_action_intent(
        self, actor: AuthContext, projection: IncidentProjection, command: ActionInvocationCommand,
    ) -> AuthCommandIntent:
        """Mint only a reloaded, current server card into an action assertion."""
        binding = await self.workspace_binding(actor.tenant_id, projection.case_id)
        if binding is None or binding != _workspace_binding(projection):
            raise PolicyViolation("workspace_action_binding_not_authoritative")
        authoritative = await self.workspace_projection(actor.tenant_id, projection.case_id)
        if authoritative is None or authoritative != projection:
            raise PolicyViolation("workspace_action_projection_not_authoritative")
        action = await self.workspace_next_best_action(actor.tenant_id, projection.case_id, command.action_id)
        if action is None:
            raise PolicyViolation("workspace_action_not_found")
        if not await self.workspace_subject_authorized(actor.tenant_id, projection.case_id, actor.subject_id):
            raise PolicyViolation("workspace_action_subject_acl_denied")
        permissions = (
            ["incident:read"]
            if set(actor.roles).intersection({"viewer", "owner", "local-test-owner"})
            else []
        )
        from .workspace_actions import validate_current_action_card
        validate_current_action_card(action, projection, command, permissions, datetime.now(timezone.utc))
        case = await self.get_case(actor.tenant_id, projection.case_id)
        if case is None or (
            case.case_revision != binding.case_revision or case.workflow_run_id != binding.workflow_run_id
        ):
            raise PolicyViolation("workspace_action_case_not_authoritative")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="workspace-action-intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=binding.case_id, case_revision=binding.case_revision, workflow_run_id=binding.workflow_run_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
            command_kind=AuthCommandKind.WORKSPACE_ACTION,
            workspace_incident_id=binding.incident_id, workspace_run_id=binding.run_id,
            workspace_topology_revision=binding.topology_revision,
            workspace_projection_revision=projection.projection_revision,
            workspace_action_id=action.action_id, workspace_action_command_hash=command.canonical_hash(),
        )
        await self._put_auth_command_intent(intent)
        return intent

    async def consume_auth_command_intent(
        self, tenant_id: str, intent_id: str, expected_kind: AuthCommandKind = AuthCommandKind.OWNER_GATE,
    ) -> AuthCommandIntent:
        """Mint once from the authoritative projection; body claims cannot change scope."""
        async def operation(connection: asyncpg.Connection) -> AuthCommandIntent:
            row = await connection.fetchrow(
                """SELECT payload FROM auth_command_intents
                   WHERE tenant_id=$1 AND intent_id=$2 AND status='PENDING' AND expires_at > now()
                   FOR UPDATE""",
                tenant_id, intent_id,
            )
            if row is None:
                raise PolicyViolation("authorization_intent_unknown_expired_or_consumed")
            intent = AuthCommandIntent.parse_obj(_decode(row["payload"]))
            if intent.command_kind != expected_kind:
                raise PolicyViolation("authorization_intent_command_kind_mismatch")
            case_row = await connection.fetchrow(
                """SELECT payload FROM incident_cases
                   WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3 AND workflow_run_id=$4""",
                intent.tenant_id, intent.case_id, intent.case_revision, intent.workflow_run_id,
            )
            if case_row is None:
                raise PolicyViolation("authorization_intent_case_scope_not_authoritative")
            await connection.execute(
                "UPDATE auth_command_intents SET status='MINTED', minted_at=now() WHERE tenant_id=$1 AND intent_id=$2",
                tenant_id, intent_id,
            )
            return intent
        return await self._tenant(tenant_id, operation)

    async def consume_workspace_node_explanation_intent(self, tenant_id: str, intent_id: str) -> AuthCommandIntent:
        return await self.consume_auth_command_intent(
            tenant_id, intent_id, AuthCommandKind.WORKSPACE_NODE_EXPLANATION,
        )

    async def consume_workspace_action_intent(self, tenant_id: str, intent_id: str) -> AuthCommandIntent:
        return await self.consume_auth_command_intent(
            tenant_id, intent_id, AuthCommandKind.WORKSPACE_ACTION,
        )

    async def put_case(self, case: IncidentCase) -> None:
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """
                INSERT INTO incident_cases
                  (case_id, tenant_id, case_revision, workflow_id, workflow_run_id, state, payload, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
                ON CONFLICT (case_id) DO UPDATE SET
                  workflow_id=EXCLUDED.workflow_id,
                  workflow_run_id=EXCLUDED.workflow_run_id,
                  updated_at=GREATEST(incident_cases.updated_at, EXCLUDED.updated_at)
                """,
                case.case_id, case.tenant_id, case.case_revision, case.workflow_id, case.workflow_run_id,
                case.state.value, _payload(case), case.created_at, case.updated_at,
            )
        await self._tenant(case.tenant_id, operation)

    async def project_case_state(
        self, packet: TemporalActivityPacket, state: CaseState, reason_codes: List[str] = None,
    ) -> IncidentCase:
        """Update only the Temporal-derived query projection for this exact run."""
        async def operation(connection: asyncpg.Connection) -> IncidentCase:
            row = await connection.fetchrow(
                "SELECT payload, workflow_run_id FROM incident_cases WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE",
                packet.tenant_id, packet.case_id,
            )
            if row is None or row["workflow_run_id"] != packet.workflow_run_id:
                raise PolicyViolation("projection_case_or_workflow_run_mismatch")
            current = IncidentCase.parse_obj(_decode(row["payload"]))
            updated = current.copy(update={
                "state": state,
                "updated_at": datetime.now(timezone.utc),
                "blocker_code": (reason_codes or [None])[0],
            })
            await connection.execute(
                """UPDATE incident_cases SET state=$3, payload=$4::jsonb, updated_at=$5
                   WHERE tenant_id=$1 AND case_id=$2 AND workflow_run_id=$6""",
                packet.tenant_id, packet.case_id, updated.state.value, _payload(updated),
                updated.updated_at, packet.workflow_run_id,
            )
            return updated
        return await self._tenant(packet.tenant_id, operation)

    async def put_evidence(self, evidence: EvidenceEnvelope, subject_id: str) -> None:
        validate_evidence_admission(evidence, subject_id)
        case = await self.get_case(evidence.tenant_id, evidence.case_id)
        if case is None or case.case_revision != evidence.case_revision:
            raise PolicyViolation("evidence_case_tenant_or_revision_mismatch")
        async def operation(connection: asyncpg.Connection) -> None:
            existing = await connection.fetchrow(
                "SELECT payload FROM evidence_envelopes WHERE evidence_id=$1", evidence.evidence_id,
            )
            if existing is not None:
                if EvidenceEnvelope.parse_obj(_decode(existing["payload"])) != evidence:
                    raise PolicyViolation("evidence_id_immutable")
                return
            for parent_evidence_id in evidence.parent_evidence_ids:
                if parent_evidence_id == evidence.evidence_id:
                    raise PolicyViolation("evidence_parent_self_reference")
                parent = await connection.fetchrow(
                    """SELECT evidence_id FROM evidence_envelopes
                       WHERE tenant_id=$1 AND case_id=$2 AND case_revision=$3 AND evidence_id=$4""",
                    evidence.tenant_id, evidence.case_id, evidence.case_revision, parent_evidence_id,
                )
                if parent is None:
                    raise PolicyViolation("unknown_parent_evidence")
            inserted = await connection.fetchval(
                """
                INSERT INTO evidence_envelopes
                  (evidence_id, case_id, tenant_id, case_revision, acl_subjects, proof_scope, source_uri,
                   source_anchor, content_hash, independence_key, payload)
                VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
                ON CONFLICT (evidence_id) DO NOTHING
                RETURNING evidence_id
                """,
                evidence.evidence_id, evidence.case_id, evidence.tenant_id, evidence.case_revision,
                json.dumps(evidence.acl_subjects), evidence.proof_scope.value, evidence.source_uri,
                evidence.source_anchor, evidence.content_hash, evidence.independence_key, _payload(evidence),
            )
            # An RLS-hidden row with the same global evidence ID must never be
            # treated as a successful cross-tenant admission.
            if inserted is None:
                raise PolicyViolation("evidence_id_conflict_or_not_visible")
        await self._tenant(evidence.tenant_id, operation, subject_id)

    async def evidence_for_case(self, tenant_id: str, case_id: str, subject_id: str) -> List[EvidenceEnvelope]:
        async def operation(connection: asyncpg.Connection) -> List[EvidenceEnvelope]:
            rows = await connection.fetch(
                """SELECT payload FROM evidence_envelopes
                   WHERE tenant_id=$1 AND case_id=$2 AND acl_subjects ? $3 ORDER BY evidence_id""",
                tenant_id, case_id, subject_id,
            )
            return [EvidenceEnvelope.parse_obj(_decode(row["payload"])) for row in rows]
        return await self._tenant(tenant_id, operation, subject_id)

    async def put_claim(self, claim: ClaimRecord, subject_id: str) -> None:
        case = await self.get_case(claim.tenant_id, claim.case_id)
        if case is None or case.case_revision != claim.case_revision:
            raise PolicyViolation("claim_case_revision_mismatch")
        validate_claim_evidence(claim, await self.evidence_for_case(claim.tenant_id, claim.case_id, subject_id), subject_id)
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """
                INSERT INTO claim_records (claim_id, case_id, tenant_id, case_revision, evidence_ids, status, payload)
                VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) ON CONFLICT (claim_id) DO NOTHING
                """,
                claim.claim_id, claim.case_id, claim.tenant_id, claim.case_revision,
                json.dumps(claim.evidence_ids), claim.status.value, _payload(claim),
            )
            for evidence_id in claim.evidence_ids:
                await connection.execute(
                    """INSERT INTO claim_evidence_links
                       (claim_id, evidence_id, case_id, tenant_id, case_revision)
                       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING""",
                    claim.claim_id, evidence_id, claim.case_id, claim.tenant_id, claim.case_revision,
                )
        await self._tenant(claim.tenant_id, operation)

    async def put_coverage(self, entry: CoverageEntry) -> None:
        async def operation(connection: asyncpg.Connection) -> None:
            await self._persist_coverage_entry(connection, entry)
        await self._tenant(entry.tenant_id, operation)

    async def put_assignment(self, assignment: InvestigatorAssignment) -> None:
        case = await self.get_case(assignment.tenant_id, assignment.case_id)
        if case is None or case.case_revision != assignment.case_revision:
            raise PolicyViolation("assignment_case_tenant_or_revision_mismatch")
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """INSERT INTO investigator_assignments
                   (assignment_id, case_id, tenant_id, payload, dispatched_at)
                   VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (assignment_id) DO NOTHING""",
                assignment.assignment_id, assignment.case_id, assignment.tenant_id,
                _payload(assignment), assignment.dispatched_at,
            )
        await self._tenant(assignment.tenant_id, operation)

    async def get_proposal(self, tenant_id: str, proposal_id: str) -> Optional[RemediationProposal]:
        async def operation(connection: asyncpg.Connection) -> Optional[RemediationProposal]:
            row = await connection.fetchrow(
                "SELECT payload FROM remediation_proposals WHERE tenant_id=$1 AND proposal_id=$2", tenant_id, proposal_id
            )
            return RemediationProposal.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def put_proposal(self, proposal: RemediationProposal) -> None:
        case = await self.get_case(proposal.tenant_id, proposal.case_id)
        if case is None or case.case_revision != proposal.case_revision:
            raise PolicyViolation("proposal_case_tenant_or_revision_mismatch")
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """INSERT INTO remediation_proposals
                   (proposal_id, case_id, tenant_id, case_revision, repair_contract_hash, payload)
                   VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (proposal_id) DO NOTHING""",
                proposal.proposal_id, proposal.case_id, proposal.tenant_id, proposal.case_revision,
                repair_contract_hash(proposal), _payload(proposal),
            )
        await self._tenant(proposal.tenant_id, operation)

    async def put_approval(self, approval: OwnerApproval) -> None:
        """Prevent an API/controller from bypassing the Temporal Owner Gate.

        Accepted approval rows are emitted only by ``record_owner_gate`` in
        the same transaction as the verified decision and dry-run receipt.
        """
        raise PolicyViolation("owner_approval_must_be_recorded_by_owner_gate")

    async def record_owner_gate(
        self, packet: TemporalActivityPacket, outcome: ActivityOutcome, authenticated: Optional[AuthContext],
    ) -> ActivityOutcome:
        """Persist candidate, accepted approval, action receipt, and state atomically.

        A body that claims APPROVED is only a candidate until this Temporal
        activity revalidates owner identity, exact contract, TTL, and witness.
        """
        async def operation(connection: asyncpg.Connection) -> ActivityOutcome:
            row = await connection.fetchrow(
                "SELECT payload, workflow_run_id FROM incident_cases WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE",
                packet.tenant_id, packet.case_id,
            )
            if row is None or row["workflow_run_id"] != packet.workflow_run_id:
                raise PolicyViolation("owner_gate_case_or_workflow_run_mismatch")
            case = IncidentCase.parse_obj(_decode(row["payload"]))
            proposal = packet.proposal
            approval = packet.approval
            validated = outcome.decision == VerificationDecision.PASS
            rejection = None
            if proposal is None:
                validated = False
                rejection = "proposal_required"
            elif approval is None:
                validated = False
                rejection = "owner_approval_required"
            elif authenticated is None:
                validated = False
                rejection = "trusted_owner_authorization_unavailable"

            if proposal is not None:
                await connection.execute(
                    """INSERT INTO remediation_proposals
                       (proposal_id, case_id, tenant_id, case_revision, repair_contract_hash, payload)
                       VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (proposal_id) DO NOTHING""",
                    proposal.proposal_id, proposal.case_id, proposal.tenant_id, proposal.case_revision,
                    repair_contract_hash(proposal), _payload(proposal),
                )
            if approval is not None:
                await connection.execute(
                    """INSERT INTO owner_approval_candidates
                       (candidate_id, approval_id, case_id, tenant_id, workflow_run_id, status, payload)
                       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (candidate_id) DO NOTHING""",
                    "candidate-{}-{}".format(packet.workflow_run_id, approval.approval_id), approval.approval_id,
                    approval.case_id, approval.tenant_id, packet.workflow_run_id,
                    "VERIFIED" if validated else "REJECTED", _payload(approval),
                )

            if validated and proposal is not None and approval is not None:
                await connection.execute(
                    """INSERT INTO owner_approvals
                       (approval_id, case_id, tenant_id, proposal_id, case_revision, repair_contract_hash, expires_at, payload)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (approval_id) DO NOTHING""",
                    approval.approval_id, approval.case_id, approval.tenant_id, approval.proposal_id,
                    approval.case_revision, approval.repair_contract_hash, approval.expires_at, _payload(approval),
                )
                receipt = DryRunReceipt(
                    tenant_id=proposal.tenant_id, case_id=proposal.case_id, proposal_id=proposal.proposal_id,
                    repair_contract_hash=repair_contract_hash(proposal), idempotency_key=proposal.idempotency_key,
                    reason="p0_non_executing_dry_run_only",
                )
                await self._record_dry_run(connection, receipt)
                state = CaseState.APPROVED
                reason_codes: List[str] = []
            elif approval is None:
                state = CaseState.AWAITING_OWNER
                reason_codes = [rejection or "owner_approval_required"]
            else:
                state = CaseState.BLOCKED
                reason_codes = [rejection or "owner_gate_rejected"]

            updated = case.copy(update={
                "state": state, "updated_at": datetime.now(timezone.utc),
                "blocker_code": reason_codes[0] if reason_codes else None,
            })
            await connection.execute(
                """UPDATE incident_cases SET state=$3, payload=$4::jsonb, updated_at=$5
                   WHERE tenant_id=$1 AND case_id=$2 AND workflow_run_id=$6""",
                packet.tenant_id, packet.case_id, state.value, _payload(updated), updated.updated_at,
                packet.workflow_run_id,
            )
            return outcome.copy(update={
                "decision": outcome.decision if validated else VerificationDecision.FAIL,
                "state": state,
                "reason_codes": reason_codes or outcome.reason_codes,
            })
        return await self._tenant(packet.tenant_id, operation)

    async def append_activity_event(
        self, packet: TemporalActivityPacket, activity_id: str, result: Dict[str, Any], raw_artifact_key: str
    ) -> None:
        event_id = activity_event_identity(packet, activity_id)
        payload = _payload({"packet": packet.dict(), "result": result, "raw_artifact_key": raw_artifact_key})
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """INSERT INTO case_events
                   (event_id, case_id, tenant_id, workflow_run_id, activity_id, stage, sequence, event_type, payload, occurred_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
                   ON CONFLICT (workflow_run_id, activity_id, stage, sequence) DO NOTHING""",
                event_id, packet.case_id, packet.tenant_id, packet.workflow_run_id, activity_id, packet.stage,
                packet.sequence, "activity." + packet.stage, payload, datetime.now(timezone.utc),
            )
        await self._tenant(packet.tenant_id, operation)

    async def append_verification(self, packet: TemporalActivityPacket, report: VerificationReport) -> None:
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """INSERT INTO verification_reports
                   (verification_id, case_id, tenant_id, case_revision, workflow_run_id, verifier_identity, decision, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (verification_id) DO NOTHING""",
                report.verification_id, report.case_id, report.tenant_id, report.case_revision, packet.workflow_run_id,
                report.verifier_identity, report.decision.value, _payload(report),
            )
        await self._tenant(packet.tenant_id, operation)

    async def _record_dry_run(self, connection: asyncpg.Connection, receipt: DryRunReceipt) -> DryRunReceipt:
        inserted = await connection.fetchrow(
                """INSERT INTO action_executions
                   (execution_id, case_id, tenant_id, proposal_id, repair_contract_hash, idempotency_key, result, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
                   ON CONFLICT (idempotency_key) DO NOTHING
                   RETURNING payload""",
                "dry-run-{}".format(receipt.idempotency_key), receipt.case_id, receipt.tenant_id,
                receipt.proposal_id, receipt.repair_contract_hash, receipt.idempotency_key,
                receipt.status, _payload(receipt),
        )
        if inserted is not None:
            return DryRunReceipt.parse_obj(_decode(inserted["payload"]))
        # RLS deliberately hides a conflicting tenant's receipt. That must
        # still fail closed rather than turn a global unique violation into
        # a 500 or let an idempotency key be rebound.
        existing = await connection.fetchrow(
            "SELECT payload FROM action_executions WHERE idempotency_key=$1", receipt.idempotency_key
        )
        if existing is None:
            raise PolicyViolation("idempotency_key_reuse_across_tenant_case_proposal_or_contract")
        prior = DryRunReceipt.parse_obj(_decode(existing["payload"]))
        if prior != receipt:
            raise PolicyViolation("idempotency_key_reuse_across_tenant_case_proposal_or_contract")
        return prior

    async def record_dry_run(self, receipt: DryRunReceipt) -> DryRunReceipt:
        async def operation(connection: asyncpg.Connection) -> DryRunReceipt:
            return await self._record_dry_run(connection, receipt)
        return await self._tenant(receipt.tenant_id, operation)


class PostgresCapabilityScopeAuthority:
    """Registry authority port backed by the same RLS repository as audits."""

    def __init__(self, repository: PostgresCaseRepository) -> None:
        self.repository = repository

    async def assert_scope(self, invocation_context: CapabilityInvocationContext) -> None:
        await self.repository.assert_capability_scope(invocation_context)

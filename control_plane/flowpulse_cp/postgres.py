"""Tenant-scoped Postgres projections; Temporal remains the state authority."""

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Tuple, TypeVar
from uuid import NAMESPACE_URL, uuid4, uuid5

import asyncpg

from .models import (
    ActivityOutcome,
    AuthContext,
    AuthCommandIntent,
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
from .workspace_models import IncidentEvent, IncidentProjection, IncidentRunBinding, NodeExplanation


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
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool: Optional[asyncpg.Pool] = None

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
        await self._tenant(actor.tenant_id, operation)
        return intent

    async def consume_auth_command_intent(self, tenant_id: str, intent_id: str) -> AuthCommandIntent:
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
                """
                INSERT INTO evidence_envelopes
                  (evidence_id, case_id, tenant_id, case_revision, acl_subjects, proof_scope, source_uri,
                   source_anchor, content_hash, independence_key, payload)
                VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
                ON CONFLICT (evidence_id) DO NOTHING
                """,
                evidence.evidence_id, evidence.case_id, evidence.tenant_id, evidence.case_revision,
                json.dumps(evidence.acl_subjects), evidence.proof_scope.value, evidence.source_uri,
                evidence.source_anchor, evidence.content_hash, evidence.independence_key, _payload(evidence),
            )
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
            await connection.execute(
                """INSERT INTO coverage_entries (entry_id, case_id, tenant_id, field, status, payload)
                   VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING""",
                uuid5(NAMESPACE_URL, "coverage:{}:{}:{}".format(entry.case_id, entry.field, entry.status.value)),
                entry.case_id, entry.tenant_id, entry.field, entry.status.value, _payload(entry),
            )
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

"""Tenant-scoped Postgres projections; Temporal remains the state authority."""

import json
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, TypeVar
from uuid import NAMESPACE_URL, uuid5

import asyncpg

from .models import (
    ClaimRecord,
    CoverageEntry,
    DryRunReceipt,
    EvidenceEnvelope,
    IncidentCase,
    InvestigatorAssignment,
    OwnerApproval,
    RemediationProposal,
    TemporalActivityPacket,
    VerificationReport,
)
from .policy import PolicyViolation, repair_contract_hash, validate_claim_evidence, validate_evidence_admission


T = TypeVar("T")


def _payload(record: Any) -> str:
    return record.json() if hasattr(record, "json") else json.dumps(record, default=str, sort_keys=True)


def _decode(value: Any) -> Dict[str, Any]:
    return json.loads(value) if isinstance(value, str) else value


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

    async def put_case(self, case: IncidentCase) -> None:
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """
                INSERT INTO incident_cases
                  (case_id, tenant_id, case_revision, workflow_id, workflow_run_id, state, payload, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
                ON CONFLICT (case_id) DO NOTHING
                """,
                case.case_id, case.tenant_id, case.case_revision, case.workflow_id, case.workflow_run_id,
                case.state.value, _payload(case), case.created_at, case.updated_at,
            )
        await self._tenant(case.tenant_id, operation)

    async def put_evidence(self, evidence: EvidenceEnvelope, subject_id: str) -> None:
        validate_evidence_admission(evidence, subject_id)
        case = await self.get_case(evidence.tenant_id, evidence.case_id)
        if case is None or case.case_revision != evidence.case_revision:
            raise PolicyViolation("evidence_case_tenant_or_revision_mismatch")
        async def operation(connection: asyncpg.Connection) -> None:
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
        async def operation(connection: asyncpg.Connection) -> None:
            await connection.execute(
                """INSERT INTO owner_approvals
                   (approval_id, case_id, tenant_id, proposal_id, case_revision, repair_contract_hash, expires_at, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (approval_id) DO NOTHING""",
                approval.approval_id, approval.case_id, approval.tenant_id, approval.proposal_id,
                approval.case_revision, approval.repair_contract_hash, approval.expires_at, _payload(approval),
            )
        await self._tenant(approval.tenant_id, operation)

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

    async def record_dry_run(self, receipt: DryRunReceipt) -> DryRunReceipt:
        async def operation(connection: asyncpg.Connection) -> DryRunReceipt:
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
        return await self._tenant(receipt.tenant_id, operation)

"""Tenant-first P0 knowledge plane: prior/reference evidence only."""

from datetime import datetime, timezone
from hashlib import sha256
from typing import Iterable, List, Sequence

from .models import (
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    KnowledgeCandidate,
    KnowledgeRevision,
    KnowledgeStatus,
    ProofScope,
    SourceKind,
)
from .policy import PolicyViolation


class KnowledgePlane:
    """An owner-reviewed document ledger, not an autonomous knowledge agent.

    Bootstrap input deliberately uses the same immutable promotion guard as
    later ingestion.  The caller may only bootstrap already-owner-reviewed
    artifacts; it cannot bypass document, supersession, or revision checks.
    """

    def __init__(self, revisions: Iterable[KnowledgeRevision] = ()) -> None:
        self._revisions = {}
        for revision in revisions:
            self._ingest(revision, owner_reviewed=True)

    @staticmethod
    def _validate_content_hash(revision: KnowledgeRevision) -> None:
        if sha256(revision.content.encode("utf-8")).hexdigest() != revision.content_hash:
            raise PolicyViolation("knowledge_content_hash_mismatch")

    def _ingest(self, revision: KnowledgeRevision, owner_reviewed: bool) -> None:
        if not owner_reviewed:
            raise PolicyViolation("knowledge_promotion_requires_owner_review")
        if revision.status != KnowledgeStatus.ACTIVE:
            raise PolicyViolation("only_active_revision_can_be_promoted")
        self._validate_content_hash(revision)
        existing_id = self._revisions.get(revision.knowledge_revision_id)
        if existing_id is not None:
            if existing_id != revision:
                raise PolicyViolation("knowledge_revision_id_collision")
            return

        document_records = [
            item for item in self._revisions.values()
            if item.tenant_id == revision.tenant_id and item.document_id == revision.document_id
        ]
        same_revision = [item for item in document_records if item.revision == revision.revision]
        if same_revision:
            if any(item.content_hash != revision.content_hash for item in same_revision):
                raise PolicyViolation("knowledge_supersession_revision_not_increasing")
            # Dedup is latest-wins by immutable canonical first ingestion.
            return
        if document_records:
            prior = max(document_records, key=lambda item: item.revision)
            if revision.revision <= prior.revision:
                raise PolicyViolation("knowledge_revision_not_strictly_increasing")
            if revision.supersedes_revision_id != prior.knowledge_revision_id:
                raise PolicyViolation("knowledge_supersession_target_invalid")
            if prior.status != KnowledgeStatus.ACTIVE:
                raise PolicyViolation("knowledge_supersession_target_not_active")
            self._revisions[prior.knowledge_revision_id] = prior.copy(
                update={"status": KnowledgeStatus.SUPERSEDED}
            )
        elif revision.supersedes_revision_id is not None:
            # A foreign-tenant/document id cannot become a valid bootstrap
            # target merely because this plane has not loaded it.
            foreign = self._revisions.get(revision.supersedes_revision_id)
            if foreign is not None and foreign.tenant_id == revision.tenant_id and foreign.document_id != revision.document_id:
                raise PolicyViolation("knowledge_supersession_document_mismatch")
            raise PolicyViolation("knowledge_supersession_target_invalid")
        self._revisions[revision.knowledge_revision_id] = revision

    def retrieve(
        self,
        tenant_id: str,
        actor_id: str,
        case_id: str,
        case_revision: int,
        environment: str,
        entities: Sequence[str],
        need: str,
        now: datetime,
        limit: int = 8,
    ) -> List[KnowledgeCandidate]:
        """Filter tenant/ACL/version before the intentionally simple lexical rank."""
        now = now.astimezone(timezone.utc)
        normalized_need = need.casefold()
        candidates = []
        for revision in self._revisions.values():
            self._validate_content_hash(revision)
            if revision.tenant_id != tenant_id or revision.status != KnowledgeStatus.ACTIVE:
                continue
            if actor_id not in revision.allowed_subjects:
                continue
            if revision.environment != environment or not set(revision.entities).intersection(entities):
                continue
            if revision.effective_at.astimezone(timezone.utc) > now:
                continue
            if revision.expires_at and revision.expires_at.astimezone(timezone.utc) <= now:
                continue
            haystack = (revision.kind + " " + revision.document_id + " " + revision.content).casefold()
            score = 1.0 if normalized_need in haystack else 0.5
            age_seconds = (now - revision.effective_at.astimezone(timezone.utc)).total_seconds()
            freshness = FreshnessStatus.CURRENT if age_seconds <= 7 * 86400 else FreshnessStatus.AGING
            if age_seconds > 30 * 86400:
                continue
            envelope = EvidenceEnvelope(
                evidence_id="kb-{}".format(revision.knowledge_revision_id),
                case_id=case_id, case_revision=case_revision, tenant_id=tenant_id,
                acl_subjects=[actor_id], source_kind=SourceKind.KNOWLEDGE,
                source_uri="knowledge://{}/{}".format(revision.document_id, revision.revision),
                source_anchor=revision.anchor, observed_at=now, effective_at=revision.effective_at,
                source_version=str(revision.revision),
                content_hash=sha256(revision.content.encode("utf-8")).hexdigest(),
                authority=EvidenceAuthority.T3, freshness=freshness,
                independence_key=revision.independence_key, schema_binding="knowledge.{}".format(revision.kind),
                proof_scope=ProofScope.REFERENCE_ONLY,
            )
            candidates.append(KnowledgeCandidate(
                knowledge_revision_id=revision.knowledge_revision_id, evidence=envelope,
                retrieval_score=score, reason="tenant_acl_entity_environment_version_filtered",
            ))
        return sorted(candidates, key=lambda item: (-item.retrieval_score, item.knowledge_revision_id))[:limit]

    def promote(self, revision: KnowledgeRevision, owner_reviewed: bool) -> None:
        """All write paths route through the exact bootstrap validation."""
        self._ingest(revision, owner_reviewed)

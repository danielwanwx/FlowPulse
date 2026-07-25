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
    def __init__(self, revisions: Iterable[KnowledgeRevision] = ()) -> None:
        self._revisions = {item.knowledge_revision_id: item for item in revisions}

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
            content_hash = sha256(revision.content.encode("utf-8")).hexdigest()
            envelope = EvidenceEnvelope(
                evidence_id="kb-{}".format(revision.knowledge_revision_id),
                case_id=case_id,
                case_revision=case_revision,
                tenant_id=tenant_id,
                acl_subjects=[actor_id],
                source_kind=SourceKind.KNOWLEDGE,
                source_uri="knowledge://{}/{}".format(revision.document_id, revision.revision),
                source_anchor=revision.anchor,
                observed_at=now,
                effective_at=revision.effective_at,
                source_version=str(revision.revision),
                content_hash=content_hash,
                authority=EvidenceAuthority.T3,
                freshness=FreshnessStatus.CURRENT,
                independence_key=revision.independence_key,
                schema_binding="knowledge.{}".format(revision.kind),
                proof_scope=ProofScope.REFERENCE_ONLY,
            )
            candidates.append(
                KnowledgeCandidate(
                    knowledge_revision_id=revision.knowledge_revision_id,
                    evidence=envelope,
                    retrieval_score=score,
                    reason="tenant_acl_entity_environment_version_filtered",
                )
            )
        return sorted(candidates, key=lambda item: (-item.retrieval_score, item.knowledge_revision_id))[:limit]

    def promote(self, revision: KnowledgeRevision, owner_reviewed: bool) -> None:
        """P0 keeps promotion explicit and caller-owned; no agent can write here."""
        if not owner_reviewed:
            raise PolicyViolation("knowledge_promotion_requires_owner_review")
        if revision.status != KnowledgeStatus.ACTIVE:
            raise PolicyViolation("only_active_revision_can_be_promoted")
        if revision.knowledge_revision_id in self._revisions:
            raise PolicyViolation("knowledge_revision_immutable")
        if revision.supersedes_revision_id:
            previous = self._revisions.get(revision.supersedes_revision_id)
            if previous is None or previous.tenant_id != revision.tenant_id:
                raise PolicyViolation("knowledge_supersession_target_invalid")
            if previous.status != KnowledgeStatus.ACTIVE:
                raise PolicyViolation("knowledge_supersession_target_not_active")
            self._revisions[previous.knowledge_revision_id] = previous.copy(
                update={"status": KnowledgeStatus.SUPERSEDED}
            )
        self._revisions[revision.knowledge_revision_id] = revision

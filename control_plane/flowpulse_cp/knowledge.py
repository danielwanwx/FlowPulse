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
        self._revisions = {}
        for revision in revisions:
            self._validate_content_hash(revision)
            existing = self._revisions.get(revision.knowledge_revision_id)
            if existing is not None and existing != revision:
                raise PolicyViolation("knowledge_revision_id_collision")
            self._revisions[revision.knowledge_revision_id] = revision
        self._enforce_latest_wins()

    @staticmethod
    def _validate_content_hash(revision: KnowledgeRevision) -> None:
        if sha256(revision.content.encode("utf-8")).hexdigest() != revision.content_hash:
            raise PolicyViolation("knowledge_content_hash_mismatch")

    def _enforce_latest_wins(self) -> None:
        # Keep one canonical object per tenant/document/revision, then let the
        # greatest revision be the sole active record for that document. This
        # prevents duplicate ingestion from surfacing two "current" copies.
        by_document_revision = {}
        for revision_id, revision in sorted(self._revisions.items()):
            key = (revision.tenant_id, revision.document_id, revision.revision)
            prior_id = by_document_revision.get(key)
            if prior_id is None:
                by_document_revision[key] = revision_id
                continue
            prior = self._revisions[prior_id]
            if prior.content_hash != revision.content_hash:
                raise PolicyViolation("knowledge_document_revision_hash_conflict")
            # Deterministic dedup: the lexical-first immutable id is canonical.
            if revision.status == KnowledgeStatus.ACTIVE:
                self._revisions[revision_id] = revision.copy(update={"status": KnowledgeStatus.SUPERSEDED})

        latest_by_document = {}
        for revision in self._revisions.values():
            key = (revision.tenant_id, revision.document_id)
            latest_by_document[key] = max(latest_by_document.get(key, 0), revision.revision)
        for revision_id, revision in list(self._revisions.items()):
            if revision.revision < latest_by_document[(revision.tenant_id, revision.document_id)] and revision.status == KnowledgeStatus.ACTIVE:
                self._revisions[revision_id] = revision.copy(update={"status": KnowledgeStatus.SUPERSEDED})

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
        seen_document_revisions = set()
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
            document_revision = (revision.tenant_id, revision.document_id, revision.revision)
            if document_revision in seen_document_revisions:
                continue
            if revision.expires_at and revision.expires_at.astimezone(timezone.utc) <= now:
                continue
            haystack = (revision.kind + " " + revision.document_id + " " + revision.content).casefold()
            score = 1.0 if normalized_need in haystack else 0.5
            age_seconds = (now - revision.effective_at.astimezone(timezone.utc)).total_seconds()
            freshness = FreshnessStatus.CURRENT if age_seconds <= 7 * 86400 else FreshnessStatus.AGING
            if age_seconds > 30 * 86400:
                # P0 does not inject stale knowledge candidates into model context.
                continue
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
                freshness=freshness,
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
            seen_document_revisions.add(document_revision)
        return sorted(candidates, key=lambda item: (-item.retrieval_score, item.knowledge_revision_id))[:limit]

    def promote(self, revision: KnowledgeRevision, owner_reviewed: bool) -> None:
        """P0 keeps promotion explicit and caller-owned; no agent can write here."""
        if not owner_reviewed:
            raise PolicyViolation("knowledge_promotion_requires_owner_review")
        if revision.status != KnowledgeStatus.ACTIVE:
            raise PolicyViolation("only_active_revision_can_be_promoted")
        self._validate_content_hash(revision)
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
        self._enforce_latest_wins()

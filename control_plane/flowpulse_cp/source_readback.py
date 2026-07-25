"""Independent source-readback ports used only by verifier activities."""

import json
from hashlib import sha256
from typing import Protocol
from urllib.parse import urlparse

from .integrity import EvidenceReadbackPort
from .models import (
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    ProofScope,
    SourceKind,
)
from .policy import PolicyViolation


class S3GetPort(Protocol):
    def get_object(self, *, Bucket: str, Key: str):
        ...


class S3SourceReadback(EvidenceReadbackPort):
    """Re-read a fixed, case-derived source location with read-only credentials."""

    def __init__(self, client: S3GetPort, bucket: str, prefix: str) -> None:
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def expected_key(self, evidence: EvidenceEnvelope) -> str:
        return "{}/{}/cases/{}/revisions/{}/evidence/{}/{}.json".format(
            self.prefix, evidence.tenant_id, evidence.case_id, evidence.case_revision,
            evidence.evidence_id, evidence.source_version,
        )

    def readback(self, evidence: EvidenceEnvelope) -> EvidenceEnvelope:
        parsed = urlparse(evidence.source_uri)
        if (
            parsed.scheme != "s3"
            or parsed.netloc != self.bucket
            or parsed.path.lstrip("/") != self.expected_key(evidence)
        ):
            raise PolicyViolation("source_readback_adapter_binding_missing")
        response = self.client.get_object(Bucket=self.bucket, Key=self.expected_key(evidence))
        return EvidenceEnvelope.parse_obj(json.loads(response["Body"].read().decode("utf-8")))


class LocalDeterministicSourceReadback(EvidenceReadbackPort):
    """Compose/test-only source adapter; never accepts a caller readback payload."""

    def readback(self, evidence: EvidenceEnvelope) -> EvidenceEnvelope:
        expected_uri = "local://current/{}".format(evidence.case_id)
        if evidence.source_uri != expected_uri:
            raise PolicyViolation("source_readback_adapter_binding_missing")
        content = "local-current-observation:{}:{}".format(evidence.case_id, evidence.case_revision)
        return EvidenceEnvelope(
            evidence_id=evidence.evidence_id,
            case_id=evidence.case_id,
            case_revision=evidence.case_revision,
            tenant_id=evidence.tenant_id,
            acl_subjects=evidence.acl_subjects,
            source_kind=SourceKind.SOURCE_READBACK,
            source_uri=expected_uri,
            source_anchor="deterministic:1",
            observed_at=evidence.observed_at,
            effective_at=evidence.effective_at,
            source_version="local-v1",
            content_hash=sha256(content.encode("utf-8")).hexdigest(),
            authority=EvidenceAuthority.T0,
            freshness=FreshnessStatus.CURRENT,
            independence_key="local-source:{}".format(evidence.case_id),
            schema_binding="local.current.v1",
            proof_scope=ProofScope.CURRENT_OBSERVATION,
        )

"""Controlled production current-evidence acquisition port."""

import json
from typing import Protocol

from .models import EvidenceAcquisitionResult, IncidentCase
from .policy import PolicyViolation


class S3GetPort(Protocol):
    def get_object(self, *, Bucket: str, Key: str):
        ...


class CurrentEvidenceAcquisitionPort(Protocol):
    def acquire(self, case: IncidentCase, subject_id: str) -> EvidenceAcquisitionResult:
        """Acquire an admission-ready current-evidence bundle from a controlled source."""


class S3CurrentEvidenceAcquirer:
    """Read a case-bound manifest from the configured telemetry source bucket.

    This is intentionally separate from the local deterministic fixture and
    from the artifact writer: the manifest location is derived from the case,
    and every source URI is later bound by ``S3SourceReadback``.
    """

    def __init__(self, client: S3GetPort, bucket: str, prefix: str) -> None:
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def manifest_key(self, case: IncidentCase) -> str:
        return "{}/{}/cases/{}/revisions/{}/current-evidence.json".format(
            self.prefix, case.tenant_id, case.case_id, case.case_revision,
        )

    def acquire(self, case: IncidentCase, subject_id: str) -> EvidenceAcquisitionResult:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self.manifest_key(case))
        except Exception as error:
            raise PolicyViolation("controlled_current_evidence_unavailable") from error
        try:
            result = EvidenceAcquisitionResult.parse_obj(json.loads(response["Body"].read().decode("utf-8")))
        except Exception as error:
            raise PolicyViolation("controlled_current_evidence_invalid") from error
        for evidence in result.evidence:
            if (
                evidence.tenant_id != case.tenant_id
                or evidence.case_id != case.case_id
                or evidence.case_revision != case.case_revision
                or subject_id not in evidence.acl_subjects
            ):
                raise PolicyViolation("controlled_current_evidence_scope_or_acl_mismatch")
        return result

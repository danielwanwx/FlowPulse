"""S3/MinIO-compatible port; caller supplies an authenticated SDK client."""

from hashlib import sha256
from typing import Protocol

from .policy import PolicyViolation


class S3ClientPort(Protocol):
    def put_object(self, Bucket: str, Key: str, Body: bytes, Metadata: dict) -> object:
        ...

    def get_object(self, Bucket: str, Key: str) -> object:
        ...


class S3ObjectStore:
    """Tenant-prefixed raw artifacts with content-addressed versioned keys."""

    def __init__(self, client: S3ClientPort, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def put(self, tenant_id: str, content: bytes) -> str:
        digest = sha256(content).hexdigest()
        key = "{}/sha256/{}".format(tenant_id, digest)
        self.client.put_object(Bucket=self.bucket, Key=key, Body=content, Metadata={"sha256": digest})
        return key

    def get(self, tenant_id: str, key: str) -> object:
        if not key.startswith(tenant_id + "/"):
            raise PolicyViolation("cross_tenant_artifact_access")
        return self.client.get_object(Bucket=self.bucket, Key=key)

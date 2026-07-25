"""Explicit configuration; no production credential or endpoint defaults."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    temporal_address: str
    postgres_dsn: str
    object_store_endpoint: str
    object_store_bucket: str
    temporal_task_queue: str

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            temporal_address=os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233"),
            postgres_dsn=os.environ.get("FLOWPULSE_POSTGRES_DSN", "postgresql://flowpulse:flowpulse@postgres:5432/flowpulse"),
            object_store_endpoint=os.environ.get("FLOWPULSE_OBJECT_STORE_ENDPOINT", "http://minio:9000"),
            object_store_bucket=os.environ.get("FLOWPULSE_OBJECT_STORE_BUCKET", "flowpulse-evidence"),
            temporal_task_queue=os.environ.get("FLOWPULSE_TEMPORAL_TASK_QUEUE", "flowpulse-diagnosis-p0"),
        )

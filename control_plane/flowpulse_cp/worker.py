"""Compose worker entry point; no production credentials are embedded."""

import asyncio
import os

from .config import Settings
from .temporal_runtime import run_worker


if __name__ == "__main__":
    settings = Settings.from_environment()
    asyncio.run(run_worker(
        settings.temporal_address, settings.temporal_task_queue, settings.postgres_dsn,
        settings.object_store_endpoint, settings.object_store_bucket,
        settings.object_store_access_key, settings.object_store_secret_key,
        settings.source_read_endpoint, settings.source_read_bucket, settings.source_read_prefix,
        settings.source_read_access_key, settings.source_read_secret_key,
        settings.auth_assertion_signing_secret,
        local_deterministic_evidence=os.environ.get("FLOWPULSE_LOCAL_DETERMINISTIC_EVIDENCE") == "1",
    ))

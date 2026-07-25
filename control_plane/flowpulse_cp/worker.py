"""Compose worker entry point; no production credentials are embedded."""

import asyncio

from .config import Settings
from .temporal_runtime import run_worker


if __name__ == "__main__":
    settings = Settings.from_environment()
    asyncio.run(run_worker(settings.temporal_address, settings.temporal_task_queue, settings.postgres_dsn))

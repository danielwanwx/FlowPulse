"""Compose worker entry point; source and artifact credentials stay worker-only."""

import asyncio
import os

from .config import WorkerSettings
from .temporal_runtime import run_worker


if __name__ == "__main__":
    settings = WorkerSettings.from_environment()
    asyncio.run(run_worker(
        settings.temporal_address, settings.temporal_task_queue, settings.postgres_dsn,
        settings.object_store_endpoint, settings.object_store_bucket,
        settings.object_store_access_key, settings.object_store_secret_key,
        settings.source_read_endpoint, settings.source_read_bucket, settings.source_read_prefix,
        settings.source_read_tenant_id, settings.source_read_access_key, settings.source_read_secret_key,
        settings.authorization_service_url, settings.authorization_service_token,
        local_deterministic_evidence=os.environ.get("FLOWPULSE_LOCAL_DETERMINISTIC_EVIDENCE") == "1",
        provider_settings=settings.provider_settings,
        deterministic_test_providers_enabled=settings.deterministic_test_providers_enabled,
        prometheus_url=settings.prometheus_url,
        prometheus_expression=settings.prometheus_expression,
        connector_allowed_origins=settings.connector_allowed_origins,
        connector_allow_private_origins=settings.connector_allow_private_origins,
        prometheus_binding_templates=settings.prometheus_binding_templates,
        otel_spool_root=settings.otel_spool_root,
        otel_binding_templates=settings.otel_binding_templates,
        realtime_scheduler_interval_seconds=(
            settings.realtime_scheduler_interval_seconds
        ),
        realtime_tenant_id=settings.realtime_tenant_id,
        realtime_actor_subject_id=settings.realtime_actor_subject_id,
        worker_heartbeat_path=settings.worker_heartbeat_path,
        guided_runtime_base_url=settings.guided_runtime_base_url,
        guided_runtime_hmac_secret=settings.guided_runtime_hmac_secret,
        guided_rollback_base_url=settings.guided_rollback_base_url,
        guided_rollback_hmac_secret=settings.guided_rollback_hmac_secret,
    ))

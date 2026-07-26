"""Fail-closed process-specific configuration."""

from dataclasses import dataclass
import json
import os
from typing import Dict


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError("required_environment_missing:" + name)
    return value


@dataclass(frozen=True)
class ApiSettings:
    temporal_address: str
    postgres_dsn: str
    authorization_service_url: str
    authorization_service_token: str
    temporal_task_queue: str

    @classmethod
    def from_environment(cls) -> "ApiSettings":
        return cls(
            temporal_address=required("FLOWPULSE_TEMPORAL_ADDRESS"),
            postgres_dsn=required("FLOWPULSE_POSTGRES_DSN"),
            authorization_service_url=required("FLOWPULSE_AUTHORIZATION_SERVICE_URL"),
            authorization_service_token=required("FLOWPULSE_AUTHORIZATION_SERVICE_TOKEN"),
            temporal_task_queue=required("FLOWPULSE_TEMPORAL_TASK_QUEUE"),
        )


@dataclass(frozen=True)
class WorkerSettings:
    temporal_address: str
    postgres_dsn: str
    object_store_endpoint: str
    object_store_bucket: str
    object_store_access_key: str
    object_store_secret_key: str
    source_read_endpoint: str
    source_read_bucket: str
    source_read_prefix: str
    source_read_tenant_id: str
    source_read_access_key: str
    source_read_secret_key: str
    authorization_service_url: str
    authorization_service_token: str
    temporal_task_queue: str

    @classmethod
    def from_environment(cls) -> "WorkerSettings":
        return cls(
            temporal_address=required("FLOWPULSE_TEMPORAL_ADDRESS"),
            postgres_dsn=required("FLOWPULSE_POSTGRES_DSN"),
            object_store_endpoint=required("FLOWPULSE_OBJECT_STORE_ENDPOINT"),
            object_store_bucket=required("FLOWPULSE_OBJECT_STORE_BUCKET"),
            object_store_access_key=required("FLOWPULSE_OBJECT_STORE_ACCESS_KEY"),
            object_store_secret_key=required("FLOWPULSE_OBJECT_STORE_SECRET_KEY"),
            source_read_endpoint=required("FLOWPULSE_SOURCE_READ_ENDPOINT"),
            source_read_bucket=required("FLOWPULSE_SOURCE_READ_BUCKET"),
            source_read_prefix=required("FLOWPULSE_SOURCE_READ_PREFIX"),
            source_read_tenant_id=required("FLOWPULSE_SOURCE_READ_TENANT_ID"),
            source_read_access_key=required("FLOWPULSE_SOURCE_READ_ACCESS_KEY"),
            source_read_secret_key=required("FLOWPULSE_SOURCE_READ_SECRET_KEY"),
            authorization_service_url=required("FLOWPULSE_AUTHORIZATION_SERVICE_URL"),
            authorization_service_token=required("FLOWPULSE_AUTHORIZATION_SERVICE_TOKEN"),
            temporal_task_queue=required("FLOWPULSE_TEMPORAL_TASK_QUEUE"),
        )


@dataclass(frozen=True)
class AuthzSettings:
    postgres_dsn: str
    issuer: str
    audience: str
    active_key_id: str
    keyring: Dict[str, str]
    api_service_token: str
    worker_service_token: str

    @classmethod
    def from_environment(cls) -> "AuthzSettings":
        try:
            keyring = json.loads(required("FLOWPULSE_AUTH_ASSERTION_KEYRING_JSON"))
        except json.JSONDecodeError as error:
            raise RuntimeError("auth_assertion_keyring_json_invalid") from error
        if not isinstance(keyring, dict) or not all(isinstance(key, str) and isinstance(value, str) and value for key, value in keyring.items()):
            raise RuntimeError("auth_assertion_keyring_invalid")
        return cls(
            postgres_dsn=required("FLOWPULSE_POSTGRES_DSN"),
            issuer=required("FLOWPULSE_AUTH_ASSERTION_ISSUER"),
            audience=required("FLOWPULSE_AUTH_ASSERTION_AUDIENCE"),
            active_key_id=required("FLOWPULSE_AUTH_ASSERTION_ACTIVE_KEY_ID"),
            keyring=keyring,
            api_service_token=required("FLOWPULSE_AUTHZ_API_SERVICE_TOKEN"),
            worker_service_token=required("FLOWPULSE_AUTHZ_WORKER_SERVICE_TOKEN"),
        )

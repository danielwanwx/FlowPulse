"""Fail-closed process-specific configuration."""

from dataclasses import dataclass
import json
import os
from typing import Dict, Optional

from pydantic import ValidationError

from .models import AuthContext
from .provider_gateway import ProviderSettings


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError("required_environment_missing:" + name)
    return value


@dataclass(frozen=True)
class ApiSettings:
    runtime_mode: str
    temporal_address: str
    postgres_dsn: str
    authorization_service_url: str
    authorization_service_token: str
    temporal_task_queue: str
    trusted_fixture_token: Optional[str]
    trusted_fixture_context: Optional[AuthContext]

    @property
    def trusted_fixture_enabled(self) -> bool:
        return self.runtime_mode in {"local", "test"} and self.trusted_fixture_token is not None

    @classmethod
    def from_environment(cls) -> "ApiSettings":
        # Default to production so a fixture can never be activated merely by
        # copying its two values into a non-test process environment.
        runtime_mode = os.environ.get("FLOWPULSE_RUNTIME_MODE", "production")
        if runtime_mode not in {"local", "test", "production"}:
            raise RuntimeError("flowpulse_runtime_mode_invalid")
        fixture_token = os.environ.get("FLOWPULSE_TRUSTED_AUTH_FIXTURE_TOKEN")
        fixture_context_json = os.environ.get("FLOWPULSE_TRUSTED_AUTH_FIXTURE_CONTEXT_JSON")
        if bool(fixture_token) != bool(fixture_context_json):
            raise RuntimeError("trusted_auth_fixture_token_and_context_must_be_configured_together")
        if fixture_token and runtime_mode not in {"local", "test"}:
            raise RuntimeError("trusted_auth_fixture_forbidden_outside_local_or_test")
        fixture_context = None
        if fixture_context_json:
            try:
                fixture_context = AuthContext.parse_obj(json.loads(fixture_context_json))
            except (json.JSONDecodeError, ValidationError) as error:
                raise RuntimeError("trusted_auth_fixture_context_invalid") from error
        return cls(
            runtime_mode=runtime_mode,
            temporal_address=required("FLOWPULSE_TEMPORAL_ADDRESS"),
            postgres_dsn=required("FLOWPULSE_POSTGRES_DSN"),
            authorization_service_url=required("FLOWPULSE_AUTHORIZATION_SERVICE_URL"),
            authorization_service_token=required("FLOWPULSE_AUTHORIZATION_SERVICE_TOKEN"),
            temporal_task_queue=required("FLOWPULSE_TEMPORAL_TASK_QUEUE"),
            trusted_fixture_token=fixture_token,
            trusted_fixture_context=fixture_context,
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
    provider_settings: ProviderSettings

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
            provider_settings=ProviderSettings.from_environment(),
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

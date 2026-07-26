"""Compose API and isolated authorization-service entry points."""

import os
import uvicorn

from .app import create_app
from .authorization import HmacAuthorizationAuthority, HttpAuthorizationClient, create_authz_app
from .config import ApiSettings, AuthzSettings
from .temporal_runtime import TemporalStarter


def main() -> None:
    component = os.environ.get("FLOWPULSE_COMPONENT", "api")
    if component == "authz":
        settings = AuthzSettings.from_environment()
        application = create_authz_app(HmacAuthorizationAuthority(
            settings.keyring, settings.issuer, settings.audience, settings.active_key_id,
        ), settings.postgres_dsn)
        uvicorn.run(application, host="0.0.0.0", port=int(os.environ.get("PORT", "8091")))
        return
    if component != "api":
        raise RuntimeError("unknown_flowpulse_component")
    settings = ApiSettings.from_environment()
    application = create_app(
        postgres_dsn=settings.postgres_dsn,
        temporal_starter=TemporalStarter(
            settings.temporal_address, settings.temporal_task_queue,
            local_deterministic_evidence=os.environ.get("FLOWPULSE_LOCAL_DETERMINISTIC_EVIDENCE") == "1",
        ),
        authorization=HttpAuthorizationClient(settings.authorization_service_url),
        allow_local_test_auth=os.environ.get("FLOWPULSE_LOCAL_TEST_AUTH") == "1",
    )
    uvicorn.run(application, host="0.0.0.0", port=8090)


if __name__ == "__main__":
    main()

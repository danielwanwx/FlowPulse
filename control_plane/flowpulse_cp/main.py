import uvicorn
import os

from .app import create_app
from .config import Settings
from .temporal_runtime import TemporalStarter


if __name__ == "__main__":
    settings = Settings.from_environment()
    application = create_app(
        postgres_dsn=settings.postgres_dsn,
        temporal_starter=TemporalStarter(
            settings.temporal_address, settings.temporal_task_queue,
            local_deterministic_evidence=os.environ.get("FLOWPULSE_LOCAL_DETERMINISTIC_EVIDENCE") == "1",
        ),
        allow_local_test_auth=os.environ.get("FLOWPULSE_LOCAL_TEST_AUTH") == "1",
    )
    uvicorn.run(application, host="0.0.0.0", port=8090)

"""FlowPulse Diagnosis Control Plane P0.

Temporal owns workflow progress in deployment.  The deterministic in-process
adapter is intentionally test-only and exists to replay the same activity
contracts without a Temporal server.
"""

from .app import create_app

__all__ = ["create_app"]

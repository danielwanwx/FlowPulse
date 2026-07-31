"""The only production registration set for Workspace Temporal workflows."""

from .legacy_workspace_workflow import LegacyIncidentWorkspaceTemporalWorkflow
from .workspace_versions import (
    WORKSPACE_V1_WORKFLOW_TYPE,
    WORKSPACE_V2_WORKFLOW_TYPE,
    WORKSPACE_V3_WORKFLOW_TYPE,
)
from .workspace_v3_workflow import IncidentWorkspaceTemporalWorkflowV3
from .workspace_workflow import IncidentWorkspaceTemporalWorkflow


def workspace_workflow_definitions():
    """Drain/replay v1 and serve new authenticated v2 executions."""
    return [
        LegacyIncidentWorkspaceTemporalWorkflow,
        IncidentWorkspaceTemporalWorkflow,
        IncidentWorkspaceTemporalWorkflowV3,
    ]


__all__ = [
    "WORKSPACE_V1_WORKFLOW_TYPE",
    "WORKSPACE_V2_WORKFLOW_TYPE",
    "WORKSPACE_V3_WORKFLOW_TYPE",
    "workspace_workflow_definitions",
]

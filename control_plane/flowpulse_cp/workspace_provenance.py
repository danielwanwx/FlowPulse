"""Verifiable producer provenance for archived Incident Workspace histories."""

import hashlib
import json
import subprocess
import base64
from pathlib import Path
from typing import Any, Dict, Mapping

from .workspace_versions import WORKSPACE_V1_WORKFLOW_TYPE, WORKSPACE_V2_WORKFLOW_TYPE


WORKFLOW_MODULE_REPO_PATH = "control_plane/flowpulse_cp/workspace_workflow.py"
IMAGE_GIT_LABEL = "io.flowpulse.producer_git_sha"
IMAGE_WORKFLOW_BLOB_LABEL = "io.flowpulse.workspace_workflow_blob_oid"


def _git(repo_root: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo_root), *args], text=True,
    ).strip()


def git_blob_oid(content: bytes) -> str:
    """The Git SHA-1 blob OID for bytes, independent of a caller's label."""
    return hashlib.sha1("blob {}\0".format(len(content)).encode("ascii") + content).hexdigest()


def history_identity(raw: bytes) -> Dict[str, str]:
    """Derive public and Temporal identities from immutable Temporal history."""
    document = json.loads(raw)
    started = document["events"][0]["workflowExecutionStartedEventAttributes"]
    if started["workflowType"]["name"] != WORKSPACE_V1_WORKFLOW_TYPE:
        raise RuntimeError("unexpected_workspace_history_type")
    payloads = started["input"]["payloads"]
    if len(payloads) != 1:
        raise RuntimeError("workspace_history_start_input_invalid")
    request = json.loads(base64.b64decode(payloads[0]["data"]).decode("utf-8"))
    public = {name: request[name] for name in ("tenant_id", "incident_id", "run_id", "topology_revision")}
    workflow_id = started["workflowId"]
    if request.get("workflow_id") != workflow_id:
        raise RuntimeError("workspace_history_workflow_id_input_mismatch")
    run_id = started["originalExecutionRunId"]
    if run_id != started["firstExecutionRunId"]:
        raise RuntimeError("workspace_history_run_identity_mismatch")
    return {
        **public,
        "workflow_id": workflow_id,
        "workflow_run_id": run_id,
        "workflow_type": started["workflowType"]["name"],
    }


def _image_identity(image_inspect: Mapping[str, Any]) -> Dict[str, str]:
    image_id = image_inspect.get("Id")
    labels = image_inspect.get("Config", {}).get("Labels", {})
    if not isinstance(image_id, str) or not image_id.startswith("sha256:"):
        raise RuntimeError("producer_image_id_missing_or_invalid")
    if not isinstance(labels, Mapping):
        raise RuntimeError("producer_image_labels_missing")
    git_label = labels.get(IMAGE_GIT_LABEL)
    blob_label = labels.get(IMAGE_WORKFLOW_BLOB_LABEL)
    if not isinstance(git_label, str) or not isinstance(blob_label, str):
        raise RuntimeError("producer_image_identity_labels_missing")
    return {
        "image_id": image_id,
        "image_revision_label": git_label,
        "image_workflow_blob_label": blob_label,
    }


def build_producer_attestation(repo_root: Path, image_inspect: Mapping[str, Any]) -> Dict[str, str]:
    """Derive attestation data from Git objects and a Docker image inspection.

    No producer SHA, workflow hash, or image identity is accepted as a caller
    string.  The producer image labels must agree with the checked-out Git
    commit and the immutable Git blob containing the workflow implementation.
    """
    git_sha = _git(repo_root, "rev-parse", "HEAD")
    module_path = repo_root / WORKFLOW_MODULE_REPO_PATH
    source = module_path.read_bytes()
    expected_blob = _git(repo_root, "rev-parse", "{}:{}".format(git_sha, WORKFLOW_MODULE_REPO_PATH))
    if git_blob_oid(source) != expected_blob:
        raise RuntimeError("producer_workflow_module_not_at_head")
    identity = _image_identity(image_inspect)
    if identity["image_revision_label"] != git_sha:
        raise RuntimeError("producer_image_revision_label_mismatch")
    if identity["image_workflow_blob_label"] != expected_blob:
        raise RuntimeError("producer_image_workflow_blob_label_mismatch")
    return {
        "schema_version": 1,
        "git_sha": git_sha,
        "image_id": identity["image_id"],
        "image_revision_label": identity["image_revision_label"],
        "workflow_module_repo_path": WORKFLOW_MODULE_REPO_PATH,
        "workflow_module_git_blob_oid": expected_blob,
        "workflow_module_sha256": hashlib.sha256(source).hexdigest(),
        "workflow_type": WORKSPACE_V2_WORKFLOW_TYPE,
    }


def write_producer_attestation(repo_root: Path, image_inspect_path: Path, output: Path) -> Dict[str, str]:
    payload = json.loads(image_inspect_path.read_text(encoding="utf-8"))
    return write_producer_attestation_from_payload(repo_root, payload, output)


def write_producer_attestation_from_payload(repo_root: Path, payload: Any, output: Path) -> Dict[str, str]:
    if isinstance(payload, list):
        if len(payload) != 1:
            raise RuntimeError("producer_image_inspection_ambiguous")
        payload = payload[0]
    if not isinstance(payload, Mapping):
        raise RuntimeError("producer_image_inspection_invalid")
    attestation = build_producer_attestation(repo_root, payload)
    output.write_text(json.dumps(attestation, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return attestation


def write_producer_attestation_from_image(repo_root: Path, image: str, output: Path) -> Dict[str, str]:
    """Ask Docker for the immutable image identity; do not accept it from a caller."""
    payload = inspect_producer_image(image)
    return write_producer_attestation_from_payload(repo_root, payload, output)


def inspect_producer_image(image: str) -> Any:
    """Return Docker's own immutable image inspection result for ``image``."""
    try:
        payload = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        raise RuntimeError("producer_image_inspection_unavailable") from error
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], Mapping):
        raise RuntimeError("producer_image_inspection_ambiguous")
    return payload[0]


def verify_producer_attestation(repo_root: Path, attestation: Mapping[str, Any]) -> Dict[str, str]:
    """Validate recorded identity against the actual Git object, not an assertion."""
    required = {
        "schema_version", "git_sha", "image_id", "image_revision_label", "workflow_module_repo_path",
        "workflow_module_git_blob_oid", "workflow_module_sha256", "workflow_type",
    }
    if set(attestation) != required or attestation.get("schema_version") != 1:
        raise RuntimeError("producer_attestation_schema_invalid")
    values = {key: attestation[key] for key in required if key != "schema_version"}
    if not all(isinstance(value, str) and value for value in values.values()):
        raise RuntimeError("producer_attestation_values_invalid")
    if values["image_revision_label"] != values["git_sha"] or not values["image_id"].startswith("sha256:"):
        raise RuntimeError("producer_attestation_image_identity_invalid")
    if values["workflow_module_repo_path"] != WORKFLOW_MODULE_REPO_PATH:
        raise RuntimeError("producer_attestation_workflow_path_invalid")
    if values["workflow_type"] not in {WORKSPACE_V1_WORKFLOW_TYPE, WORKSPACE_V2_WORKFLOW_TYPE}:
        raise RuntimeError("producer_attestation_workflow_type_invalid")
    try:
        actual_blob = _git(
            repo_root, "rev-parse", "{}:{}".format(values["git_sha"], values["workflow_module_repo_path"]),
        )
        git_source = subprocess.check_output(
            ["git", "-C", str(repo_root), "cat-file", "-p", actual_blob],
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError("producer_attestation_git_object_unavailable") from error
    if actual_blob != values["workflow_module_git_blob_oid"]:
        raise RuntimeError("producer_attestation_git_blob_mismatch")
    if git_blob_oid(git_source) != actual_blob or hashlib.sha256(git_source).hexdigest() != values["workflow_module_sha256"]:
        raise RuntimeError("producer_attestation_workflow_bytes_mismatch")
    return {key: str(value) for key, value in attestation.items() if key != "schema_version"}


def verify_producer_image_attestation(
    repo_root: Path, image: str, attestation: Mapping[str, Any],
) -> Dict[str, str]:
    """Bind an archive attestation to the image Docker resolves *now*.

    The archive command calls this after reading its checked-in/recorded
    attestation.  It consequently rejects a stale or caller-substituted image
    before it fetches a Temporal history, while ``verify_producer_attestation``
    separately maps the claimed commit to the immutable workflow Git blob.
    """
    verified = verify_producer_attestation(repo_root, attestation)
    inspected = _image_identity(inspect_producer_image(image))
    if (
        inspected["image_id"] != verified["image_id"]
        or inspected["image_revision_label"] != verified["image_revision_label"]
        or inspected["image_workflow_blob_label"] != verified["workflow_module_git_blob_oid"]
    ):
        raise RuntimeError("producer_image_attestation_mismatch")
    return verified

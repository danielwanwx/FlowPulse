# Agent-led Incident Workspace — control-plane integration plan

## Gap matrix

| Approved Incident Workspace contract | Existing backend at `45d331e1523d9643a0321c8f65ce6a26b949660c` | Missing work | Exact acceptance tests to add/run |
| --- | --- | --- | --- |
| FlowPulse is a model-agnostic, company-multiplayer agent operating system; incident response is its first vertical. Temporal owns transitions; the evidence ledger and Postgres projections remain distinct authorities. | `control_plane/README.md` documents the P0 kernel and `docs/architecture.md` still describes a SQLite/demo state machine. `DiagnosisTemporalWorkflow` and Postgres already establish the P0 authority boundary. | Align the root README, control-plane README, and core architecture with the approved product boundary; document the legacy Node/demo plane as a consumer, not a second control plane. | `control_plane/tests/test_incident_workspace_docs_contract.py::test_north_star_and_authority_statements`; `git diff --check`. |
| A versioned `IncidentProjection` is the only browser read model: public canonical `incident_id`/`run_id`/`topology_revision`, connected-or-classified graph membership, impacted path/status, and action/gate/evidence revisions are explicit. | `IncidentCase` has internal case/Temporal correlation; the P0 repository stores case/evidence/claims/events. The Node application has a separate demo projection. No Python public run-to-Temporal mapping or incident graph projection exists. | Add strict projection/graph contracts, a server-owned canonical run binding distinct from `case_id`, `workflow_id`, and real Temporal `workflow_run_id`, a tenant-scoped append-only projection store, projection/topology revision rules, and a classified-node allowlist. | `test_incident_workspace_contracts.py::test_public_run_and_topology_identity_never_derive_from_temporal_ids`; `test_live_incident_workspace_postgres.py::test_projection_revision_and_rls_are_monotonic`. |
| Clicking a node starts or reuses one durable `NodeExplanation`; its exact selection key is `node_explanation:{tenant_id}:{run_id}:{projection_revision}:{component_id}:{conversation_schema_version}`. Focus/toast creates no work. Before Gate 1, it may use only projection, recorded evidence, and labeled priors. | No node-explanation domain record, selection key, Temporal update, or endpoint exists. Existing P0 workflow handles only diagnosis and owner commands. | Add a strict start-or-reuse command and unique durable key; route the command through a new Temporal workflow/update and return the recorded/degraded explanation projection. Treat focus as a frontend-only operation with no route/event. | `test_node_explanations.py::test_same_selection_key_is_exactly_once`; `test_node_explanations.py::test_pre_gate_explanation_has_no_read_tool_calls`; `test_live_incident_workspace_temporal.py::test_concurrent_node_clicks_reuse_one_turn`. |
| Conversation Manager and bounded specialists run in Temporal activities with a layered, pinned prompt/context/version bundle. Provider gateway supports OpenAI-compatible proprietary or local open-source endpoints. Deterministic output is only explicit local/test/demo and is never labeled live AI. | `activities.py` exposes a minimal `OpenAIResponsesPort` and deterministic primary investigator. The worker executes P0 activities, but there is no conversation-manager contract, provider-mode boundary, prompt bundle, or provider truth projection. | Introduce typed workspace activity packets, role/prompt/context/version contracts, a provider gateway, bounded specialist tool calls, provider capability/degraded records, and explicit test/demo-only deterministic wiring. | `test_conversation_manager.py::test_prompt_bundle_is_pinned_and_schema_bound`; `test_provider_modes.py::test_standard_mode_provider_absence_is_degraded_not_fake`; `test_provider_modes.py::test_deterministic_provider_requires_explicit_test_or_demo_mode`; opt-in `test_live_provider_smoke.py`. |
| Gate 1 is a Temporal-scoped read-capability approval with a 30-minute, revision-bound scope; expired/revoked/stale grants cannot enable fresh reads. Gate 2 and the exact Owner Gate retain the present TTL/contract/witness/canary invariants. | Gate 2/Owner Gate is Temporal-authoritative and has assertion, TTL, current-witness, target, and dry-run protections. There is no Gate 1 record/update or read-capability enforcement. | Add Gate 1 grant/revoke/expire updates, scope and revision validators, capability-call enforcement in both autonomous and conversational paths, and make the new workspace workflow delegate Gate 2 to the existing exact Owner Gate activity rather than duplicating it. | `test_gate1_capabilities.py::test_no_fresh_read_before_grant`; `test_gate1_capabilities.py::test_expired_revoked_or_revision_mismatched_grant_fails_closed`; existing `test_no_ship_regressions.py` and `test_live_temporal_negative_paths.py` remain green. |
| One Capability Registry and typed adapters are shared by autonomous diagnosis and user Q&A: metrics, logs, traces, topology, deploy/config, Kafka, GitHub ticketing, and safe actions. An unavailable real adapter is absent, never decorative. | P0 has current-evidence/readback/object-store ports and a generic `tool_calls` table, but no registry, adapter discovery, tool schema, or shared Q&A/autonomous surface. | Create a versioned registry and typed adapter interfaces/inputs/outputs. Only materialize a capability after its configured adapter passes a binding/health check; record unavailable dependencies without fabricating results. | `test_capability_registry.py::test_unbound_adapter_is_omitted`; `test_capability_registry.py::test_same_capability_policy_for_diagnosis_and_conversation`; `test_live_incident_workspace_minio.py::test_bound_read_adapter_records_hash_and_evidence_refs`. |
| Backend generates a fixed-taxonomy `NextBestAction[]`: fixed title/CTA mapping, dynamic English summary/order/recommendation, evidence references, TTL/preconditions/permissions/version/invalidation, and one generic server-issued invocation path. | P0 exposes manually submitted remediation proposals and dry-run receipts only. It has no action-card projection, taxonomy, or server-issued action invocation. | Define strict card enum/mapping and generate cards in a Temporal projection activity. Persist card/action version, canonical run/topology/evidence bindings, and invalidation reason. Add a generic action endpoint that reloads/revalidates a card and selects the correct Temporal update; cards may request a gate or review/track a dry run but may not create an executable production action. | `test_next_best_actions.py::test_fixed_title_and_cta_mapping`; `test_next_best_actions.py::test_card_invalidates_on_evidence_gate_or_projection_revision`; `test_incident_workspace_api.py::test_action_invocation_reloads_card_and_rejects_browser_manufactured_scope`; `test_next_best_actions.py::test_no_card_bypasses_owner_gate`. |
| Current proof stays distinct from Knowledge priors; all accesses stay tenant/ACL scoped; critic and verifier remain independent; the safe-action path is dry-run only. | These P0 invariants are implemented in strict contracts, evidence admission, RLS, critic/readback, and Owner Gate tests. | Carry the same invariants into workspace projection, conversation context, capability outputs, action cards, and SSE. Prevent a provider/tool result from promoting a KB prior or changing a verified claim. | Extend `test_control_plane.py`, `test_no_ship_regressions.py`, and `test_production_control_paths.py`; add `test_incident_workspace_safety.py::test_prior_only_context_cannot_create_current_claim_or_action_card`. |
| Versioned FastAPI projection, context, node-explanation, conversation, generic action invocation, approval, and ordered SSE APIs are needed. Canonical public run/topology identity, sequences, and revisions are preserved; unavailable dependencies yield typed degraded/fail-closed results. | FastAPI offers `/healthz`, case intake/read, proposal, and dry-run only. It has no workspace projection, generic card invocation, or SSE endpoint. | Add versioned, authenticated routes backed solely by Temporal-authoritative projections, strict request/response schemas, a run/topology-aware event envelope, `Last-Event-ID`/`after` ordering, and typed degraded states. Keep lower-level proposal/gate routes as internal/P0 compatibility aliases, not browser-card contracts. | `test_incident_workspace_api.py::test_route_schemas_and_tenant_scoping`; `test_incident_workspace_api.py::test_action_invocation_requires_full_canonical_identity`; `test_incident_workspace_sse.py::test_resume_is_strictly_after_checkpoint`; `test_live_incident_workspace_http.py::test_intake_to_projection_to_sse_to_owner_gate`. |
| Cross-worktree E2E must use real Compose Temporal/Postgres/MinIO and expose public run/topology IDs plus evidence refs. Credential-free test/demo providers are visibly labeled; browser code must never receive the fixture bearer. | Compose already runs real Temporal/Postgres/MinIO, worker, API, and local fixture auth. P0 live tests prove its ownership path, but no Incident Workspace contract, same-origin transport façade, or browser-secret proof exists. | Extend Compose/migrations/worker for the workspace workflow and create a reproducible backend contract fixture. Publish only the API necessary for the UI; retain internal-only Temporal/authz and worker-only storage credentials. Require a same-origin frontend Node transport façade to forward the local bearer process-side without authority/success synthesis or browser exposure. | `test_live_incident_workspace_http.py`; `test_live_incident_workspace_temporal.py`; `test_live_incident_workspace_postgres.py`; `test_live_incident_workspace_minio.py`; `test_live_frontend_contract_api.py::test_same_origin_transport_hides_fixture_bearer`; frontend-owned browser transport/no-secret E2E; opt-in `test_live_provider_smoke.py`. |
| Versioning, replay, observability, and evaluation remain auditable: workflow/policy/prompt/tool/card/model versions, correlated records, no-KB vs KB measurements, and no invented improvement claims. | P0 has correlation fields, append-only events, evaluation hooks, and frozen v1 replay fixtures. It does not record workspace prompt/card/capability versions or event-stream metrics. | Add workspace `VersionBundle`, event/call/provider metrics records, replay fixtures for the new workflow type, and paired no-KB/KB hooks that report measurements only. | `test_workspace_replay.py::test_workspace_history_replays`; `test_workspace_evaluation.py::test_no_kb_and_kb_metrics_are_labeled_not_claimed`; existing parent-v1 replay test remains green. |

## Loop contract

**Approved inputs and compatibility boundary.** This plan implements the approved frontend specification at frontend commit `4adb8f5c0c49382e894732318530c83d9a0b5611`, read from `/Users/danielwan/Documents/Codex/2026-07-24/flowpulse-frontend-architecture-polish-v2/docs/superpowers/specs/2026-07-25-agent-led-incident-workspace-design.md`. It builds on backend commit `45d331e1523d9643a0321c8f65ce6a26b949660c`. The frontend worktree remains read-only and owned by its writer. The existing P0 routes and frozen Temporal v1/v2 compatibility remain supported while the workspace API is introduced as an additive, versioned surface.

**Cross-branch contract-freeze record.** The immutable planning input is `backend_baseline_sha=45d331e1523d9643a0321c8f65ce6a26b949660c` and its backend control-plane Git tree OID is `control_plane_git_tree_oid=cf8e013fea8e5ffc9d61758245536e4fb978cc8b`. The frontend input is `frontend_spec_sha=4adb8f5c0c49382e894732318530c83d9a0b5611`. The current workspace contract producer implementation is `1d8a51011471e6f372281159501ecfa88b39b4ed`. Its generated, safe artifacts are `control_plane/openapi/flowpulse-incident-workspace-v1.openapi.json` (`sha256=0722f00f349d830e47c648e1f4fe82e831e6672b33996e056a555e8ec6b35759`) and `control_plane/openapi/flowpulse-incident-workspace-v1.examples.json` (`sha256=27d4ac4f7f2ff4b610c58d6ea087262d1d3be0afb3d055efcaa4e5c463e91f66`), recorded by `control_plane/openapi/flowpulse-incident-workspace-v1.freeze.json` (`sha256=a8017e450b4c59347dfdc3d073ac7c174260eba128024d23b13dabd68adeda32`). Before frontend product integration consumes these fields, the frontend owner must copy this exact producer/artifact/identity/auth mapping into the frontend integration plan. Until both records exist and match, implementation may proceed only through documentation, contracts, models, and tests—not product UI integration.

**Goal.** Make the Incident/Live UI consume auditable FastAPI + Temporal + Postgres/ledger projections and backend-generated agent output. The browser supplies only authenticated intent, canonical selection, and an event checkpoint; it cannot manufacture graph membership, evidence, provider truth, gate grants, authority, actions, or recommendations.

**Authority rule.** Temporal remains the sole owner of durable workflow transitions and update sequencing. Postgres is an append-only ledger/query projection written by activities; MinIO stores content-addressed raw artifacts behind typed ports. FastAPI submits authenticated commands and returns projections/events. A provider can propose only strict, bounded data; it is never a state authority. The legacy Node/demo projections can remain a presentation fixture during migration but cannot be used as a backend success substitute for this API.

**Feedback rules.**

- A missing, unhealthy, or unbound real adapter removes that capability from the registry and records a dependency/degraded reason. It never returns decorative success.
- In standard mode an unavailable provider returns a typed `DEGRADED_PROVIDER_UNAVAILABLE`/`NEEDS_HUMAN` result. A deterministic provider is constructible only with explicit `local`, `test`, or `demo` runtime/provider mode and projects a non-live truth label.
- A contract conflict between the approved frontend spec and the P0 safety/authority model stops implementation for review before a route, migration, or workflow semantic is changed.
- Each failing test is repaired at its scoped cause, then its focused test and the affected full deterministic/live matrix are rerun. No failing check is explained away by a mock, client retry, or fallback authority.

**Records.** Every workspace command carries the authenticated tenant, public canonical `incident_id`/`run_id`/`topology_revision`, internal case correlation, workflow version, projection revision, and correlation ID. Activities append projection events/tool-call records and bind evidence IDs/content hashes to the same public run/topology identity; provider calls record only safe metadata, prompt/context hashes, output schema version, latency/token counters, and truth/degraded labels. Raw telemetry, prompts, model payloads, credentials, and chain-of-thought are excluded from browser and SSE projections.

**Stop conditions.** Stop and report before implementation if a production credential, external deployment, destructive migration, cross-tenant authority expansion, or a second workflow/state owner would be needed. A workspace workflow stops at a typed `NEEDS_HUMAN`, `ABSTAINED`, `BLOCKED`, `AWAITING_GATE_1`, `AWAITING_OWNER`, or dry-run-only approved state; it never executes a production remediation.

**Human gates.** Gate 1 grants only the bounded, time/revision-scoped read capability specified below. Gate 2/Owner Gate retains the existing authenticated-owner, exact proposal, witness, TTL, canary, idempotency, and dry-run controls. A human owner must approve any protected read scope and every action proposal. Only owner-reviewed verified artifacts may be promoted to Knowledge; that writeback is not added to the UI flow in this increment.

## Target contracts and version boundaries

### 1. New workspace workflow and version bundle

Do not mutate `flowpulse.diagnosis.v1` or its frozen replay behavior. Keep `flowpulse.diagnosis.v2` available for P0 callers. New Incident Workspace intake starts the secured `flowpulse.incident-workspace.v2` workflow type, registered alongside an isolated `flowpulse.incident-workspace.v1` replay/drain definition in `control_plane/flowpulse_cp/temporal_runtime.py`. The v1 registration exists only to replay or drain already-open pre-correction histories; Temporal patch markers reject new v1 starts and node-explanation updates. The secured v2 implementation never claims the v1 type. Later semantic evolution of either type must use Temporal patch/version markers and archived-history replay before release.

The new request/activity contracts live beside the existing Pydantic contracts, likely in `control_plane/flowpulse_cp/workspace_models.py` with narrow imports from `models.py`. All models inherit the existing strict `extra="forbid"` policy and use strict primitives. The pinned `VersionBundle` is immutable per projection revision and includes:

```text
workflow_version, policy_version, core_policy_version, role_prompt_version,
context_pack_version, capability_registry_version, tool_schema_version,
evidence_schema_version, card_schema_version, model_policy_version
```

Each prompt/context bundle also records a stable hash. A provider cannot choose, overwrite, or omit any version field.

### 2. Canonical projection and graph schema

`IncidentProjection` is an immutable, versioned read model. Its public canonical identity is exactly `(tenant_id, incident_id, run_id, topology_revision)`. `run_id` is an opaque backend-issued durable run identity created at intake and never parsed from or derived from a Temporal string. `topology_revision` is the backend-generated immutable revision of the canonical graph for that public run; it is not interchangeable with a case revision or a Temporal run. The internal identifiers have separate roles: `case_id` is the control-plane storage/API locator, `workflow_id` is the Temporal workflow identity, and `workflow_run_id` is the real Temporal execution correlation. They may be returned in an auditable `temporal` correlation object, but neither API nor frontend code may turn either into `run_id`.

At intake, the authoritative projection activity creates and persists one `incident_run_binding` `(tenant_id, incident_id, run_id, case_id, workflow_id, workflow_run_id)` with unique tenant/public-run and tenant/case/run constraints. The graph projection writer creates the corresponding `topology_revision`; all explanations, grants, actions, events, tool calls, and evidence bindings re-load and verify that mapping. A changed Temporal execution/run ID cannot silently mint or replace a public `run_id`.

Its canonical fields are:

```text
schema_version, tenant_id, incident_id, run_id, topology_revision, case_id,
workflow_id, workflow_run_id, projection_revision, sequence, lifecycle_state, status, generated_at,
version_bundle, graph, impacted_path, evidence_revision, gate_revision,
action_revision, gates, evidence_refs, next_best_actions, degraded
```

`graph.nodes[]` carries an exact `component_id`, canonical identity, display metadata, runtime status, impact status, and membership. Membership is one of `CONNECTED` or `CLASSIFIED`; a classified node must carry exactly one approved reason from `External dependency`, `Data store`, `Control plane`, `Observed boundary`, or `Relationship unavailable`. `graph.edges[]`, `impacted_path`, and status maps may refer only to those canonical IDs and the enclosing `run_id`/`topology_revision`. A node may not be silently omitted or inferred connected. `incident_id` preserves the intake external incident identity; `run_id` and `topology_revision` remain the public UI binding; `case_id` and Temporal IDs remain separate backend correlation fields.

`projection_revision` changes for any graph, evidence, gate, action-card, or lifecycle material change. `sequence` is strictly increasing across the case/run event stream. `evidence_revision`, `gate_revision`, and `action_revision` are explicit monotonic sub-revisions so an old card or gate cannot be reused after relevant state changes.

### 3. Public API and event envelope

Keep `/v1/cases` for P0 compatibility. Add a workspace namespace rooted in the stable case identity after authenticated tenant lookup:

| Route | Strict request/response purpose |
| --- | --- |
| `POST /v1/incidents` | Starts `flowpulse.incident-workspace.v2`; returns `IncidentProjection` with backend-issued `incident_id`, `run_id`, and `topology_revision`, plus separate auditable `case_id`, `workflow_id`, and `workflow_run_id`. |
| `GET /v1/incidents/{case_id}/projection` | Returns the latest tenant-scoped `IncidentProjection`; never reconstructs a mutable workflow object. |
| `GET /v1/incidents/{case_id}/components/{component_id}/context` | Returns bounded canonical component context and recorded safe evidence references only. |
| `POST /v1/incidents/{case_id}/node-explanations` | Accepts only `component_id`, current `incident_id`/`run_id`/`topology_revision`/`projection_revision`, and an idempotency key; submits the Temporal start-or-reuse update. |
| `GET /v1/incidents/{case_id}/node-explanations/{explanation_id}` | Returns the durable explanation/turn projection and its provider/degraded truth label. |
| `POST /v1/incidents/{case_id}/conversations` | Explicit user submit only; carries a bounded user intent, current public canonical identity/revisions, conversation ID, and idempotency key. |
| `GET /v1/incidents/{case_id}/next-best-actions` | Returns server-generated fixed-taxonomy cards. |
| `POST /v1/incidents/{case_id}/actions/{action_id}` | The sole browser CTA invocation route. Its strict body is only `{incident_id, run_id, topology_revision, projection_revision, idempotency_key}`. FastAPI reloads the stored `NextBestAction`, revalidates tenant, lifecycle stage, canonical identity, action/gate/evidence/capability revisions, permission, TTL, current proof, gate status, and preconditions, then submits the matching Temporal update. |
| `POST /v1/incidents/{case_id}/gates/1`, `DELETE /v1/incidents/{case_id}/gates/1/{grant_id}`, `POST /v1/incidents/{case_id}/proposals`, and `POST /v1/incidents/{case_id}/proposals/{proposal_id}/dry-run` | Explicit lower-level P0 compatibility/internal aliases. Browser card CTAs do not call them or manufacture scope, tool, proposal, approval, witness, or capability payloads. |
| `GET /v1/incidents/{case_id}/events` | SSE projection stream with strict checkpoint/reconnect semantics. |

Every authenticated API lookup, including events, explanation, cards, proposal, approval, action invocation, and evidence lookup, is tenant-scoped before returning a 404/403. Route bodies do not self-assert tenant, subject, role, provider mode, evidence, authority, gate state, action scope, tool input, proposal, approval, precondition witness, or action success.

Each SSE frame has this canonical envelope:

```json
{
  "schema_version": "flowpulse.incident-event.v1",
  "tenant_id": "tenant-...",
  "incident_id": "incident-...",
  "run_id": "run-public-...",
  "topology_revision": "topology-v7-...",
  "case_id": "case-...",
  "temporal": { "workflow_id": "flowpulse...", "workflow_run_id": "temporal-run-..." },
  "projection_revision": 7,
  "sequence": 42,
  "event_type": "node_explanation.completed",
  "occurred_at": "2026-07-25T00:00:00Z",
  "payload": { "safe": "projection only" }
}
```

`after` and `Last-Event-ID` are exclusive, validated checkpoints. Events are queried by canonical sequence, are emitted in order, never re-run a model/tool on reconnect, include heartbeats only while nonterminal, and end with one terminal state event. A revision mismatch, missing projection, unavailable adapter, expired grant, or stale source returns an explicit degraded/fail-closed projection/event rather than a synthetic live response.

### 4. Durable node explanation and conversation behavior

The Node Explanation selection record is bound to the authoritative `(tenant_id, incident_id, run_id, topology_revision, case_id, workflow_id, workflow_run_id, projection_revision)` mapping. Its durable exactly-once selection is unique on `(tenant_id, run_id, projection_revision, component_id, conversation_schema_version)`; `topology_revision` is stored and revalidated as part of the binding. The stored key is exactly:

```text
node_explanation:{tenant_id}:{run_id}:{projection_revision}:{component_id}:{conversation_schema_version}
```

The Temporal update validates the public run/topology identity and its internal case/Temporal binding, component, and revision against its authoritative projection, then either returns the already-recorded explanation or schedules exactly one Conversation Manager activity. Concurrent clicks converge on that same row/activity result. A frontend hover, toast focus, drawer open, or SSE subscription has no POST route and cannot create an explanation, provider invocation, tool call, ledger event, or gate request.

The pre-Gate-1 `NodeExplanation` context is a bounded `ComponentContextPack` built exclusively from the canonical projection, recorded evidence envelopes visible to the subject, and Knowledge records labeled `REFERENCE_ONLY`. Its output must state that no fresh read occurred. It cannot invoke a capability adapter, fresh telemetry reader, deployment/config reader, or a current diagnosis claim. The output may be a provider-degraded/needs-human result; it must not substitute a deterministic answer in standard mode.

`ConversationManager` and its bounded specialists execute only as typed workspace Temporal activities. They receive the following ordered, hash-pinned inputs: `CorePolicy`, role prompt, `ComponentContextPack`, current incident state, explicit user/node intent, then safe runtime/evidence metadata. They return only strict response, citations, tool requests/results, handoff, cards, and status schemas. The manager cannot choose arbitrary component/run/URL/SQL/shell/repair/authority/tool names. Specialist assignments retain the existing one-primary/default and capped 2–4 specialist policy; the UI conversation cannot cause unbounded fan-out.

### 5. Provider gateway and capability registry

Add a `ModelProviderGateway` port, likely in `control_plane/flowpulse_cp/provider_gateway.py`, that accepts a typed prompt/context packet and returns a schema-validated result plus a server-owned capability label. The initial configured implementations are:

| Mode | Permitted configuration and projection | Fallback rule |
| --- | --- | --- |
| `standard` | An explicitly configured OpenAI-compatible endpoint/model/credential or local endpoint; only server configuration selects the provider. | Missing/unhealthy configuration returns typed degraded/unavailable; never deterministic text. |
| `local-open-source` | Explicit local endpoint and model, with no production credentials. It is used only by an opt-in smoke command. | Connection/schema failure is a typed unavailable result. |
| `test` / `demo` | Explicit runtime mode plus deterministic provider binding; response carries `TEST_DETERMINISTIC` or `RECORDED_DEMO`, never `LIVE_AI`. | It is unavailable outside local/test/demo, including a production process with a copied env variable. |

Provider configuration belongs in `config.py`; API, worker, and provider process only receive the secrets they need. No browser request can select endpoint, provider, model, auth headers, prompt, or truth label. The opt-in smoke requires an intentionally configured local OpenAI-compatible endpoint and is skipped otherwise; it must not contact OpenAI or any production service.

Add `capabilities.py` with a versioned, code-owned registry. Each entry declares family, adapter binding, strict input/output schema, tenant/ACL/data-class restrictions, required gate, budget, audit fields, and read/write safety. Families are `metrics`, `logs`, `traces`, `topology`, `deploy_config`, `kafka`, `github_ticketing`, and `safe_action`. Diagnosis and Conversation Manager consume the same resolved registry, adapter policy, call budget, and append-only tool-call record. A family is listed only if a real bound adapter passes its startup/health binding; otherwise it is absent with a dependency reason. The `safe_action` adapter remains dry-run contract generation/receipt only.

### 6. Gate 1, Gate 2, cards, and safety invariants

Add a Gate 1 record with the exact scope `(tenant, incident_id, run_id, topology_revision, case_id, workflow_id, workflow_run_id, component set, environment, capability set, data class, projection/evidence/capability-registry revisions, issued_at, expires_at, actor, status)`. It is created/revoked/expired through workspace Temporal updates and projected by activities. Before invoking any fresh read, the adapter validates authenticated subject permissions, active status, TTL, public-to-internal identity binding, scope, and every bound revision. Revoke, expiry, source freshness change, topology revision/component change, or relevant evidence/action revision invalidates the old grant and produces a bounded event/card update.

Gate 2 stays the existing Owner Gate: exact public `(incident_id, run_id, topology_revision)` to internal case/workflow/run mapping, proposal contract hash, case/revision, owner identity assertion, approval TTL, ordered targets, canary maximum, preconditions/current witness, idempotency binding, and dry-run-only action receipt. The workspace workflow invokes the already-protected Owner Gate activity; it must not create a parallel approval or action writer.

`NextBestAction` is a strict server-generated projection. It permits no caller-provided title, CTA, recommendation, scope, evidence, gate state, tool input, or proposal payload. It has an ID, public `incident_id`/`run_id`/`topology_revision` binding, fixed taxonomy ID/title/CTA label, dynamic English summary, display order, one-or-zero `recommended`, evidence refs and evidence revision, required capability/permission/gate, TTL, preconditions, version bundle, action revision, invalidation rules/status, and dry-run status. The only taxonomy mappings are:

| Group | Fixed titles | Allowed CTA IDs |
| --- | --- | --- |
| Investigate | `Find Cause`, `Map Impact`, `Review Evidence` | `request_gate_1`, `run_read_capability`, `review_evidence` |
| Decide | `Review Fix`, `Compare Options`, `Approve Plan` | `review_fix`, `compare_options`, `request_gate_2` |
| Execute | `Apply Fix`, `Track Progress`, `Prepare Rollback` | `submit_approved_action`, `track_progress`, `prepare_rollback` |
| Verify | `Compare Recovery`, `Check Risk`, `Close Incident` | `compare_recovery`, `check_risk`, `close_incident` |

At most three cards are returned and at most one is recommended. Card generation must preserve the current-proof/Knowledge-prior distinction, tenant/subject ACL, independent critic/verifier results, durable contradiction/coverage ledger, public run/topology binding, and no-production-write rule. A card that needs proof/gate/owner approval reports that need; it cannot imply that it has been granted. The browser invokes a card only through `POST /v1/incidents/{case_id}/actions/{action_id}`; the backend maps the fixed CTA to its registered Temporal update and refuses invocation if the reloaded card is missing, invalidated, stale, not permitted, or no longer bound to the submitted canonical identity.

### 7. Storage, migrations, and projections

Keep `001_control_plane.sql` byte-compatible and keep `002_authorization_intents.sql` forward-only. Proposed additive migrations are:

1. `003_incident_workspace_projection.sql`: external incident identity, `incident_run_bindings`, `incident_projections` with public run/topology identity, graph node/edge snapshots, immutable `incident_projection_events`, node-explanation selections/results, evidence run/topology bindings, and monotonic per-public-run sequence/revision constraints.
2. `004_incident_workspace_control_records.sql`: prompt/context/version bundles, conversation turns, provider invocations, capability registry snapshots/calls, Gate 1 grants, `next_best_actions`, action invocation receipts, and all supporting tenant/incident/run/topology/case/workflow/revision composite foreign keys.

Every new tenant-bearing table has `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, tenant policies, and subject ACL where evidence/context requires it. Child tables use composite tenant/incident/public-run/topology/case/workflow/revision FKs or equivalent constraints so a record cannot be rebound across a tenant, public run, topology, case, Temporal execution, or revision. Ledger/event rows are INSERT-only with no update/delete grants; projection replacement is limited to the Temporal activity projection transaction and must advance revision/sequence rather than `ON CONFLICT DO NOTHING` an updated state.

Replace the Compose one-file migration invocation with an ordered, idempotent migration runner that records applied migration versions/checksums. It applies new migrations to a 001/002 volume without data loss and fails before startup on checksum drift or an unsupported schema version. This runner remains local Compose infrastructure, not a production deployment mechanism.

Likely implementation files are `workspace_models.py`, `workspace_workflow.py`, `workspace_activities.py`, `workspace_projection.py`, `capabilities.py`, `provider_gateway.py`, `workspace_routes.py`, and narrow additions to `app.py`, `config.py`, `postgres.py`, `temporal_runtime.py`, `worker.py`, `activities.py`, `docker-compose.yml`, and `control_plane/README.md`. This separation keeps P0 contracts and frozen legacy workflow code small and replayable.

## Test-first execution plan

### Task 0 — Freeze compatibility, documentation, and the frontend dependency record

**Tests first.** Add `control_plane/tests/test_incident_workspace_docs_contract.py` to assert the three documents state the same authority boundary, declare the workspace workflow version, label test/demo provider behavior, link the read-only frontend spec revision, and preserve the public run/topology versus Temporal identity distinction. Add a contract fixture under `control_plane/tests/fixtures/incident_workspace_v1/` containing only safe request/response/event examples that the frontend owner can consume. Add a contract-freeze test that rejects frontend integration fixtures unless their recorded backend SHA/OpenAPI-schema SHA-256 and identity/auth mapping match the committed backend record.

**Likely files.** New root `README.md`; `control_plane/README.md`; `docs/architecture.md`; new `docs/architecture/incident-workspace-control-plane-contract.md`; the new test and fixture README. No frontend file changes.

**Acceptance.** Docs call FlowPulse a model-agnostic company-multiplayer agent OS with incident response first; they preserve Temporal, evidence, and authority constraints. The contract names API schema versions, the public `run_id`/`topology_revision` and separate internal Temporal correlation IDs, evidence refs, provider labels, same-origin auth transport, and the no-browser-mock expectation. The OpenAPI/schema bundle is emitted and hash-recorded before any frontend product integration consumes it. Existing P0 documentation/commands remain correct.

**Feedback/stop.** If the frontend spec asks the browser to author a workflow transition or a mutable truth record, stop for a contract decision rather than silently adapt the backend.

### Task 1 — Strict workspace contracts and additive storage schema

**Tests first.** Create `test_incident_workspace_contracts.py` and `test_live_incident_workspace_postgres.py` before models/migrations. Cover unknown field and primitive coercion rejection; public run/topology versus Temporal identity mapping; rejection of any derived/mismatched `run_id`; connected-or-classified graph membership; revision/sequence monotonicity; fixed CTA mapping; composite tenant/incident/run/topology/case/workflow/revision rejection; RLS; no update/delete of immutable records; and upgrade from preserved 001/002 data.

**Likely files.** `workspace_models.py`; `models.py` only for shared enum/imports; `postgres.py`; `003_incident_workspace_projection.sql`; `004_incident_workspace_control_records.sql`; a new ordered migration script; `docker-compose.yml` migration service.

**Acceptance.** The database accepts only tenant-scoped append-only workspace records bound to a real public run/topology and internal case/Temporal mapping, advances a projection only through the activity projection path, and fails closed for cross-tenant, stale, or forged/derived identity references. The 001 hash/baseline and 002 authorization consumption behavior remain unchanged.

**Commands.**

```bash
cd control_plane
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest tests.test_incident_workspace_contracts -v
FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_TEST_POSTGRES_DSN=postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse FLOWPULSE_TEST_POSTGRES_ADMIN_DSN=postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres .venv/bin/python -m unittest tests.test_live_incident_workspace_postgres -v
```

### Task 2 — Projection writer, query repository, and ordered SSE read model

**Tests first.** Add `test_incident_workspace_api.py` and `test_incident_workspace_sse.py` for exact `/v1/incidents` schemas, tenant lookup, public run/topology identity propagation, generic action invocation/revalidation, projection revision/sequence, terminal/degraded states, `Last-Event-ID` precedence/validation, reconnect strictly-after behavior, and no tool/provider invocation on GET/SSE.

**Likely files.** `workspace_projection.py`; `postgres.py`; `app.py` or `workspace_routes.py`; `workspace_models.py`; new SSE response helper; migration additions from Task 1.

**Acceptance.** FastAPI only reads tenant-scoped temporal-authoritative projections or submits typed commands. An event emitted by an activity is persisted before it becomes visible. `POST /actions/{action_id}` reloads the card rather than trusting browser scope/tool/proposal data, then submits only the registered Temporal update after all current validations pass. A stale/mismatched canonical identity or projection revision, missing event checkpoint, cross-tenant case, or unavailable projection fails closed/degraded without reconstructing state in the browser.

**Commands.**

```bash
cd control_plane
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest tests.test_incident_workspace_api tests.test_incident_workspace_sse -v
FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_LIVE_COMPOSE=1 FLOWPULSE_LIVE_API_OWNER_TOKEN="$FLOWPULSE_TEST_OWNER_TOKEN" .venv/bin/python -m unittest tests.test_live_incident_workspace_http -v
```

### Task 3 — New Temporal workspace workflow, node explanation, and replay boundary

**Tests first.** Add `test_workspace_workflow.py`, `test_node_explanations.py`, and `test_workspace_replay.py`. Prove intake creates one backend-issued public `run_id` mapped to, but not derived from, the real Temporal run; an update arriving before the first workflow task is safely ordered; concurrent same-key node explanation requests generate/reuse one result; a different projection/topology revision makes a distinct/invalidated result as applicable; toast/focus has no workflow/API side effect; and pre-Gate-1 context has no fresh capability call/current claim.

**Likely files.** `workspace_workflow.py`; `workspace_activities.py`; `temporal_runtime.py`; `worker.py`; `temporal_runtime.py`; `workspace_models.py`; `activities.py` only to register additive activity names.

**Acceptance.** The worker registers the new workflow and its activities while retaining frozen v1/v2 registrations. New raw histories are archived with producer SHA, public `run_id`, separate workflow/run IDs, event counts, and SHA-256, then replayed by the exact current workflow. Existing `test_live_temporal_replay_compat.py` continues to replay parent v1 histories without current-class history generation.

**Commands.**

```bash
cd control_plane
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest tests.test_workspace_workflow tests.test_node_explanations tests.test_workspace_replay -v
docker compose exec -T authz env FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_LIVE_TEMPORAL=1 FLOWPULSE_TEMPORAL_ADDRESS=temporal:7233 FLOWPULSE_TEST_POSTGRES_DSN=postgresql://flowpulse_cp_app:flowpulse-cp-local-only@postgres:5432/flowpulse python -m unittest tests.test_live_incident_workspace_temporal -v
python -m unittest tests.test_live_temporal_replay_compat -v
```

### Task 4 — Provider gateway, layered context, and bounded shared capabilities

**Tests first.** Add `test_provider_modes.py`, `test_conversation_manager.py`, and `test_capability_registry.py`. Use a deterministic fake only through an explicit test-mode dependency injection path. Assert standard mode cannot construct it, a disabled/unbound adapter is omitted, model output cannot change role/component/run/tool/authority, all tool inputs are strict, budgets are enforced, and autonomous/user Q&A receive the same capability policy and audit record.

**Likely files.** `provider_gateway.py`; `capabilities.py`; `workspace_activities.py`; `config.py`; `workspace_models.py`; `postgres.py`; `control_plane/README.md` configuration section.

**Acceptance.** Prompt layers and context hashes are durable/versioned; a provider response is schema validated before projection; the server labels test/demo and live/degraded correctly; no unavailable provider silently returns deterministic content; no unbound capability appears in a card/tool list. A local OpenAI-compatible smoke is opt-in and requires an intentionally configured local endpoint, never a production credential.

**Commands.**

```bash
cd control_plane
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest tests.test_provider_modes tests.test_conversation_manager tests.test_capability_registry -v
FLOWPULSE_LIVE_PROVIDER_SMOKE=1 FLOWPULSE_PROVIDER_MODE=local-open-source FLOWPULSE_OPENAI_COMPATIBLE_BASE_URL="$FLOWPULSE_LOCAL_OPENAI_COMPATIBLE_BASE_URL" FLOWPULSE_OPENAI_COMPATIBLE_MODEL="$FLOWPULSE_LOCAL_OPENAI_COMPATIBLE_MODEL" .venv/bin/python -m unittest tests.test_live_provider_smoke -v
```

The second command is deliberately skipped unless both local-only variables are supplied. It may not default to an OpenAI endpoint or read a production credential.

### Task 5 — Gate 1, Next Best Actions, and existing Owner Gate integration

**Tests first.** Add `test_gate1_capabilities.py`, `test_next_best_actions.py`, and `test_incident_workspace_safety.py`. Test the whole invalidation matrix (TTL, revoke, run/topology/projection/evidence/registry revision change, wrong tenant/component/capability/data class), card maximum/recommendation/taxonomy, generic action invocation that rejects browser-supplied scope/tool/proposal fields and revalidates a reloaded card, current-proof versus KB-prior prevention, critic/verifier independence, and no direct FastAPI approval/action write. Re-run existing exact Owner Gate/negative tests without weakening any assertion.

**Likely files.** `workspace_workflow.py`; `workspace_activities.py`; `workspace_projection.py`; `policy.py`; `actions.py`; `integrity.py`; `postgres.py`; workspace migrations.

**Acceptance.** Gate 1 permits only the precise fresh-read call it authorizes for the exact public run/topology and internal Temporal mapping. Gate 2/Owner Gate sees the exact existing proposal/approval/witness state and only produces an `APPROVED_READ_ONLY`/dry-run receipt after revalidation. All browser CTA invocation flows through the generic action endpoint, and all action cards remain recommendations; none performs an external mutation.

**Commands.**

```bash
cd control_plane
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest tests.test_gate1_capabilities tests.test_next_best_actions tests.test_incident_workspace_safety tests.test_no_ship_regressions tests.test_production_control_paths -v
docker compose exec -T authz env FLOWPULSE_LIVE_TEMPORAL=1 FLOWPULSE_TEMPORAL_ADDRESS=temporal:7233 python -m unittest tests.test_live_temporal_negative_paths -v
```

### Task 6 — Compose proof, frontend handoff, observability, and full matrix

**Tests first.** Add `test_live_incident_workspace_http.py`, `test_live_incident_workspace_temporal.py`, `test_live_incident_workspace_minio.py`, `test_live_frontend_contract_api.py`, and `test_workspace_evaluation.py`. The contract test performs real API intake → authoritative public run/topology projection → node explanation → generic card invocation for explicit Gate 1 → bounded read (when a test adapter is bound) → generic card invocation for proposal/Owner Gate dry run → ordered SSE resume. It asserts API response and events expose public `run_id`/`topology_revision`, separate actual Temporal workflow/run IDs, and evidence refs, then verifies corresponding Postgres/MinIO records. It never stubs browser fetches or claims the deterministic provider is live.

**Likely files.** `docker-compose.yml`; worker/API config; `control_plane/minio/` only for explicit local test fixture adapters; test modules/fixtures; README run instructions; evaluation hooks in `evaluation.py` or `workspace_evaluation.py`.

**Acceptance.** Compose retains real Temporal/Postgres/MinIO, API listening as configured, internal-only Temporal/authz, RLS, separate MinIO credentials, and no API storage/signing secret. The `test/demo` provider truth label is visible in all API/SSE results. The frontend owner receives the API fixture/command contract and runs browser E2E through a same-origin Node transport façade, not a direct browser bearer. The façade is configured process-side with the test-safe authenticated session/bearer, forwards it transparently to FastAPI, and has no authority to alter identity, projection, gate, action, or outcome or synthesize success. Browser tests must prove public run/topology/evidence values came from API projections and that the fixture token is absent from runtime config, browser JavaScript, browser network evidence, and screenshots. No frontend files are changed by this branch.

**Reproducible local stack and matrix.** Run only against an explicitly disposable local Compose volume; do not run the volume-removal command against a shared or production stack.

```bash
cd control_plane
# This local fixture token belongs only to Compose and backend-test processes.
# Never inject it into browser runtime config, a public frontend build variable, or browser requests.
export FLOWPULSE_TEST_OWNER_TOKEN="$(openssl rand -hex 32)"
docker compose down --volumes
docker compose up --build -d
FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_LIVE_COMPOSE=1 FLOWPULSE_LIVE_API_OWNER_TOKEN="$FLOWPULSE_TEST_OWNER_TOKEN" .venv/bin/python -m unittest tests.test_live_compose_http tests.test_live_incident_workspace_http tests.test_live_frontend_contract_api -v
FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_LIVE_POSTGRES=1 FLOWPULSE_TEST_POSTGRES_DSN=postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse FLOWPULSE_TEST_POSTGRES_ADMIN_DSN=postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres .venv/bin/python -m unittest tests.test_live_postgres_idempotency tests.test_live_incident_workspace_postgres -v
FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_LIVE_MINIO=1 .venv/bin/python -m unittest tests.test_live_minio_iam tests.test_live_incident_workspace_minio -v
FLOWPULSE_LIVE_HOST_BOUNDARY=1 .venv/bin/python -m unittest tests.test_live_host_boundaries -v
docker compose exec -T authz env FLOWPULSE_LIVE_INCIDENT_WORKSPACE=1 FLOWPULSE_LIVE_TEMPORAL=1 FLOWPULSE_TEMPORAL_ADDRESS=temporal:7233 FLOWPULSE_TEST_POSTGRES_DSN=postgresql://flowpulse_cp_app:flowpulse-cp-local-only@postgres:5432/flowpulse python -m unittest tests.test_live_temporal_negative_paths tests.test_live_incident_workspace_temporal -v
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest discover -s tests -v
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m compileall -q flowpulse_cp
```

`FLOWPULSE_LIVE_API_OWNER_TOKEN` in this matrix is restricted to the backend Python HTTP test process. It is not a frontend setting and must not be inherited by a browser build, browser test, or public runtime configuration.

**Evidence paths/records.** The live tests must print or save a safe run manifest under `/tmp/flowpulse-incident-workspace-evidence/<run-id>.json` containing public `incident_id`, `run_id`, and `topology_revision`; separate `case_id`, `workflow_id`, and `workflow_run_id` correlations; projection/event sequence ranges; evidence IDs/content hashes; provider truth label; and MinIO object keys—not secrets or raw evidence. The durable equivalents are the tenant-scoped `incident_run_bindings`, `incident_projections`, `incident_projection_events`, workspace control records, existing `case_events`/verification records, and tenant-prefixed MinIO artifacts. A test cleanup removes only its own `/tmp/flowpulse-incident-workspace-evidence` directory.

## Frontend dependency contract and handoff

The frontend owner needs only the committed safe fixture and the API/SSE schemas in this plan/contract document. Its E2E setup must:

1. Start the isolated backend Compose stack with the local fixture owner token above. That token remains confined to the Compose API and backend-test process environment.
2. Start the frontend's same-origin Node transport façade with `FLOWPULSE_CONTROL_PLANE_URL=http://127.0.0.1:8090` and a process-side local fixture session/bearer forwarding configuration. The Node process, not browser runtime configuration, holds this connection/bearer. The façade exposes only same-origin `/api/control-plane/v1/*`, strips/rejects browser-supplied `Authorization`, forwards the trusted server-side session/bearer upstream, and relays only the actual FastAPI status/body/SSE bytes; it has no identity, workflow, gate, card, or success-synthesis authority.
3. Point the browser only to the frontend same-origin `/api/control-plane/v1`; it must not call `http://127.0.0.1:8090` directly and must not store, render, or send `FLOWPULSE_TEST_OWNER_TOKEN` or an equivalent bearer.
4. Create/read a real workspace incident, capture the returned public `incident_id`, `run_id`, `topology_revision`, and evidence refs plus the separate auditable `case_id`, `workflow_id`, and `workflow_run_id`, then use them in graph/card/SSE assertions. The test must prove `run_id` was returned by the API binding rather than derived from either Temporal ID.
5. Assert a node click yields the same durable explanation ID for the same selection key, a toast/focus yields no API call, pre-Gate-1 output states no fresh read, generic `actions/{action_id}` invocations do not send browser-manufactured scope/tool/proposal data, and provider labels accurately show test/demo/degraded/live state.
6. Assert gate/card/owner transitions appear as ordered SSE/API projection events. It must not intercept or fixture browser fetch responses for these assertions. Capture and inspect runtime configuration, served browser JavaScript, browser network/HAR evidence, and screenshots to prove the bearer is absent from each; direct-browser-bearer testing is a failure, not acceptance.

The API contract deliberately leaves visual presentation, browser focus, layout, and CTA rendering to the frontend worktree. It preserves backend authority for canonical IDs, graph membership/status, provider/tool truth, evidence citations, gates, recommendation ordering, and action safety.

## Final verification and implementation handoff criteria

Before the implementation change is offered for review, record the exact backend SHA, frontend input SHA, migration checksums, workflow type/version, deterministic test count, live test count, skipped opt-in provider smoke status, and test manifest paths. Generate the OpenAPI document and safe schema/example bundle, record each artifact's SHA-256 with its producing backend SHA in both this plan/contract and the frontend integration plan, and do not unblock frontend product integration until the records match. Require:

- `git diff --check` clean and a clean worktree after coherent commits;
- old v1 parent-history replay, existing P0 deterministic/live matrices, and new workspace deterministic/live matrices all passing;
- real Compose API/Temporal/Postgres/MinIO evidence with no host exposure regression for Temporal/authz, a same-origin Node transport façade, no browser mock, and runtime-config/browser-JS/network/screenshot proof that no fixture bearer reaches the browser;
- RLS/tenant/ACL/strict-schema/current-proof/critic/verifier/Owner Gate/dry-run regression tests passing;
- a review stop if an adapter, provider credential, external deployment, destructive migration, or authority change outside this plan is requested.

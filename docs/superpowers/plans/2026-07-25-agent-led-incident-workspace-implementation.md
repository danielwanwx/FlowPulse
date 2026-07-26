# Agent-led Incident Workspace implementation plan

**Status:** approved-design implementation plan; execution has not started

**Date:** 2026-07-25

**Approved design input:** [2026-07-25-agent-led-incident-workspace-design.md](../specs/2026-07-25-agent-led-incident-workspace-design.md) at `4adb8f5c0c49382e894732318530c83d9a0b5611`

**Frontend baseline:** `4adb8f5c0c49382e894732318530c83d9a0b5611` on `codex/incident-workspace-unification`

**Control-plane dependency (read-only from this worktree):** `/Users/danielwan/Documents/Codex/2026-07-25/flowpulse-diagnosis-control-plane-p0/repo` on `codex/diagnosis-control-plane-p0`

**Visual references only:** `/Users/danielwan/.codex/visualizations/2026/07/15/019f63ed-9b24-7330-b0e1-82581d7d4c3a/flowpulse-ux-redesign/.superpowers/brainstorm/59138-1785042796/content/05-incident-workspace-english-only.html` through `13-recommended-agent-architecture.html`. They guide visual comparison; they are neither runtime data nor acceptance evidence.

## 1. Goal and Loop Engineering contract

### Goal

Evolve the existing Node-served FlowPulse frontend into the first vertical of a model-agnostic, company-multiplayer agent operating system. Architecture and Live remain top-level views. Incident becomes the single persistent, backend-authoritative workspace for **Investigate → Decide → Execute → Verify**. Its visible state, incident entry, conversation, cards, approvals, actions, graph, and verification must come from the separate FastAPI/Temporal control plane on the normal product path.

No browser-local incident, recommendation, gate, evidence, agent response, or action success may make the standard path appear successful. The existing Node replay is retained only as an explicitly labeled compatibility/demo mode. It cannot satisfy this plan's control-plane or release acceptance.

### Loop contract

| Loop element | Contract |
| --- | --- |
| **Input** | Approved design spec; current Node frontend; FastAPI/Temporal P0 service and published OpenAPI/contract; configured authenticated local control plane; approved visual companions. |
| **Execute** | Make one bounded milestone at a time. Write the failing focused test or executable contract probe first, then implement the smallest scoped change that passes it. Do not begin a dependent milestone until its input contract has passed. |
| **Check** | Run focused frontend tests, relevant control-plane contract checks, browser accessibility/interaction checks, then the full `npm test` suite. For real integration, preserve correlated browser, API, Temporal, Postgres/ledger, and screenshot evidence. |
| **Feedback** | Treat unavailable, malformed, unknown-version, cross-tenant, stale, expired, unauthorized, or contradictory input as non-actionable. Render a clear degraded/error state and preserve canonical identity; never substitute local replay or optimistic UI. |
| **Record** | Maintain the contract map, compatibility decisions, command log, evidence folder, observed workflow IDs, ledger references, screenshots, and unresolved dependencies in section 14. |
| **Stop** | Stop the active milestone on a missing required backend contract, authority ambiguity, identity mismatch, tenant-isolation failure, unavailable backend, browser success sourced from a fixture, or a failing focused test that cannot be traced to an in-scope root cause. |
| **Human gates** | Backend owner accepts the presentation contract; security owner accepts browser-to-control-plane authentication; an owner grants Gate 1 or Gate 2 only through the backend; a human authorizes external services, credentials, migrations, and any production mutation. |

### Non-negotiable invariants

1. **Temporal is the only incident lifecycle authority.** Agents propose, backend validators decide, registered tools execute, the Evidence Ledger records, and Temporal accepts the next transition. The frontend is a strict projection client, not a second workflow engine.
2. **Current proof is distinct from Knowledge Plane prior.** Runbooks, historical incidents, Component Context Packs, and prompt context can offer explicitly labeled bounded priors. They cannot satisfy an action, verification, Gate 1, Gate 2, or precondition.
3. **One canonical identity crosses every request and frame.** A workspace is bound to `tenant_id`, `incident_id`, `run_id`, `projection_revision`, `topology_revision`, and the exact node/edge set from the accepted projection. The browser never mixes revisions or runs.
4. **Only server-issued capabilities are actionable.** The client renders an allowed card taxonomy and sends a server-issued action ID plus canonical identity and idempotency key. It does not manufacture capability, recommendation, approval, tool input, evidence, or verdict.
5. **Read and write remain separated.** Gate 1 permits only registered fresh-read capabilities. Gate 2 permits only a current, approved, dry-run-backed, precondition-checked mutation. Neither gate can be optimistic or browser-issued.
6. **English is the only product-visible copy language.** Internal errors/protocol strings map to short English messages. Raw identifiers, prompt text, model names, internal role routing, and ledger internals stay out of primary operator UI.

## 2. Starting facts, ownership, and integration readiness

### Current facts

The diagnosis control plane currently exposes `GET /healthz`, `POST /v1/cases`, `GET /v1/cases/{case_id}`, `POST /v1/proposals`, and `POST /v1/proposals/{proposal_id}/dry-run`. Local Compose publishes FastAPI on port `8090`, Postgres on `127.0.0.1:5433`, and a Temporal worker inside the Compose network. It is authoritative for its P0 case/proposal flow, but it does **not yet publish** the browser presentation contracts this workspace requires: bounded Incident projection, topology stream, NodeExplanation stream/reuse, Conversation Manager projection, NextBestAction list, Gate projections, action submission result, or a versioned browser event stream.

This is a dependency, not a license to recreate results in the Node app. Milestones that require those contracts stop in a clear unavailable state until the backend owner publishes and tests them.

### Ownership boundary

| Area | Owner | Frontend responsibility | Forbidden frontend behavior |
| --- | --- | --- | --- |
| Lifecycle, state transitions, approvals, retries | FastAPI + Temporal | Render accepted projections and request typed commands | Infer stage, advance lifecycle, or retry an action as a new authority path |
| Current evidence, lineage, verifier/critic outputs | Control plane + Evidence Ledger | Render bounded safe summaries/references | Construct evidence or upgrade a prior into current proof |
| LLM prompts, roles, specialists, tools | Backend Activities + shared runtime | Render Conversation Manager events and validated cards | Call model/tool providers directly or expose prompt/role internals |
| Authentication and tenant scope | Trusted backend auth context | Forward an approved user session through the selected transport | Store a service bearer token in browser JavaScript or select tenant/role client-side |
| Display, keyboard interaction, accessibility, motion | This frontend | Strictly validate projections, preserve selection/focus, expose degraded states | Turn a visual state into a successful authority state |

### Canonical identity envelope

The backend contract must name the fields below exactly or publish an explicit, tested mapping before implementation begins. `case_id` may be a control-plane internal identifier, but it is not a replacement for the browser's canonical incident/run pair.

```text
CanonicalIdentityV1 = {
  schema_version: "flowpulse.frontend-identity.v1",
  tenant_id,
  incident_id,
  run_id,
  projection_revision,
  topology_revision,
  case_id,
  temporal_workflow_id,
  temporal_workflow_run_id
}
```

Every projection, NextBestAction, gate, event frame, conversation event, action receipt, and evidence reference must bind to the same identity. `case_id`, `temporal_workflow_id`, and `temporal_workflow_run_id` are correlation fields; the client does not derive `run_id` from their string form. A differing tenant, incident, run, revision, or unrecognized node/edge set is rejected before render as an incompatible projection.

### Required frontend-facing API contract

The endpoint names below are required **v1 contract shapes**, pending backend-owner confirmation in its OpenAPI document. They are intentionally not claimed to exist in P0 today. FastAPI owns final path spelling, authentication, and response models; any change requires a versioned mapping in section 14 before frontend implementation continues.

| Operation | Required v1 result and rules | Frontend use |
| --- | --- | --- |
| `GET IncidentProjection` | Bounded `IncidentProjectionV1`: canonical identity, stage/status, full Live topology or explicit classifications, impacted path, compact timeline, source health, gate projections, verification, safe evidence summaries/references, selected-component context, and backend capability state. | Initial hydration and authoritative rehydrate. |
| `GET IncidentEvents` (SSE) | Ordered, resumable `IncidentProjectionEventV1` frames with event ID/sequence, canonical identity, projection/topology revision, bounded delta or accepted projection, terminal/source-health marker, and no raw evidence/prompt/tool payload. | Keep selected run current; never creates authority. |
| `POST NodeExplanation` then stream/read | Server creates or reuses the durable component-scoped `node_explanation` turn keyed by tenant/run/revision/component/schema. It returns/streams only canonical projection, recorded evidence, and explicitly labeled Context Pack priors. It must not call fresh-read tools before Gate 1. | One affected-node click opens/resumes stable Conversation Manager. |
| `GET Conversation` and `GET ConversationEvents` (SSE) | One bounded Conversation Manager projection and ordered safe events. Specialists remain backend agents-as-tools. | Restore/stream panel without browser model call. |
| `GET NextBestActions` | Backend-issued bounded `NextBestActionV1[]` with fixed card/CTA schema, evidence lineage, permissions, gate/precondition status, version bundle, TTL, invalidation reason. | Render up to three follow-up cards after strict validation. |
| `POST GateRequest` / `GET GateProjection` | Typed Temporal Signal/Update result and authoritative Gate 1/Gate 2 projection with tenant, incident, scope, TTL, state, reasons, revision binding. | Request/reload human-gate state; never locally grant it. |
| `POST ActionSubmit` / action event stream | Accepts only server-issued action ID, canonical identity, idempotency key; backend revalidates before Temporal Update/Activity work. Receipt is pending/blocked/accepted, never browser-declared success. | Submit fixed CTA and display backend progress/invalidations. |

The contract must also publish bounded enum allowlists, size/count limits, schema versions, retention/replay semantics, HTTP error taxonomy, SSE replay semantics, idempotency rules, and invalidation behavior. Unknown fields or versions fail closed unless the version policy explicitly permits an additive field.

### Transport and runtime configuration decision

The browser must not own a control-plane credential. The planned default is a same-origin Node transport façade, configured only at process start, that forwards the authenticated user session to the separately running FastAPI service. This avoids a browser bearer secret and makes the service origin auditable. It is not a second business backend: it may route, stream, enforce request-size/time limits, and preserve status/headers, but it may not create, alter, cache-success, or synthesize control-plane content.

Likely implementation files:

```text
src/server.mjs                         add same-origin control-plane routes
src/control-plane-proxy.mjs            new, transparent bounded proxy/stream relay
public/control-plane-client.mjs        new, versioned strict client
public/control-plane-contract.mjs      new, safe parser/validator and error taxonomy
public/incident-session.mjs            new, canonical projection/session controller
public/app.js                          consume only the client/session controller
test/control-plane-proxy.test.mjs      new proxy/auth/status tests
test/control-plane-contract.test.mjs   new parsing and fail-closed tests
```

`FLOWPULSE_CONTROL_PLANE_URL` is mandatory for `control-plane` mode. The browser learns only a safe runtime descriptor through same-origin `GET /api/runtime-config`, for example `{ mode: "control-plane", api_base: "/api/control-plane/v1", api_version: "v1" }`; it never receives a service token. If the authentication owner chooses direct FastAPI browser access instead, the owner must first publish the CORS, cookie/credential, CSRF, tenant, and origin contract and replace this transport decision in the contract map. Until then, do not implement a direct cross-origin fallback.

`compatibility-demo` is an explicit runtime mode with a persistent English label: “Compatibility replay — not connected to the control plane.” It must be selected deliberately (`FLOWPULSE_PRODUCT_MODE=compatibility-demo`) and must not share the standard client route, acceptance tests, or success labels. With no configured control plane in standard mode, the app displays accessible “Control plane unavailable” state and a manual retry only; it does not fall back to `/api/demo/*`, `local-fault-loop`, fixtures, or session cache as truth.

## 3. Execution discipline used by every milestone

For every task below:

1. Record baseline SHA, affected files, backend contract version, and the command that currently passes.
2. Add a narrow failing test or real contract probe. A test double is permitted only at an isolated parser/client seam and must not make a production-mode browser test pass.
3. Implement the smallest scoped production change. Keep authority, recommendation, gates, evidence, and execution on the backend side of the selected transport.
4. Run the focused test, inspect rendered interaction where visual, then run the nearest contract test and `npm test` before committing the milestone.
5. Capture commands, contract version, outcome, identities, and evidence paths in the records ledger. Do not carry an unexplained failure forward.

The frontend stages each response in local `nextProjection`, validates current canonical identity and request generation, then atomically commits only if still current. A stale, mismatched, malformed, or superseded response never changes canvas, panel, active stage, URL, or retry controller. Existing pinned-run, topology-tracker, loading-token, and shared-stream race protections remain required regression behavior rather than being replaced by a simpler local cache.

## 4. Milestone 1 — North Star documentation and harness framing

### Outcome

The repository plainly describes FlowPulse as a model-agnostic, company-multiplayer agent operating system whose first vertical is Incident. It retains evidence, authority, local replay, and execution-mode truth labels without claiming that the presentation layer is authority.

### Test-first tasks

1. Add `test/north-star-docs.test.mjs`. It fails until root README and core architecture documents agree on model-agnostic runtime, multiple company roles/tenants, Incident as first vertical, Temporal/control-plane authority, and compatibility/demo separation.
2. Add assertions that docs do not describe the five old workspaces as current navigation and do not promise browser-local approval, verification, or agent execution.
3. Update the documents, then run:

   ```bash
   node --test test/north-star-docs.test.mjs
   npm test
   ```

### Likely files

```text
README.md
docs/architecture/flowpulse-harness.md
docs/architecture/2026-07-19-backend-capability-audit.md
docs/architecture/local-fault-to-recovery-loop-contract.md
docs/architecture/node-investigation-plane-frontend-contract.md
docs/architecture/agent-team-chat-backend-contract.md
test/north-star-docs.test.mjs                 new
```

### Required content and acceptance

- State that Architecture, Live, and Incident are the three top-level product views, and Incident is a staged vertical rather than a second authority.
- Describe the shared capability runtime and model-agnostic adapters without identifying any provider as product truth.
- Preserve captured/demo, frozen, live, stale, and unavailable evidence labels, separate from execution mode.
- Link the approved design and this plan; mark legacy Node replay and Agent Team contracts as compatibility until control-plane equivalents are live.

All changed documents agree, the test passes, `git diff --check` is clean, and no prose upgrades a demo/recorded artifact into current evidence. Stop if a document claim would require a backend capability the owner has not accepted.

## 5. Milestone 2 — Real FastAPI/Temporal integration boundary

### Outcome

The normal browser path uses a versioned control-plane client and transparent same-origin transport. It fails closed when FastAPI is unavailable or an unaccepted/invalid schema arrives. Legacy Node demo stays visibly separate and cannot satisfy standard success state.

### Contract readiness gate (human and cross-worktree gate)

Before changing `public/app.js` to consume the new API, obtain from the diagnosis-control-plane owner:

1. A committed OpenAPI or equivalent versioned schema containing every operation in section 2, including auth/session and SSE fields.
2. A durable mapping from the control plane's `case_id`, `workflow_id`, and `workflow_run_id` to `CanonicalIdentityV1`.
3. A controlled local Compose scenario that creates one tenant-scoped incident with topology, evidence, at least one Gate 1 request state, and Temporal/Postgres correlation records.
4. An explicit decision on same-origin proxy session forwarding, or approved secure direct-browser alternative.

Record backend SHA, OpenAPI artifact/version/hash, local port, test tenant/subject redaction policy, and contract examples. If any item is missing, document it as an unresolved dependency and stop this milestone. Render unavailable in the product; do not stub a successful projection or implement a parallel Node endpoint.

### Shared runtime and agent boundary to confirm with backend owner

The browser contract must expose the output of one shared Capability Registry, Tool Adapter layer, and Evidence Ledger for both auto-diagnosis and user Q&A. It must identify capability ID/version, read/write class, component scope, allowed tenant/environment, current evidence references, risk, gate/precondition/approval state, and VersionBundle. It must never expose tool credentials, arbitrary request arguments, prompt text, activity internals, raw telemetry, or an authority object.

The only visible agent is Conversation Manager. Diagnosis roles (Orchestrator, Investigator, Critic, Verifier) and interactive specialists are backend-owned bounded agents-as-tools. The v1 contract must prove that Critic and Verifier are independent and that all LLM, tool, database, and external API work occurs in Temporal Activities. Signals handle asynchronous incident events; validated gate/action commands use Temporal Updates. Sessions, tracing, and SDK guardrails are observability controls, not state/evidence/authorization authority.

Add contract probes that reject an action or response without Evidence Ledger lineage, capability/version binding, tenant scope, or a labeled Knowledge Plane prior. Add a browser assertion that clicking a user question or recommendation never selects a model, role, tool, endpoint, SQL query, or evidence payload locally.

### Test-first tasks

1. Add parser fixtures in `test/control-plane-contract.test.mjs` sourced from backend-owned schema examples. Cover valid projection/action/gate/SSE event, unknown schema, unsupported enum, missing identity, differing revision, invalid node/edge endpoint, raw evidence field, cross-tenant frame, expired action.
2. Add `test/control-plane-proxy.test.mjs` before proxy implementation. Assert configured forwarding preserves backend status/body/event framing, rejects oversized/unsafe browser requests, returns structured unavailable status when target absent, and never redirects to `/api/demo/*`.
3. Add `test/standard-path-no-mock.test.mjs` that starts frontend without `FLOWPULSE_CONTROL_PLANE_URL`, opens standard mode, and proves no browser success projection, local-fault EventSource, or demo run request occurs.
4. Implement strict client/config/proxy only after these tests fail for the intended missing behavior. Run:

   ```bash
   node --test test/control-plane-contract.test.mjs
   node --test test/control-plane-proxy.test.mjs
   node --test test/standard-path-no-mock.test.mjs
   npm test
   ```

### Likely files

```text
src/server.mjs
src/control-plane-proxy.mjs                 new
public/index.html
public/app.js
public/control-plane-client.mjs             new
public/control-plane-contract.mjs           new
public/incident-session.mjs                 new
test/server.test.mjs
test/control-plane-contract.test.mjs        new
test/control-plane-proxy.test.mjs           new
test/standard-path-no-mock.test.mjs         new
```

### Implementation rules and acceptance

- `public/control-plane-client.mjs` owns v1 paths, content checks, permitted idempotency header construction, structured `HttpError`, SSE parsing, and schema validation handoff. It exposes no local replay data and accepts no caller-provided authority/evidence fields.
- `public/control-plane-contract.mjs` owns finite allowlists and safe display transforms. It rejects raw telemetry, prompts, tool payloads, secret shapes, unbounded arrays/text, unknown cards, and identity drift.
- `src/control-plane-proxy.mjs` forwards only configured `/v1` paths and streams. It has no response-success cache, no retry that turns failed command into success, and no tenant/role selection from query/body.
- `public/incident-session.mjs` owns only client state: unavailable, loading, ready, stale, reconnecting, incompatible, terminal error. It is not an incident store.
- On 401/403/404/409/422, display stable terminal error for selected identity and stop automatic retries. Retry only network failures, 408, 429, and defined retryable 5xx responses, with bounded documented backoff.

With no backend configured, standard mode is visibly unavailable and makes no demo request. With valid configured backend, every accepted object has validated v1 schema and canonical identity. Stop on missing contract, auth ambiguity, endpoint that cannot prove tenant scope, or any test where demo data makes standard mode ready.

## 6. Milestone 3 — Live graph and compact navigation

### Outcome

Live renders backend-projected topology with exactly three tabs: Architecture, Live, and Incident. Every visible node either has at least one visible upstream/downstream connection or carries an explicit backend classification: External dependency, Data store, Control plane, Observed boundary, or Relationship unavailable. Affected incident nodes have the specified red glow and impacted path. Flow/status motion is perceptible only when the backend projection says it is, with an accessible reduced-motion alternative.

### Test-first tasks

1. Extend `test/control-plane-contract.test.mjs` with connected-or-classified cases. Reject orphan service node, dangling edge, unrecognized classification, node from second topology revision, and synthetic motion status absent from projection.
2. Add rendering tests in `test/twin-state.test.mjs` or `test/live-graph-render.test.mjs` for three nav labels only, graph membership/edge endpoints, incident root/path classes, backend status labeling, no raw IDs, and no compatibility graph in control-plane mode.
3. Add DOM/CSS accessibility assertions for `prefers-reduced-motion: reduce`: no projectile/current animation while status remains textually available.
4. Compare desktop and constrained screenshots with visual references 05–10 and existing FlowPulse language. Record deltas before changing CSS.

Run:

```bash
node --test test/control-plane-contract.test.mjs
node --test test/twin-state.test.mjs
npm test
```

### Likely files

```text
public/index.html
public/app.js
public/twin-state.mjs
public/styles.css
public/incident-session.mjs
test/control-plane-contract.test.mjs
test/twin-state.test.mjs
test/live-graph-render.test.mjs             new if DOM coverage is isolated
```

### Implementation rules and acceptance

- Reuse stable backend component IDs and explicit edge IDs. Do not draw an inferred relation to make a graph look complete.
- Use smooth curved connectors and subtle current cursor only for bounded backend-projected active flow. Red affected glow is incident status, not browser diagnosis.
- Architecture remains independent from incident focus. Live stays complete; Incident may focus impacted path from the same canonical topology.
- Remove empty header/navigation slots in the three-tab layout. Keep keyboard focus and selected tab robust across full render.

The accepted projection alone explains connectivity/classification. Reduced motion remains informative. Stop if backend lacks node/edge/classification fields; do not reintroduce a checkout fixture to fill gaps.

## 7. Milestone 4 — Passive incident entry and exactly-once NodeExplanation

### Outcome

A new incident is quiet until operator engagement. A lightweight top-left toast focuses impacted path and opens global summary without starting chat, investigation, or tool call. Clicking affected red node opens node-scoped right workspace and starts or resumes exactly one server-owned `NodeExplanation` stream for durable selection key. It gives a short component-specific explanation and one next step, normally “Request investigation access” when Gate 1 is absent.

### Test-first tasks

1. Add `NodeExplanation` parser tests for valid start/reuse acknowledgement, replayed terminal turn, ordered stream event, selection-key mismatch, stale revision, duplicate event, raw tool result, and pre-Gate-1 explanation that falsely claims fresh diagnosis.
2. Add `test/incident-entry-browser.test.mjs` (or established browser harness): toast focus makes zero NodeExplanation, conversation, read-tool, or action requests; one red-node click makes exactly one start/reuse request; repeated click, duplicate SSE event, and reload reuse same turn; switching component/revision creates only correct distinct scoped turn.
3. Add negative test that unaffected/noncanonical node cannot start a NodeExplanation and missing Gate 1 cannot permit fresh-read intent.
4. Run focused tests, then real browser interaction against configured control plane after backend contract gate is satisfied.

### Likely files

```text
public/app.js
public/incident-session.mjs
public/control-plane-client.mjs
public/control-plane-contract.mjs
public/styles.css
test/control-plane-contract.test.mjs
test/incident-entry-browser.test.mjs        new
test/twin-state.test.mjs
```

### Request and stream rules

- Selection binds to `tenant_id`, `run_id`, `projection_revision`, `component_id`, and `conversation_schema_version`. Backend derives or validates durable key `node_explanation:{tenant_id}:{run_id}:{projection_revision}:{component_id}:{conversation_schema_version}`; browser may hold idempotency token but cannot choose explanation content/evidence.
- Request contains only canonical identity, canonical component ID, allowed conversation schema version, and idempotency key. It never contains evidence, tools, prompt text, approval, stage, or claim values from browser.
- Before Gate 1, renderer may show recorded evidence and Context Pack priors only when backend labels the latter `prior`. It must say neither “investigated” nor a fresh causal conclusion.
- Conversation stream resumes by backend sequence/turn ID and deduplicates immutable message/event IDs. Connection loss reports stale state; it never creates second turn to recover.

### Acceptance and stop

One toast focus yields no server-side conversation/tool record. One red node click produces one component-bound backend turn, correlated in E2E records. Stop if backend cannot provide durable reuse or needs fresh tools before Gate 1; render contextual panel blocked instead of inventing a sentence.

## 8. Milestone 5 — Right-side decision workspace

### Outcome

The right workspace is a calm decision surface: approximately 430 px normal and 560 px report mode. It persistently contains only current node/Agent context, one stable Conversation Manager conversation, and composer. Structured cards may appear in conversation. Verification Summary, Agent roster, Evidence Ledger, model/internal routing, and grey eyebrow metadata are not permanently mounted.

### Test-first tasks

1. Add rendering tests for normal/report widths, focus order, accessible panel name, close/return behavior, constrained viewport, persistence of selected component/conversation through canonical render.
2. Add content tests that reject non-English primary copy, raw full run/case/incident IDs, internal role labels, source JSON, prompt text, permanently visible roster/ledger/verification panel.
3. Add test that every rendered conversation claim has backend-provided safe evidence references when evidence appears, while details stay behind “Show evidence”.
4. Inspect screenshots against visual references 05–09 before accepting CSS.

### Likely files

```text
public/index.html
public/app.js
public/styles.css
public/control-plane-contract.mjs
test/twin-state.test.mjs
test/incident-workspace-render.test.mjs     new
test/incident-workspace-a11y.test.mjs       new
```

### Implementation rules and acceptance

- Keep visible stable name **Conversation Manager**. Backend specialists are bounded agents-as-tools and may surface as concise structured results, never a persistent roster or autonomous chat swarm.
- A card contains one short English explanation, bounded evidence disclosure, validated action affordance. No card renders raw model/provider/tool status.
- Use semantic HTML and ARIA only where it adds information. Selected node, stage, and CTA focus survive full rerender.

The panel is keyboard-usable and retains no stale component after revision change. Stop if visual requirements require hiding an authority/reason state; retain accessible error rather than false calm.

## 9. Milestone 6 — Fixed cards, CTA taxonomy, and NextBestAction

### Outcome

Server issues bounded `NextBestActionV1[]`; frontend validates and renders at most three large horizontal-carousel follow-up cards. Exactly one may be recommended. It uses fixed stage taxonomy and fixed English title/CTA mapping from approved spec; only server-generated summary, ordering, recommendation, and allowed CTA behavior are dynamic.

### Fixed client allowlist

Frontend may contain static schema allowlist only to reject unknown contracts. It must not choose/rank actions:

| Stage | Fixed card titles | Fixed CTA behavior → label |
| --- | --- | --- |
| Investigate | Find Cause; Map Impact; Review Evidence | `request_gate_1` → Request investigation access; `run_read_capability` → Investigate; `review_evidence` → Review evidence |
| Decide | Review Fix; Compare Options; Approve Plan | `review_fix` → Review fix; `compare_options` → Compare options; `request_gate_2` → Request plan approval |
| Execute | Apply Fix; Track Progress; Prepare Rollback | `submit_approved_action` → Apply approved fix; `track_progress` → Track progress; `prepare_rollback` → Prepare rollback |
| Verify | Compare Recovery; Check Risk; Close Incident | `compare_recovery` → Compare recovery; `check_risk` → Check risk; `close_incident` → Close incident |

### Test-first tasks

1. Add `test/next-best-action-contract.test.mjs` before card implementation. Accept only schema-valid action with canonical identity, fixed title, mapped CTA, capability reference, component, evidence refs, risk, permissions, approval/preconditions, VersionBundle, expiry/TTL, invalidation metadata.
2. Reject invented title/CTA, more than three cards, two recommendations, expired TTL, wrong stage, missing current evidence, prior-only proof, invalid component, mismatched revision, missing gate, unknown capability.
3. Add browser tests that card click sends only `{ action_id, canonical_identity, idempotency_key }`; stale cards disappear/disable after projection/evidence/gate/version change; no handler constructs arbitrary tool/action payload.
4. Add accessibility tests for carousel keyboard behavior, recommended state, concise card copy, CTA name.

Run:

```bash
node --test test/next-best-action-contract.test.mjs
node --test test/incident-workspace-render.test.mjs
npm test
```

### Likely files

```text
public/control-plane-contract.mjs
public/control-plane-client.mjs
public/app.js
public/styles.css
public/incident-session.mjs
test/next-best-action-contract.test.mjs      new
test/incident-workspace-render.test.mjs
test/incident-workspace-a11y.test.mjs
```

### Acceptance and stop

No valid-looking browser object becomes a card without current backend-issued action. Expired/invalidated action cannot submit. Stop if service cannot provide evidence, version, precondition, and TTL bindings; do not make locally generated default recommendation visible.

## 10. Milestone 7 — Gate 1, Gate 2, and action progress

### Outcome

Gate 1 and Gate 2 render only backend/Temporal projections. Gate 1 allows backend registered read capabilities for exact tenant/incident/scope/TTL. Gate 2 permits only server-approved plan after dry run, approval, exact preconditions, current evidence. Browser shows progress, blocked, expired, denied, or failed verification without optimistic authority.

### Test-first tasks

1. Add strict gate projection parser tests: current scoped Gate 1 works only for permitted read capability; expired/revoked/wrong-tenant/wrong-run Gate 1 remains blocked. Correct Knowledge Plane prior alone fails each gate.
2. Add Gate 2 tests for current owner identity, action ID, dry-run receipt, ordered preconditions, TTL, risk, rollback contract, Temporal-accepted state. Reject forged approval, stale revision, arbitrary `repair.executed`, bypassed dry run, execution scope `none`.
3. Add action-submit tests proving client never displays success before server receipt/event and server rejection leaves no local mutation. Cover 409/422 invalidation and verification-failed result with clear English review guidance.
4. Test independent Critic/Verifier failure: block/fail correct stage rather than promoting a passed verdict from raw event.

### Likely files

```text
public/control-plane-contract.mjs
public/control-plane-client.mjs
public/incident-session.mjs
public/app.js
test/control-plane-contract.test.mjs
test/next-best-action-contract.test.mjs
test/incident-gates.test.mjs                new
test/twin-state.test.mjs
```

### Implementation rules and acceptance

- Gate requests/actions use backend-issued IDs and server revalidation. CTA may show disabled reason but cannot change stage locally.
- Present failed verification as failed with recorded repair/progress context and operator-review guidance. Never call it pending or claim no repair occurred when execution evidence exists.
- Passed recovery comparison requires independent verifier chain, terminal recovered state, and available compare capability. No raw latest-event shortcut in any panel or timeline.

Every enabled read/mutation interaction has accepted current gate/capability projection and server receipt. Stop when owner approval or dry-run contract absent; show blocked/degraded state without workaround.

## 11. Milestone 8 — SSE, reload, identity, stale state, and retry behavior

### Outcome

Reload, deep link, stream, and manual retry preserve pinned canonical run. URL gains backend-selected `run_id` on initial hydration and subsequent projection/SSE/conversation/action requests stay bound to it. Network/schema failures remain visible and accessible as reconnecting/stale or terminal error, never masquerade as healthy completed workspace.

### Test-first tasks

1. Port/extend existing request-generation tests in `test/twin-state.test.mjs` to control-plane session controller. Cover A→B and same-run newer-first/older-late responses, projection revision/node/edge preservation, superseded topology tracker cleanup, foreground-loading token behavior.
2. Add initial deep-link/reload test where backend-selected `run_id` enters URL only after successful identity validation. Competing tab or late old response cannot replace it.
3. Add SSE tests for valid-frame-only connected state, schema failure, hydration failure, terminal hydration failure, 750→1500→3000 ms cap, one-shot 503 recovery, 404/400 no-loop, cancellation of old selected/shared timers on switch/terminal error.
4. Add accessibility test that connection state remains visible if Incident canvas/strip hidden and stage focus restores after full rerender.
5. Add browser race/reload tests using delayed real test-server responses. Assert old state never renders and manual retry cannot cause hidden third request after terminal 404.

### Likely files

```text
public/incident-session.mjs
public/control-plane-client.mjs
public/app.js
public/twin-state.mjs
public/styles.css
test/twin-state.test.mjs
test/control-plane-client.test.mjs           new
test/incident-session-race.test.mjs          new
test/incident-reload-browser.test.mjs        new
```

### Implementation rules and acceptance

- Treat each state read as generation-owned transaction: fetch local value, validate requested identity/schema, atomically commit only if current. Owner of tracker/loading/retry token settles only its own token on every success, mismatch, supersession, error exit.
- Reset stream retry attempts only after valid schema frame or successful authoritative hydration, not merely after EventSource opens.
- Bounded retries apply only defined transient classes. Terminal selected-run error cancels selected-run and matching shared-stream retry families without touching newer run timers.
- Stale/reconnecting/error UI is visible, screen-reader announced, manual retry scoped to pinned identity. It never creates incident.

Race, reload, schema, terminal error tests pass with no stale commit/perpetual overlay. Stop if backend lacks replay/sequence semantics or cannot return projection for pinned run; document dependency rather than synthesizing revision locally.

## 12. Milestone 9 — Cross-worktree real control-plane E2E

### Outcome

Browser acceptance runs against actual local FastAPI + Temporal + Postgres service, not JavaScript fixture. It proves displayed Incident projection, node explanation, gates/actions, evidence references, and state transitions originate in backend endpoints and correlate to Temporal workflow IDs and Postgres/Evidence Ledger records.

### Preconditions and human gates

- Backend owner accepts v1 presentation contract and supplies test-safe authenticated tenant/subject. No test token, secret, or raw evidence is committed here.
- A human with authority starts local Compose and supplies required environment. Existing backend instructions use `FLOWPULSE_TEST_OWNER_TOKEN`; follow current backend README rather than copying credential into frontend script.
- Control-plane workflow scenario exists for incident and intended Gate 1/Gate 2/verification paths. If P0 cannot create scenario, record missing contract and stop; do not use Node replay.

### Test-first tasks

1. Create `scripts/qa/control-plane-e2e.mjs` and `test/control-plane-e2e-contract.test.mjs` only after backend scenario exists. Script fails before projection endpoint/workflow correlation available and contains no embedded incident fixture object.
2. Assert response provenance for every browser-visible transition: same-origin request URL maps to configured proxy target, response has v1 schema/identity, server log has correlated request/case/workflow fields, Temporal identifies workflow/run, Postgres/ledger returns corresponding safe evidence/action refs.
3. Add static no-mock scan for standard client modules and E2E script. It rejects imports/references to `data/incidents`, `/api/demo/`, `local-fault-loop`, and static canned success payload in normal control-plane path. It permits isolated deterministic unit fixtures outside production client modules.
4. Exercise real browser network: hydrate pinned incident; focus toast; click affected node; request Gate 1; receive backend-issued action; submit action only when backend permits; observe progress/verification or authoritative blocked state; reload and prove same identity selected.

### Expected local commands

Use backend owner's README verbatim and record exact revisions. Current expected shape:

```bash
cd /Users/danielwan/Documents/Codex/2026-07-25/flowpulse-diagnosis-control-plane-p0/repo/control_plane
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest discover -s tests -v
docker compose up --build -d

cd /Users/danielwan/Documents/Codex/2026-07-24/flowpulse-frontend-architecture-polish-v2
FLOWPULSE_PRODUCT_MODE=control-plane \
FLOWPULSE_CONTROL_PLANE_URL=http://127.0.0.1:8090 \
npm start
node scripts/qa/control-plane-e2e.mjs
npm test
```

E2E runner must not create browser-side incident. If creation is scenario setup, it calls real typed backend API through configured transport and records resulting case/workflow correlation.

### Required evidence record

For each run, write redacted evidence bundle under:

```text
outputs/qa/agent-led-incident-workspace/<UTC-run-id>/
  frontend-head.txt
  control-plane-head.txt
  commands.txt
  runtime-config.json
  browser-network.ndjson
  redacted-api-responses/
  frontend-server.log
  control-plane.log
  temporal-workflows.json
  postgres-ledger-refs.json
  screenshots/
  result.md
```

`browser-network.ndjson` records method, same-origin path, status, response schema version, identity tuple, correlation header/ID only. It contains no cookie, bearer token, raw evidence, prompt, or private payload. Redacted responses/screenshots must demonstrate network output originated in FastAPI contract, not JS object embedded in application.

Required screenshots: unavailable backend, connected Live graph, passive toast focus, node explanation streaming, Gate 1 blocked/requested, valid/invalid action, stale/reconnecting, failed verification, reload with same pinned run. Capture reduced-motion and keyboard focus evidence when visual change matters.

### Acceptance and stop

E2E fails if FastAPI/Temporal/Postgres evidence absent, response schema/identity differs, browser network omits control-plane request, or production path imports replay fixture. Stop at first missing backend contract/unavailable service; compatibility replay screenshot does not count.

## 13. Milestone 10 — complete verification, accessibility, migration, and rollout

### Outcome

Integrated workspace is safe to move from explicitly labeled compatibility mode to gated control-plane rollout. Tests cover authority, durability, tenancy, race behavior, visual interaction, accessibility, failure modes; rollout never converts demo success into product success.

### Test matrix

| Layer | Required proof |
| --- | --- |
| Unit/parser | Identity, schema, topology/edge rules, safe fields, cards, gate/action validity, stale/expired invalidation, error taxonomy, unknown enum rejection. |
| Frontend contract | Versioned request/response/SSE validation against backend-owned OpenAPI examples and negative incompatible-schema case. |
| Server transport | Missing config, backend unavailable, auth forwarding, error/status propagation, streaming framing, bounds, no demo fallback. |
| Race/reload | Same-run and cross-run stale responses, stream/hydrate races, cancellation, loading ownership, URL pinning, revision/node/edge atomicity, focus restoration, terminal retry cancellation. |
| Authority/durability | Temporal replay preserves accepted stage; action/Gate idempotency; evidence lineage persists; Critic/Verifier independent; TTL/preconditions/revocation block correctly. |
| Tenant/security | Cross-tenant case, stream, action, evidence reference, conversation rejected. Browser cannot provide role, evidence, approval, capability, prompt, tool payload, raw ID as authority. |
| Browser/a11y | Three tabs, connected-or-classified graph, reduced motion, toast/no-chat, exactly-once node explanation, fixed cards, keyboard/screen-reader, stale error, focus, English-only copy. |
| No-mock | Standard mode without backend never succeeds; source scans/E2E network prove no fixture/local replay satisfies acceptance. |
| Full regression | `npm test`, control-plane deterministic suite, approved real Compose E2E pass from fresh processes. |

### Test commands

Final command record includes exact commands and exit codes. At minimum:

```bash
node --test test/north-star-docs.test.mjs
node --test test/control-plane-contract.test.mjs
node --test test/control-plane-proxy.test.mjs
node --test test/standard-path-no-mock.test.mjs
node --test test/next-best-action-contract.test.mjs
node --test test/incident-gates.test.mjs
node --test test/incident-session-race.test.mjs
node --test test/incident-entry-browser.test.mjs
node --test test/incident-reload-browser.test.mjs
npm test
node scripts/qa/control-plane-e2e.mjs
```

Use control-plane deterministic and live Compose commands from current README at recorded backend SHA. Test failure requires scoped root-cause fix and rerun of focused test **and** `npm test`; do not weaken authority/no-mock test to advance milestone.

### Migration and rollout rules

1. Ship runtime configuration and unavailable control-plane state first; keep compatibility replay explicit/separated.
2. Add control-plane projection read path behind explicit local/dev configuration after contract readiness gate. Observe schema rejection, identity drift, stale-stream, degraded-state telemetry.
3. Add passive entry and NodeExplanation only after durable reuse and no-fresh-read-before-Gate-1 backend tests exist.
4. Add cards and Gate 1 only after backend action/gate projections have evidence/version/TTL validation.
5. Add Gate 2 and mutation actions only after dry-run, owner, Temporal Update, verification, rollback, production authorization gates are accepted. Real production mutation needs new human approval; this plan does not authorize one.
6. Keep reversible configuration switch. Disable control-plane view to unavailable state, not silent demo fallback, if contract/security regression appears.

## 14. Required records and review checkpoints

Maintain these records as implementation commits land. They are definition of done, not optional release notes.

### Contract mapping record

Create or update `docs/architecture/control-plane-incident-workspace-contract.md` during Milestone 2. It must contain:

- frontend/backend SHA, OpenAPI artifact location/hash, schema versions, final endpoint paths, auth transport decision, timeout/retry policy, exact canonical identity mapping;
- every request field browser may send, every ignored/forbidden field, strict response/event allowlists and size limits;
- NextBestAction, NodeExplanation, conversation, Gate 1, Gate 2, action, evidence, topology, verification, invalidation mappings;
- HTTP/SSE error treatment, tenant isolation, idempotency/replay behavior, compatibility/demo decision; and
- links to backend tests/proofs and unresolved ownership dependencies.

### Compatibility decision record

For each legacy Node route/module retained, record mode, visible label, whether standard mode can reach it (normally no), migration owner, deletion/retirement condition. Likely initial paths: `/api/demo/*`, `local-fault-loop`, `src/agent-control-service.mjs`, legacy Agent Team browser contract. Do not quietly reuse any as real control-plane result.

### E2E and observability record

Milestone 9 evidence bundle records frontend/backend SHAs, browser version, configuration without secrets, time window, canonical identity, endpoint paths/statuses, backend request/correlation IDs, Temporal workflow/run IDs, safe Postgres/Evidence Ledger references, screenshots, command exit codes. Product observability emits safe metrics for contract-version rejects, identity mismatches, unavailable/stale duration, action invalidations, no-mock guard failures, never prompts/raw evidence.

### Milestone review gates

| Gate | Required reviewer decision |
| --- | --- |
| R1 | Documentation describes authority and compatibility boundary correctly. |
| R2 | Control-plane owner signs v1 browser contract and auth/identity mapping. |
| R3 | Visual review compares current screen to companion 05–13 and existing FlowPulse language; deviations repaired before advancing. |
| R4 | Security/tenant review accepts transport, no-browser-secret, gate, evidence, no-mock behavior. |
| R5 | Cross-worktree E2E record correlates browser network, FastAPI logs, Temporal workflow/run, Postgres/Evidence Ledger references. |
| R6 | Final reviewer accepts full suite, accessibility/reduced-motion, race/reload, explicit compatibility labeling. |

## 15. Feedback rules and stop conditions

### Feedback rules

- **Missing backend contract:** add unresolved dependency record naming expected schema/owner/decision, leave feature unavailable, stop milestone. Do not stub product-success response.
- **Backend unavailable:** show concise accessible degraded/error state bound to pinned identity. Retain manual retry only for retryable error class; never fall back silently.
- **Visual deviation:** inspect relevant approved companion (05–13) and current product styling, capture before screenshot, repair focused layout/motion/copy, rerun visual/a11y checks.
- **Test failure:** identify scoped root cause, fix it, rerun focused test plus `npm test`, record result. Do not suppress assertion or broaden unrelated scope to make failure disappear.
- **Contract drift:** reject frame, keep last accepted projection only if staleness explicit, require versioned backend/client update.
- **Authority ambiguity:** block CTA/state and show backend reason. No browser heuristic chooses alternate gate, action, verification, stage.

### Hard stop/report conditions

Stop and report rather than implement around any of the following:

1. Approved specification contradicts published backend authority, security, tenant, or Temporal lifecycle contract.
2. Required presentation endpoint, durable NodeExplanation reuse, gate projection, action revalidation, workflow/ledger correlation is unavailable from backend owner.
3. Necessary endpoint, CORS/auth, DB migration, Temporal workflow/activity, or production tool requires authority over separately owned diagnosis worktree or external environment.
4. Normal path can only pass through mock, compatibility replay, cached browser state, or browser-generated incident/action/approval/evidence.
5. Scoped test demonstrates cross-tenant leakage, stale identity commit, failed verifier independence, gate bypass, raw evidence exposure, or mutation without current backend authorization.

## 16. Completion definition for implementation work

The later implementation is complete only when all are true:

1. README/core architecture docs identify model-agnostic company-multiplayer operating system and Incident-first vertical without weakening evidence/Temporal authority.
2. Standard mode uses real versioned FastAPI/Temporal path or visibly fails closed; compatibility/demo is explicit and cannot satisfy acceptance.
3. Live graph is connected-or-classified, backend-projected, incident-aware, motion-accessible, reached through compact three-tab navigation.
4. Toast focus is passive; affected-node click produces exactly one durable backend-correlated NodeExplanation with no pre-Gate-1 fresh read.
5. Decision workspace, fixed taxonomy, English-only copy meet approved design without persistent internal clutter.
6. Every card, gate, action, progress update, verification, stage derives from strict current canonical backend projection with evidence lineage, version, TTL, approvals/preconditions.
7. Reload/SSE/race behavior pins canonical identity, never rolls back newer projection, exposes stale/unavailable state accessibly.
8. Real E2E evidence links browser network to FastAPI, Temporal, Postgres/Evidence Ledger at recorded SHAs; proves no embedded JS fixture produced accepted result.
9. Focused tests, full `npm test`, backend tests, accessibility/reduced-motion, real browser scenarios pass from fresh processes.

This plan authorizes no product-code change by itself. Each implementation milestone remains gated by its contract, tests, evidence, and human approvals.

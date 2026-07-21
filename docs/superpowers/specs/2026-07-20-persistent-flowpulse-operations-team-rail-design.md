# Persistent FlowPulse Operations Team rail

**Status:** Owner-approved product direction. This is a design-only checkpoint and does not authorize implementation beyond the separately reviewed stages below.

**Branch context:** `codex/frontend-architecture-polish` after `9530c4bb909022df7229506110c0cb8ba8bda28b`.

**Supersession:** This document supersedes the Architecture-only Control System disclosure and the Live omission described in sections 4 and 5 of `2026-07-20-live-shared-topology-control-system-design.md`. It does not change the canonical five-control topology contract, observed 22-node runtime graph, authority model, or the fixed five-tab application menu.

## 1. Decision and bounded outcome

FlowPulse has one persistent, right-side **FlowPulse Operations Team** rail on Architecture, Live, Diagnose, Recovery Console, and Compare. It is one shared component at one fixed shell position. Switching pages does not replace, resize, recolor, or recreate the rail; only bounded server-projected page and selection context changes.

The rail exposes the existing five canonical Control System identities:

1. Observer
2. Orchestrator
3. Investigator
4. Evaluator
5. Evidence Ledger

The first four are conversational roles. Evidence Ledger is a cited immutable data/authority surface, not a simulated person and not a chatbot. A capability click activates its panel in the rail. Activating a conversational role never sends a request or spends tokens; a bounded message submission is the only conversation trigger. The rail never grants approval, triggers repair, advances a lifecycle, verifies recovery, or manufactures telemetry.

## 2. Evidence and existing capability map

| Rail identity | Existing backend evidence | Rail behavior | Never implies |
| --- | --- | --- | --- |
| Observer | `src/live-source.mjs`, `src/evidence-source.mjs`, `src/topology-projection.mjs`, and bounded source projection | Answers from bounded source health, freshness, evidence counts, and cited safe evidence references | Live production telemetry, raw logs, a root cause, or an approval |
| Orchestrator | `src/agent-control-service.mjs`, `src/agent-team-harness.mjs`, `src/runtime.mjs` | Explains ledger-derived stage, dispatch, stopping condition, and human-gate state | Owner consent, execution, or autonomous stage advancement |
| Investigator | `src/development-runtime.mjs`, `src/agent-team-harness.mjs`, `src/incident-projection.mjs` | Explains cited evidence, current hypothesis/replan state, and investigation limits | A diagnosis that the canonical projection has not accepted, repair authority, or raw model reasoning |
| Evaluator | `src/autonomy-policy.mjs`, `src/agent-team-harness.mjs`, current `critic` collaborator | Explains bounded causal/evaluation result, evidence sufficiency, and rejection reason category | Human approval, repair authorization, or invented confidence |
| Evidence Ledger | `src/ledger.mjs`, `src/server.mjs`, `IncidentProjection v1` | Shows safe event count/latest sequence, integrity state, citations, and provenance/hash navigation | A human-like response, mutable history, receipt issuance, or authority from UI state |

`src/topology-projection.mjs` already owns the five visible identities. `src/agent-control-service.mjs` has a different internal collaborator vocabulary: `commander`, `observer`, `investigator`, `critic`, `recovery-engineer`, and `verifier`. The rail keeps the topology identities and server maps them deterministically:

| Rail recipient | Internal collaborator | Mapping rule |
| --- | --- | --- |
| `observer` | `observer` | Exact existing role |
| `orchestrator` | `commander` | The current ledger-governed manager/orchestration interface |
| `investigator` | `investigator` | Exact existing role |
| `evaluator` | `critic` | Existing adversarial evaluator collaborator |
| `ledger` | none | Read-only evidence/event inspector, no chat submission |

Planner, Executor, Owner Gate, Verification, Evolve, Test, and Langfuse remain workflow or observability detail. They are not extra rail personas.

## 3. Shared rail information model

### 3.1 Fixed compact state

The persistent rail is visible at the same right-side shell location on every primary tab. It has five compact capability tiles:

- semantic icon;
- concise canonical name;
- one server-projected status dot with accessible text;
- no role paragraphs, count badges, fake activity, hidden status inference, or page-specific visual variants.

The application header and five-tab menu remain one fixed, shared component. Page changes do not move either the menu or rail. The rail uses the same approved rounded, low-border, 2D Architecture material; it never becomes a separate dark chat product or a floating second navigation system.

### 3.2 Activated conversational role

Clicking, Enter, or Space on Observer, Orchestrator, Investigator, or Evaluator opens that role's panel **inside the same rail bounds**. It contains:

- icon, canonical role name, and a one-line server-owned responsibility;
- a short explanation of its bounded input/evidence scope;
- attributed conversation history for the current validated run;
- safe citation chips and handoff records when present;
- a bounded text field and explicit send button;
- truthful loading, unavailable, stale, stopped, error, and `owner_gate_required` states.

The input starts empty. Selecting a page or component may show a non-submitting context chip such as `Selected: checkout`; it must not insert a fabricated question, auto-send text, initiate a model call, or change the server run. Escape closes the panel and restores focus to the activating tile. Repeating activation on the same role closes it. Selecting a different role swaps only the panel content and retains the rail bounds.

The Evidence Ledger tile opens a read-only panel with latest safe sequence, integrity/availability result, cited evidence IDs, and provenance/hash links. It has no message input, no “activate agent” wording, and no control that mutates ledger state.

### 3.3 Page and selection context

The rail conversation identity is bound to the canonical server tuple:

```text
run_id + incident_id + topology projection_revision + latest ledger sequence
```

The active page (`architecture`, `live`, `diagnose`, `recovery`, or `compare`) and optional selected observed node ID are presentation context. They travel only as constrained request hints and never create incident, risk, approval, execution, verification, readiness, or source truth.

On page change the rail remains open when the new page has the same valid tuple. If the tuple changes, the previous conversation is labelled as belonging to its prior run/revision and the active panel returns to compact state until the server validates the new context. A stale or unavailable projection disables message submission and explains why without fallback to compatibility `source.topology`.

## 4. Safe conversation contract

The existing mutable `/api/agent-control/message` may interpret a task-delegation intent. The rail must not call it directly. A future server-owned rail endpoint uses a separate exact envelope:

```json
{
  "schema_version": "flowpulse.agent-rail-query.v1",
  "expected_run_id": "bounded-id",
  "expected_incident_id": "bounded-id",
  "expected_projection_revision": "sha256-hex",
  "page": "architecture|live|diagnose|recovery|compare",
  "selected_node_id": "optional canonical observed node ID",
  "recipient": "observer|orchestrator|investigator|evaluator",
  "message": "bounded UTF-8 text",
  "client_query_id": "bounded idempotency ID"
}
```

The server, not the browser, resolves current run, incident, recipient mapping, selected node membership, truth axes, stage, citation set, and response. Exact-key validation, enum validation, UTF-8/length limits, idempotency, and a per-run query budget are mandatory. Mismatched run, incident, revision, stale context, invalid node, unknown recipient, duplicate ID, oversized body, or unsupported page fails closed before any event append or model/provider call.

The response is bounded and contains only:

```text
original recipient, final responder, response category, safe text,
ordered citation IDs/hashes, source truth, canonical sequence/timestamp when available,
handoff chain, and non-authoritative availability/gate state.
```

It excludes raw logs, trace payloads, SQL, prompts, tokens, credentials, raw provider output, model chain-of-thought, mutable policy, repair target, approval issuance, and action controls. Competition MVP replies are deterministic from existing bounded projections and safe evidence references. GPT/OpenAI investigation remains behind its existing explicit, frozen-source, owner-reviewed path; a rail click or query never invokes it.

If durable cross-page history is required, server appends only typed, explicitly non-authoritative query/response audit events. These events cannot strengthen decision, owner gate, execution, verification, promotion, lock, or lifecycle state.

## 5. Transparent routing and attribution

Routing is deterministic, server-owned, and visible. A reply always shows:

```text
original recipient → routing reason → delegated role → evidence/tool scope → final responder
```

Allowed routes are narrowly defined:

| Start | Trigger | Final responder | Visible reason |
| --- | --- | --- | --- |
| Observer | User requests causal proof/hypothesis | Investigator | `causal-hypothesis-required` |
| Investigator | User requests adversarial sufficiency check | Evaluator | `adversarial-check-required` |
| Evaluator | User requests freshness/connectivity fact | Observer | `source-truth-required` |
| Any role | User asks to approve, execute, verify, or bypass a gate | none | `owner_gate_required` or `action_not_available` |

There is no hidden impersonation and no LLM-selected routing/tool expansion. The browser cannot label a response as an agent result without the server's final-responder field.

## 6. Security, authority, privacy, and cost boundary

| Boundary | Rule |
| --- | --- |
| Browser | May select a visible role, page, node, and bounded message. It never supplies status, severity, evidence, gate, repair, source payload, approval, execution, or verification truth. |
| Server and append-only ledger | Own run identity, conversation audit, canonical projection, role mapping, evidence citations, source truth, gates, and all consequential actions. |
| Rail query | Is explanation/investigation only. It cannot call provider tools, mutate a run, issue a receipt, or execute a remediation. |
| Evidence | Uses existing redacted browser-safe projections and `/api/evidence` safe details only. Raw logs/traces/SQL/provider payloads never enter the rail. |
| SSE | Streams read-only, ledger-derived state. It cannot carry a command or imply a completed action before the canonical projection says so. |
| Langfuse | Remains optional asynchronous observation. Its availability cannot gate or advance a rail conversation. |
| Cost | No paid GPT invocation from component selection, role activation, or MVP rail query. Bounded deterministic replies, server rate limits, and idempotency prevent accidental token amplification. |

## 7. Accessibility, motion, and responsive behavior

- Every tile, panel close action, citation link, and message input is keyboard reachable with visible focus.
- Tile role, status, conversation availability, citations, routing, final responder, and source truth have text equivalents for assistive technology.
- Focus moves into an activated panel and returns to its activating tile on close or Escape.
- New messages announce through a bounded polite live region; streaming/pending state has a text equivalent.
- At 1440x900 and 1280x800 the rail remains readable without covering the page's critical canvas. A narrow viewport uses the same rail as an overlay from the fixed right edge; it does not turn into a new route or duplicate component tree.
- Reduced motion removes panel slide/FLIP movement but preserves activation, focus, and state. Reduced transparency uses opaque light surfaces while retaining hierarchy.

## 8. Failure and lifecycle states

| State | Rail behavior |
| --- | --- |
| Loading | Compact tiles remain visible; conversation panel reports loading without guessing a status. |
| Healthy/captured | Displays only actual server truth and safe current activity when present. Captured/demo remains labelled captured/demo, never live. |
| Stale/disconnected/unavailable | Status and source truth are explicit; message send is disabled if context cannot be server-validated. |
| No incident | Observer/Orchestrator may explain current availability; Investigator/Evaluator cannot fabricate an active investigation. |
| Incident | The same role identities remain; only canonical projected stage/evidence/gate facts may appear. |
| Owner gate | Responses explain the gate and link safe citations; no approval action appears in the rail. |
| Recovery/compare | Rail uses the current run/revision tuple and must not report verification before the canonical projection does. |

## 9. Staged implementation plan and review gates

Each stage is an isolated commit and stops for owner review. No stage auto-advances.

### A. Server-owned rail query contract

Add exact request/response validation, topology-to-collaborator mapping, deterministic safe answer categories, redaction/caps, idempotency, budget, and non-authoritative audit records. Test malformed context, bad recipient/node/revision, duplicate query, approval/repair prompt, raw marker leakage, and no provider/model invocation. Stop for contract review.

### B. Shared persistent rail shell

Add one shared frontend rail host to the fixed five-tab shell. Render the exact five canonical identities from valid topology views, compact state, Ledger inspector, and local activation/focus behavior. No message submit yet. Test every page reuses the same host and menu geometry, rail contains five identities, Ledger has no chat input, and unavailable topology fails closed. Stop for visual review.

### C. Bounded rail conversation and SSE

Connect only the new query endpoint and ledger-derived SSE. Render server attribution, citations, handoffs, errors, stale state, and capped history. Test page/node context, focus restoration, no browser-created facts, no action endpoint use, and run/revision reset behavior. Stop for security/interaction review.

### D. Contextual Diagnose entry

Enable a contextual “investigate selected incident component” prompt only when the server confirms the selected observed node is part of the incident overlay and Diagnose is ready. This stage still cannot call GPT directly, approve, repair, execute, or verify. Stop for owner review.

### E. Optional GPT augmentation

Only after a separate owner-approved cost, privacy, and frozen-source design. It is not part of the competition MVP or this rail contract.

## 10. Acceptance and test checklist

1. Exactly one fixed five-tab menu and one persistent rail host across all five pages.
2. Exactly five canonical rail identities; Deployment is absent and Evidence Ledger never acts conversationally.
3. Default tiles show only icon, name, server status dot, and accessible state.
4. Activation is local and non-mutating; it never sends or spends on click.
5. Server rejects mismatched run/incident/revision, bad recipient/node/page, duplicate/oversized query, and any browser-supplied authority fact before side effects.
6. Every response is attributed, bounded, cited, and honest about source truth; handoffs are explicit.
7. Approval, execution, verification, and lifecycle remain server/ledger-owned and cannot be advanced through rail messages.
8. No raw logs, trace bodies, SQL, prompts, tokens, secrets, or provider payloads reach the browser.
9. Browser console/network is clean; focused contract/server/frontend tests, full suite, audit, and visual checks pass before each stage's owner gate.
10. The rail is readable at 1440x900 and 1280x800, works by keyboard, honors reduced motion/transparency, and leaves the Architecture/Live canvas usable.

## 11. Non-goals

- Replacing the append-only ledger, IncidentProjection, AgentTeamHarness, owner gate, or current GPT investigation pathway.
- Adding a generic LLM chat product, vendor SDK, paid model call, arbitrary tool execution, or new external service.
- Making Evidence Ledger a person-like agent.
- Redesigning the five-tab menu, Architecture macro layers, Live topology routing, Diagnose, Recovery Console, or Compare while implementing the rail contract.
- Claiming production-live telemetry from captured, frozen, demo, unavailable, or stale sources.

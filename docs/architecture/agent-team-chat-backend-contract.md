# FlowPulse Agent Team chat backend contract

## Compatibility status

This document describes the legacy Node Agent Team **compatibility/demo** contract. It remains a bounded conversation reference until the real FastAPI/Temporal control-plane equivalent publishes the stable Conversation Manager, durable NodeExplanation, current evidence lineage, NextBestAction, human-gate, action, and event-stream contracts. It does not grant lifecycle authority, incident authority, tenant authorization, approval, action, or verification authority.

## Scope and ownership

This contract supports the persistent, backend-driven Agent Team sidebar. It adds no browser authority and does not authorize frontend implementation, repair execution, approval, verification, or truth mutation.

The conversation is an ordered projection of append-only ledger records. The browser consumes the returned conversation projection or the scoped SSE projection; it must not read raw ledger rows or infer hidden routing.

| Conversational role | `requested_agent` | Sidebar capability line | Read-only tools |
| --- | --- | --- | --- |
| Observer | `observer` | Source connection/freshness and bounded current signals. | `read_source_freshness`, `read_signal_summaries` |
| Orchestrator | `orchestrator` | Workflow/architecture explanation and transparent routing. | `read_workflow_projection` |
| Investigator | `investigator` | Selected-component evidence, cited hypotheses, and bounded replanning. | `read_evidence_summaries`, `read_selected_component` |
| Evaluator | `evaluator` | Adversarial causal/evidence-quality check; never owner approval. | `read_cited_hypotheses`, `read_evidence_summaries` |

`ledger` is intentionally not an accepted `requested_agent`. A message about the Evidence Ledger is handed off transparently to Observer (or Evaluator for a verdict/challenge request). The UI owns static icon/name mapping for these four stable role IDs.

Provider truth labels remain independent of authority: `LOCAL CODEX`, `OPENAI API`, and `RECORDED/DEMO` identify a provider path, not an incident lifecycle decision, gate, current-proof claim, or action receipt.

## N1 Node Investigation extension

When `selected_component` is present, the chat service uses the server-owned Node Investigation Plane described in [node-investigation-plane-frontend-contract.md](node-investigation-plane-frontend-contract.md). The browser still sends the same request envelope only. The server may record `tool_request` and `tool_result` conversation events before a response; each exposes a role-allowlisted tool name, component ID, count-only activity, same-attempt citations, source truth, cache state, and `raw_payload_excluded: true`.

Provider output now has a strict nullable `recommended_handoff` and a strict required `tool_requests` array. Each request has only `{ tool, cursor, limit, signal }`, with null for unused controls. The model cannot set a component, run, window, URL, arbitrary query, authority, repair, or tool result. N1 permits at most two tool rounds, four calls total, and two calls per tool; a budget or source gap ends visibly blocked/needs-human rather than looping.

## Provider configuration and truthful labels

Set `FLOWPULSE_AGENT_PROVIDER` explicitly. Provider selection never infers a mode from credentials.

| Setting | Demo/deployment use | Sidebar label | Prerequisite |
| --- | --- | --- | --- |
| `codex-local` | Local competition demo | `LOCAL CODEX` | Codex CLI installed and logged in through its normal local authentication flow. |
| `openai-responses` | Reserved deployment adapter | `OPENAI API` | `OPENAI_API_KEY` and deployment project configuration. |
| `recorded` | Deterministic test/judge/demo fallback | `RECORDED/DEMO` | None. |

The default with no setting is `recorded`, so judge replay never needs an API key. `codex-local` never silently falls back to recorded text: an unavailable, unauthenticated, timed-out, nonzero, oversized, or schema-invalid Codex invocation returns a safe failed response with the provider capability still labeled `LOCAL CODEX` and unavailable. Use `recorded` explicitly when a recorded fallback is desired.

Read the safe capability projection without triggering a model:

```text
GET /api/agent-control/provider
```

It returns only:

```json
{
  "provider_kind": "codex-local",
  "availability": "available",
  "truth_label": "LOCAL CODEX",
  "model_label": "Codex CLI",
  "failure_reason": null
}
```

The same object is available as `agent_team_provider` in `/api/agent-control` and `/api/state`'s `agent_control` projection. It is server-owned; provider output cannot set or forge these labels.

For `codex-local`, FlowPulse invokes `codex exec` once per explicit non-idempotent message with an ephemeral session, strict JSON output schema, output/event caps, hard timeout, read-only sandbox, approvals disabled, web search disabled, and an empty temporary working directory outside this repository. FlowPulse sends the complete bounded context on each invocation and keeps the Ledger—not a hidden Codex thread—as conversation truth. It does not read, copy, log, commit, or pass through Codex auth files or tokens; normal Codex CLI authentication remains entirely inside the CLI.

The strict provider result is always an object with both `answer` and `recommended_handoff`. `recommended_handoff` is either `null` or a `{ "to", "reason" }` recommendation for one of the four role IDs. FlowPulse validates it before recording any handoff; provider stderr, JSONL events, schema diagnostics, and output payloads are never exposed to the browser. Internal adapter diagnostics use only fixed classifications such as `codex_exec/nonzero` or `codex_response/provider_output_schema_invalid`.

## Submit a message

`POST /api/agent-control/chat` accepts `application/json` and rejects every unknown field. It is the only operation that can invoke a model adapter. Opening a role, loading a conversation, switching page, selecting a component, and SSE reads never invoke a model.

```json
{
  "run_id": "run-01J...",
  "incident_id": "incident-checkout-payment",
  "conversation_id": "conv-architecture-control-01",
  "idempotency_key": "chat-0001",
  "requested_agent": "investigator",
  "page_mode": "architecture",
  "selected_component": "checkout",
  "message": "What bounded evidence is relevant to checkout?"
}
```

Rules:

- `run_id` and `incident_id` must match the server's canonical run/incident.
- `conversation_id` and `idempotency_key` are stable safe identifiers; a repeated key with the same request returns the already-recorded result, and a different request fails with `idempotency_key_conflict`.
- `page_mode` is one of `architecture`, `live`, `diagnose`, `recovery`, `compare`, or `manager`.
- `selected_component` is `null` or an exact canonical runtime node from the current topology view. The server rejects browser-invented nodes.
- `message` is required and capped at 1,500 UTF-8 bytes. The service redacts secret-shaped values before recording or projecting them.
- Fields such as authority/truth/approval/repair/evidence/verification/provider payloads are not accepted in the request envelope; they fail as `forbidden_request_field` or `unknown_request_field`.
- A human gate is reserved for a command to approve, grant, apply, execute, run, bypass, or mutate protected state. Read questions such as “is approval granted?”, “do not claim approval”, and “explain the owner gate” remain ordinary read-only chat requests.

### Bounded context selected at submit time

Each explicit message re-reads the canonical run and the selected evidence source; changing a page or node without submitting remains model-free. In replay, the source status is truthfully `captured` and the topology revision/node set stays bound to the current `topology-views.v2` projection. FlowPulse uses the existing evidence-source and component-detail projections, never raw rows, to assemble this role-specific context:

| Responding role | Bounded context supplied to the provider |
| --- | --- |
| Observer | Captured/live source status and freshness plus cited signal summaries. |
| Orchestrator | Current incident workflow stage, status, and canonical human-gate state. |
| Investigator | Cited evidence summaries and the selected canonical component detail when one was supplied. |
| Evaluator | Canonically recorded hypotheses/verdict references when available, plus cited evidence summaries. |

Evidence is capped at 12 references, selected-component detail uses its existing cap of eight source records, and the total provider context is capped at 24 KiB. The response projection exposes only citation IDs and count-only tool activity; it does not expose source facts, raw telemetry/logs/traces, or component-detail payloads.

Success returns a final (or safely failed) chat state plus the entire bounded conversation projection:

```json
{
  "schema_version": "flowpulse.agent-team-chat.v1",
  "conversation_id": "conv-architecture-control-01",
  "message_id": "msg-...",
  "idempotent": false,
  "requested_agent": "investigator",
  "responding_agent": "investigator",
  "state": "completed",
  "answer": "Investigator: I can inspect the bounded evidence references for checkout...",
  "handoff": null,
  "citations": ["ev-trace-payment-refused"],
  "tool_summaries": [
    { "tool": "read_evidence_summaries", "result_count": 1, "raw_payload_excluded": true },
    { "tool": "read_selected_component", "result_count": 1, "raw_payload_excluded": true }
  ],
  "human_gate": { "status": "not_required" },
  "provider": {
    "provider_kind": "recorded",
    "availability": "available",
    "truth_label": "RECORDED/DEMO",
    "model_label": "recorded-agent-team-v1",
    "failure_reason": null
  },
  "ledger": { "sequence": 42, "recorded_at": "2026-07-20T18:12:00.000Z" },
  "conversation": { "schema_version": "flowpulse.agent-team-chat.v1", "messages": [] }
}
```

`state` is one of `routing`, `working`, `completed`, `blocked`, `needs_human`, or `failed`; this MVP emits `working`, `completed`, `needs_human`, and `failed` as applicable. The ordered event projection supplies the intermediate `routing` record.

### Transparent handoff example

When the clicked role is Observer but the request asks for causal investigation, the response remains explicit:

```json
{
  "requested_agent": "observer",
  "responding_agent": "investigator",
  "state": "completed",
  "handoff": {
    "from": "observer",
    "to": "investigator",
    "reason": "Causal investigation belongs to Investigator."
  }
}
```

A provider may also return one schema-validated handoff recommendation. FlowPulse validates it, appends a second ordered `handoff` event, and retains the original responding role on that response; it does not make a second model call or impersonate the recommended role. The sidebar should render every ordered handoff event rather than infer a role switch from text.

### Human-gate example

Approval, repair execution, fabricated verification, and truth mutation requests never reach a provider adapter and never append an authority event:

```json
{
  "requested_agent": "investigator",
  "responding_agent": "investigator",
  "state": "needs_human",
  "answer": "Agent Team chat cannot approve or execute repairs...",
  "human_gate": { "status": "requested" }
}
```

### Error examples

| HTTP status | Body | Meaning |
| --- | --- | --- |
| 400 | `{ "error": "forbidden_request_field" }` | Caller supplied a prohibited authority/truth/repair-style field. |
| 409 | `{ "error": "canonical_identity_mismatch" }` | Run or incident differs from current backend truth. |
| 409 | `{ "error": "idempotency_key_conflict" }` | Reused key contains different request content. |
| 422 | `{ "error": "selected_component_not_canonical" }` | Selected node is absent from canonical topology. |
| 429 | `{ "error": "conversation_record_budget_exhausted" }` | The bounded conversation reached its record cap. |

A configured provider failure is a safe `200` response with `state: "failed"`; it records a generic `model_unavailable` event, never provider payload/error text.

## Read and stream the persistent sidebar

Load a persisted conversation without a model call:

```text
GET /api/agent-control/conversation?conversation_id=conv-architecture-control-01
```

Subscribe after the latest known ledger sequence:

```text
GET /api/agent-control/events?conversation_id=conv-architecture-control-01&after=42
Last-Event-ID: 42
```

With `conversation_id`, every `agent-control` SSE frame is:

```json
{
  "agent_control": { "schema_version": "flowpulse.agent_control.v1" },
  "conversation": {
    "schema_version": "flowpulse.agent-team-chat.v1",
    "conversation_id": "conv-architecture-control-01",
    "messages": [
      { "kind": "user", "requested_agent": "observer", "page_mode": "live", "selected_component": "checkout" },
      { "kind": "handoff", "from": "observer", "to": "investigator", "reason": "Causal investigation belongs to Investigator." },
      { "kind": "context", "state": "routing", "topology": { "projection_revision": "..." }, "source_truth": { "source_health": "live" }, "citations": ["ev-trace-payment-refused"] },
      { "kind": "tool_summary", "state": "working", "agent": "investigator", "tools": [{ "tool": "read_evidence_summaries", "result_count": 1, "raw_payload_excluded": true }] },
      { "kind": "working", "requested_agent": "observer", "responding_agent": "investigator", "state": "working" },
      { "kind": "assistant", "responding_agent": "investigator", "state": "completed", "citations": ["ev-trace-payment-refused"] }
    ]
  }
}
```

The event projection is bounded to 48 records and 64 KiB. It exposes only safe text, role IDs, routing state, context revision/truth axes, evidence IDs, count-only tool summaries, generic failure codes, safe provider capability labels, and ledger sequence/time. It never exposes raw prompts, chain of thought, raw logs/traces, provider payloads, credentials, or hidden routing.

## Canonical run topology contract (P0.5)

`GET /api/demo/agent-loop?run_id=…` and every `local-fault-loop` SSE event now carry the same bounded `topology` projection once the run binds its backend topology. It is the only graph membership/identity/status source for a real shared run. Live, Diagnose, Recovery Console, Compare, node detail reads, and Agent Team submit context must use its `run_id`, `incident_id`, and `projection_revision`; they must not fall back to the legacy six-node fixture frames.

```json
{
  "schema_version": "flowpulse.canonical-run-topology.v1",
  "run_id": "local-loop-checkout-payment-config-1-…",
  "incident_id": "incident-local-checkout-payment-config-1-…",
  "projection_revision": "<sha256>",
  "graph": { "nodes": ["<22 safe nodes>"], "edges": ["<26 safe edges>"], "total_nodes": 22, "total_edges": 26, "truncated": false },
  "node_ids": ["accounting", "…", "fraud-detection"],
  "edge_ids": ["ad->flagd", "…"],
  "affected_node_ids": ["accounting", "checkout", "fraud-detection", "kafka", "payment"],
  "affected_edge_ids": ["checkout->payment"],
  "current": {
    "sequence": 31,
    "stage": "recovered",
    "state": "recovered",
    "node_statuses": { "checkout": "verified" },
    "edge_statuses": { "checkout->payment": "verified" },
    "metric_sample": { "checkout_error_rate_percent": 0.8, "payment_reachability_percent": 99.98, "kafka_lag": 620, "phase": "verified", "source": "isolated_fixture", "recorded_at": "2026-07-21T…Z" }
  },
  "verification": { "state": "passed", "passed": true, "event_sequence": 30, "snapshot": { "name": "verified" } },
  "live": { "run_id": "…", "incident_id": "…", "projection_revision": "<sha256>", "node_ids": ["same list"], "edge_ids": ["same list"], "state": "current" },
  "diagnose": { "state": "current" },
  "recovery": { "state": "current" },
  "compare": { "state": "verified" },
  "raw_payload_excluded": true
}
```

The graph is canonicalized at the contract boundary: `fraud` is never emitted or accepted as a graph component ID; the only identity is `fraud-detection`. `affected_*` values are subsets of the canonical IDs. The backend, not the browser, derives stage/status maps, metric samples, verification snapshots, and the Compare gate from immutable run events.

While an asynchronous start is only reserved, `topology` can be `null`; the browser must render a topology-binding state and keep the SSE connection open. It must never substitute a static topology. A terminal or topology-bound projection always carries the full object above.

`compare.state` is `verified` only if the same run has `verification.passed: true` and a terminal recovered state. For `needs_human`, failed, or still-running runs it is `verification_pending`, `verification.passed` is false, and Compare must show pending rather than a green recovered comparison.

For a component drawer read during a local fault-loop run, use the same `run_id`:

```text
GET /api/components/checkout?run_id=local-loop-checkout-payment-config-1-…&window=15m&signal=all&limit=8
```

The server binds the response's `topology_projection_revision` to this canonical run revision, so the client must reject an otherwise valid detail response with a different revision. Agent Chat submits likewise carry the selected canonical component and same run/incident identity; opening or selecting does not call a provider.

### Usable sidebar submit binding

Every explicit Agent Team submit for a bound run must include the exact current `projection_revision` as well as `run_id`, `incident_id`, `page_mode`, selected canonical component, requested role, message, conversation ID, and idempotency key. A missing, malformed, or stale revision is rejected with `409 { "error": "projection_revision_mismatch" }`; the browser must refresh the canonical run projection rather than sending a request with mixed-run context. The safe response projection repeats the validated revision so a sidebar can discard a late response from an older run.

The one-port UI exposes stable semantic selectors for recording and browser checks: `data-testid="simulate-incident"`, `agent-chatbox`, `agent-chat-input`, `agent-chat-send`, `live-topology`, `diagnose-topology`, `recovery-topology`, `compare-topology`, and the backend-driven `verification-passed`. Recovery's `recovery-topology` contains the same canonical `data-node-ids` and `data-edge-ids` graph as the other real-run workspaces; its node/edge status classes come only from the current backend event projection. A chat form has one visible textarea and one visible Send control per active workspace. Enter submits, Shift+Enter keeps a multiline draft, and an in-flight request shows `aria-busy="true"` plus a visible working status. Draft text survives an SSE re-render; a provider failure returns a bounded visible error, preserves the draft, and re-enables the form. The form remains available during a running loop for read-only diagnostic questions. These are UI bindings only: backend routing, citations, tool counts, authority, and recovery truth stay server-owned.

## Sidebar integration sequence (future frontend work)

1. Render the four stable Control System roles with static icon/name/capability copy.
2. Selecting a role only changes local sidebar state. It may load the conversation projection and subscribe to scoped SSE; neither operation calls a model.
3. On each explicit submit, include the then-current `page_mode` and canonical selected node (or `null`), plus a new idempotency key.
4. Render projection messages in sequence. Show `handoff` as from/to/reason rather than silently replacing the selected role. Use `working` before the final assistant message, then citations and bounded tool summaries.
5. Preserve one `conversation_id` across Architecture, Live, Diagnose, Recovery, and Compare. The historical message retains its original page/node context; each new explicit message records the new context.
6. Treat `needs_human` and `failed` as terminal UI states for that message. Do not render an approval or repair control from chat output.

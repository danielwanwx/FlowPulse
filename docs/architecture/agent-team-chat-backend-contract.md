# FlowPulse Agent Team chat backend contract

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

## Sidebar integration sequence (future frontend work)

1. Render the four stable Control System roles with static icon/name/capability copy.
2. Selecting a role only changes local sidebar state. It may load the conversation projection and subscribe to scoped SSE; neither operation calls a model.
3. On each explicit submit, include the then-current `page_mode` and canonical selected node (or `null`), plus a new idempotency key.
4. Render projection messages in sequence. Show `handoff` as from/to/reason rather than silently replacing the selected role. Use `working` before the final assistant message, then citations and bounded tool summaries.
5. Preserve one `conversation_id` across Architecture, Live, Diagnose, Recovery, and Compare. The historical message retains its original page/node context; each new explicit message records the new context.
6. Treat `needs_human` and `failed` as terminal UI states for that message. Do not render an approval or repair control from chat output.

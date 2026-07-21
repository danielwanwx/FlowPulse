# Node Investigation Plane frontend contract

**Backend phase:** N1
**Read model schema:** `flowpulse.node-investigation.v1`
**Compatibility:** `GET /api/components/:id` continues to return its existing `flowpulse.component-detail.v1` top-level fields. The additive `node_investigation` field is the versioned N1 projection.

The component drawer and Agent Team use the same canonical component ID, topology revision, source truth, evidence IDs, and record hashes. A selection or read does not invoke a model.

## Snapshot request

```http
GET /api/components/checkout?run_id=run-...&window=15m&signal=all&limit=8
```

Only these query parameters are accepted:

| Parameter | Allowed values |
| --- | --- |
| `run_id` | a known canonical FlowPulse run ID; defaults to the current browser run |
| `window` | `5m`, `15m`, `1h`; default `15m` |
| `signal` | `all`, `metric`, `log`, `trace`, `change`, `resource`; default `all` |
| `cursor` | an opaque prior `next_cursor` |
| `limit` | integer `1`–`12`; default `8` |

Unknown, duplicate, malformed, cross-run, non-canonical component, or out-of-cap values fail closed. `raw_payload_excluded` is always `true`.

```json
{
  "schema_version": "flowpulse.component-detail.v1",
  "component": { "id": "checkout", "label": "Checkout", "kind": "service" },
  "observability": {
    "metrics": [{ "evidence_id": "ev-metric-checkout-errors", "before": 0.7, "after": 38.4, "unit": "percent", "record_sha256": "…" }],
    "traces": [{ "evidence_id": "ev-trace-payment-refused", "peer_target": "payment:9090", "error": "ECONNREFUSED", "record_sha256": "…" }],
    "logs": [{ "evidence_id": "ev-log-endpoint-fallback", "summary": "checkout logged configuration missing using fallback payment:9090", "record_sha256": "…" }],
    "changes": [{ "evidence_id": "ev-deploy-checkout", "before": "checkout:2.17.3", "after": "checkout:2.18.0", "record_sha256": "…" }]
  },
  "data_resources": [],
  "raw_payload_excluded": true,
  "node_investigation": {
    "schema_version": "flowpulse.node-investigation.v1",
    "topology_projection_revision": "…",
    "health": { "status": "incident", "severity": "SEV-2", "incident_id": "inc-astro-checkout-001" },
    "source_truth": {
      "mode": "deterministic_replay",
      "status": "captured",
      "truth_label": "captured_replay",
      "freshness_ms": null,
      "observed_at": null
    },
    "relationships": { "upstream": [], "downstream": [] },
    "evidence": {
      "items": [{ "id": "ev-trace-payment-refused", "record_sha256": "…", "raw_payload_excluded": true }],
      "next_cursor": null,
      "selected_count": 1,
      "omitted_count": 0,
      "truncated": false
    },
    "window": { "value": "15m", "applied": false },
    "raw_payload_excluded": true
  }
}
```

`data_resources` is empty unless a source record explicitly carries a supported, provenanced `topic`, `consumer_group`, `database`, `table`, `job`, or `dag`. Empty never means a resource was inferred absent.

## Incremental evidence SSE

```http
GET /api/components/checkout/events?run_id=run-...&window=15m&limit=8&after=0
Last-Event-ID: 0
```

`after` and `Last-Event-ID` are exclusive sequence checkpoints. The server replays events whose ID is strictly greater than the checkpoint, so reconnects do not duplicate delivered records.

```text
id: 1
event: node-evidence-snapshot
data: {"run_id":"run-...","component_id":"checkout","detail_revision":"…","source_truth":{"truth_label":"captured_replay"},"snapshot":{"evidence":{"items":[]}}}

id: 2
event: node-evidence-change
data: {"run_id":"run-...","component_id":"checkout","evidence":{"id":"ev-deploy-checkout","record_sha256":"…","raw_payload_excluded":true}}

: heartbeat

id: 6
event: node-evidence-state
data: {"run_id":"run-...","component_id":"checkout","state":"captured_replay","terminal":true,"raw_payload_excluded":true}
```

Event names are `node-evidence-snapshot`, `node-evidence-metric`, `node-evidence-log`, `node-evidence-trace`, `node-evidence-change`, `node-evidence-resource`, `node-evidence-record`, and `node-evidence-state`. Captured replay is finite and terminal. A real live source keeps the stream open, emits only newly observed safe records, and sends heartbeats. `stale`, `disconnected`, and `unavailable` are terminal source states; the drawer must show the gap instead of presenting it as live.

## Agent Team integration

On an explicit chat submit, send the unchanged strict Agent Team envelope with the currently selected canonical component and current page mode. Do not send evidence, authority, repair, truth, approval, prompt, or tool fields from the browser.

```json
{
  "run_id": "run-...",
  "incident_id": "inc-astro-checkout-001",
  "conversation_id": "conv-checkout-001",
  "idempotency_key": "sidebar-message-001",
  "requested_agent": "investigator",
  "page_mode": "diagnose",
  "selected_component": "checkout",
  "message": "Why is checkout red? Use bounded evidence."
}
```

N1 role allowlists are server-owned:

| Role | Allowed N1 tools |
| --- | --- |
| Observer | snapshot, metrics, logs |
| Orchestrator | workflow projection only; may hand off |
| Investigator | all seven N1 tools |
| Evaluator | snapshot, metrics, traces, dependencies, recent changes |

The server seeds a selected component snapshot, then can perform at most two model-requested tool rounds, four calls total, and two calls per tool. The model cannot choose a component, run, URL, shell command, SQL, authority, repair, or arbitrary tool name. Repeated fingerprints are returned as cached lineage.

Agent conversation/SSE projections expose these incremental records:

```json
{
  "kind": "tool_result",
  "state": "working",
  "agent": "investigator",
  "tool": "query_component_traces",
  "component_id": "checkout",
  "result_count": 1,
  "selected_count": 1,
  "omitted_count": 0,
  "cached": false,
  "citations": ["ev-trace-payment-refused"],
  "source_truth": { "status": "captured", "truth_label": "captured_replay" },
  "raw_payload_excluded": true
}
```

The final assistant event has `safe_answer`, requested/responding role, transparent handoff, citations, count-only tool summaries, provider truth label, and human-gate state. Citations are constrained to evidence returned by tool results in that same message attempt. The drawer can safely open an evidence detail by its ID through the existing bounded evidence read endpoint; it must not reconstruct routing from text or poll raw ledger rows.

## Errors and availability

| Error/state | Frontend treatment |
| --- | --- |
| `node_evidence_run_unavailable` | keep current drawer state; report unavailable run |
| `component_detail_unavailable` | clear unsafe selection; do not invent a node |
| `node_evidence_window_invalid`, `node_evidence_limit_invalid`, `node_evidence_cursor_invalid` | client request error; use an allowed control value |
| `node_source_stale`, `node_source_disconnected`, `node_source_unavailable` | show evidence gap; Agent ends blocked/needs-human; no repair |
| `node_tool_budget_exhausted`, `node_tool_request_invalid` | show bounded investigation stop; no retry loop |
| provider failure | show failed provider state; never label recorded text as local Codex or OpenAI API |

Source truth labels are exact: `captured_replay`, `frozen_snapshot`, `live`, `stale`, `disconnected`, and `unavailable`. Provider labels remain independent: `LOCAL CODEX`, `OPENAI API`, or `RECORDED/DEMO`.

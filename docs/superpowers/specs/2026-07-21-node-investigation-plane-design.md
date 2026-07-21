# FlowPulse Node Investigation Plane — Backend Phase N1

**Status:** owner approved for bounded N1 implementation
**Scope:** backend worktree `codex/backend-agent-team-chat` only; no frontend, deployment, paid connector, production write, or remediation-authority change.

## Goal

Replace the fixed, one-shot component snapshot with one bounded Node Investigation Plane shared by the component drawer and Agent Team. Both consumers read the same canonical topology, evidence IDs, source truth, and safe summaries. The plane makes captured replay visibly captured/replayed and makes a live source visibly live, stale, or disconnected; it never upgrades source truth.

## Constraints and invariants

- Existing `/api/components/:id` clients remain compatible. Additive fields and query controls are versioned as `flowpulse.node-investigation.v1`.
- Component IDs must be canonical members of the selected topology. `run_id` must be a known canonical run; the model cannot supply or change either identity.
- The old Astronomy Shop 22-node/22-edge fixture remains accepted, but projection validation instead enforces a bounded canonical graph (non-empty, matching declared totals, unique safe IDs, valid endpoints, at most 256 nodes and 512 edges). Catalog fallback uses only safe canonical node metadata and never invents a business capability.
- Read, selection, and node SSE paths make no provider/model call. Every evidence/tool record is bounded, redacted, hashed/provenanced, and has `raw_payload_excluded: true`.
- No tool performs shell execution, arbitrary SQL, arbitrary HTTP, provider-chosen tool lookup, mutation, approval, repair, or verification. Existing repair authority stays outside this plane.

## Read model and stream

`GET /api/components/:id` accepts only:

| Input | Values |
| --- | --- |
| `run_id` | known canonical run ID |
| `window` | `5m`, `15m`, `1h`; default `15m` |
| `signal` | `all`, `metric`, `log`, `trace`, `change`, `resource`; default `all` |
| `cursor` | opaque bounded pagination cursor |
| `limit` | integer 1–12; default 8 |

The response retains legacy component-detail fields and adds the versioned node investigation projection: component identity/purpose/revision; health, incident relation and status; source truth/freshness; bounded relations; safe metric, trace, log, change, and evidence-backed resource records; exact evidence IDs/hashes; page/truncation metadata; `raw_payload_excluded: true`.

Resources are projected only when a source record explicitly carries a supported resource identity (`topic`, `consumer_group`, `database`, `table`, `job`, or `dag`) with provenance. No Astronomy Shop database/table/job fact is inferred from a label.

`GET /api/components/:id/events` uses the same canonical controls plus `after`, or `Last-Event-ID`. It sends a snapshot reference followed by ordered replay/incremental safe evidence/status events, an immediate heartbeat frame, and a terminal captured/stale/disconnected state where the source cannot continue. Event IDs are ordered replay sequence numbers. `after` is exclusive, so reconnects neither miss nor duplicate buffered events. Captured data is explicitly labelled `captured_replay`; a live source is polled only through the existing safe source adapter and emits only new fingerprints. The server keeps a bounded event buffer and response limit.

## Investigation registry

`src/node-investigation-plane.mjs` is the deep, server-owned read module. It exposes one strict snapshot/query layer and a small registry:

| Tool | Role access |
| --- | --- |
| `get_component_snapshot` | Observer, Investigator, Evaluator |
| `query_component_metrics` | Observer, Investigator, Evaluator |
| `query_component_logs` | Observer, Investigator |
| `query_component_traces` | Investigator, Evaluator |
| `query_component_dependencies` | Investigator, Evaluator |
| `query_recent_changes` | Investigator, Evaluator |
| `query_data_resources` | Investigator |

Orchestrator reads only the existing workflow projection and can transparently hand off; it cannot conduct telemetry investigation. Every registry invocation accepts the selected canonical component plus fixed server context and only bounded `window`, `cursor`, `limit`, and an allowlisted signal where applicable. Each safe result includes query fingerprint, counts, selected/omitted evidence, evidence IDs/hashes, source mode/status/freshness, and `raw_payload_excluded: true`.

## Bounded dynamic Agent investigation

The normal Agent Team request envelope is unchanged. The server seeds the selected component snapshot when a role permits it, then supplies a bounded context to the same provider adapter seam. Provider output gains a strict, required `tool_requests` array (empty when no tool is requested) alongside `answer` and nullable `recommended_handoff`. A tool request can contain only a role-allowlisted tool name and nullable bounded cursor/limit/signal fields; it cannot contain a component ID, window, query text, authority field, or arbitrary arguments.

The server, not the model, validates and executes requests and appends immutable request/result/round records. It permits at most two tool rounds, four requested tool calls total, and two calls per tool. Repeated identical requests return the cached result with an explicit `cached` marker. After a requested round the provider may receive selected safe results and revise its response; a third request round or exhausted budget yields a visible `blocked`/`needs_human` terminal reason rather than an unbounded loop. Provider failure remains a provider failure and is never hidden by recorded text.

The final safe response separates observed facts, inference/hypothesis, missing evidence, next recommended action, and citations. The browser receives only a redacted, byte-bounded `safe_answer`, bounded tool summaries/counts, valid requested/responding roles, handoff metadata, and citations that are a subset of evidence returned in the same conversation attempt. It never receives prompts, chain-of-thought, raw provider payloads, credentials, unrestricted logs, or tool internals.

## Ledger and terminal behavior

Append-only Agent Team events record tool request/result summaries, round, attempt, query fingerprint, cache status, source truth/freshness, selected/omitted counts, evidence references/hashes, and terminal reason. Existing agent event projection remains backward-compatible. Missing, stale, unsupported, malformed, or unavailable evidence becomes an explicit gap/blocked/needs-human result; it is never synthesized. Tool/schema/provider failure is explicit and does not fall back to a recorded success.

## Required proof

Tests cover generalized graph validation, legacy Astronomy compatibility, strict filters/caps, safe resource projection/redaction, SSE replay/resume/heartbeat/terminal truth, no model on reads, tool schema/role isolation, bounded dynamic tool lineage/caching/citation scope, authority rejection, and existing Agent/local loop compatibility.

The real smoke uses a fresh local database and authenticated `codex-local` only: checkout exposes captured checkout/payment evidence and tool calls; Kafka produces a distinct diagnosis or an honest supported-evidence limitation; insufficient evidence ends `needs_human` with no repair. The N1 frontend contract documents these exact safe payloads and source labels without requiring a frontend change.

## Self-review decisions

1. **“Live incremental” vs captured fixture:** captured replay is finite and labelled as such; it is not represented as a live subscription. Live adapters may add fingerprints on bounded polling, but source freshness remains authoritative.
2. **Dynamic model tools vs safety:** the model selects only from an enum and optional bounded pagination controls. Component, run, source, window default, and execution all remain server-owned.
3. **Citation claims:** prose is not treated as proof. The projected citation set is intersected with same-attempt tool evidence, and a response with no evidence after an evidence-required investigation stops safely.
4. **Topology flexibility vs fixture guarantees:** graph size/count expectations are removed from the projection module only; the existing fixture validator remains its own strict accepted-fixture test.

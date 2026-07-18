# Competition backend hardening

## Goal and boundary

FlowPulse keeps one Astronomy Shop story and one append-only ledger. This change makes the evidence used by GPT-5.6 explicit and bounded without changing the deterministic, no-credential replay. It adds only two evidence adapters: the captured incident bundle and local OpenTelemetry JSONL exported by the pinned Astronomy Shop. It does not add connectors, remediation authority, or a generic observability product.

## Evidence modes

| Mode | Authority | Model eligibility | Label |
| --- | --- | --- | --- |
| replay | immutable captured incident bundle | deterministic only | `deterministic replay` |
| captured | immutable captured OTLP evidence | evidence/list/detail APIs | `captured real evidence` |
| live | a fresh, frozen, capped OTLP snapshot | GPT-5.6 investigator and evaluator | `live GPT-5.6 over frozen OTLP snapshot` |

`live` is only legal when the source status is `live`. `connecting`, `stale`, and `disconnected` create an `insufficient_evidence` ledger outcome and never fall back to the fixture.

## Small source seam

`CapturedBundleEvidenceSource` and `LiveOtlpEvidenceSource` expose the same bounded `list`, `detail`, `summariesById`, and `metadata` operations. `LiveOtlpEvidenceSource.freeze()` sorts normalized records by timestamp and ID, filters to the five incident entities, and applies record and byte budgets. It returns an immutable `FrozenEvidenceSnapshot`; it does not retain a live stream. The snapshot records its ID, source hash, evidence IDs, caps, and content hash in an `evidence.snapshot.created` ledger event.

Live normalization retains immutable IDs, timestamp, entity, signal/kind, source, hash, and file/byte provenance. Tool responses and list APIs return a safe evidence projection, not OTLP payload blobs. Details retain the same hash and provenance, with sensitive/high-cardinality attributes redacted.

## Agent loop and human gate

The GPT investigator/evaluator receive an injected selected source, never `runtime.bundle`. Tool schemas remain strict; known evidence IDs are checked against the selected frozen snapshot; the existing six tool-round/two-attempt budget, `store:false`, and one replan remain. A model may propose only the allowlisted checkout rollback. It cannot execute, approve, or expand it. Owner approval continues to precede every repair; post-repair verification must cite evidence newer than the repair event.

## API projection

`/api/state` returns state, source metadata, and referenced safe evidence summaries. `/api/source` returns source metadata/topology without raw records. `/api/evidence` exposes a cursor-paged, byte-capped safe list, and `/api/evidence/:id` returns one redacted detail with immutable hash/provenance. Both list and detail fail closed for unknown IDs.

## Checks and stop conditions

Tests cover deterministic snapshot ordering/caps, stale-source rejection, unknown-ID rejection, evidence detail provenance, GPT tool selection from a frozen snapshot, payload bounds, owner-before-repair, and replay completion. The judge path remains `npm test` plus local server/replay, requiring neither Docker nor an OpenAI key. The only permitted live check is `FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run live:check`; starting a case, changing flagd, restarting containers, repairing, publishing, or invoking GPT requires the existing human gate.

## Self-review

The design preserves the ledger as authority, keeps real/captured/fixture labels honest, prevents unbounded telemetry from reaching either the API or model, and does not introduce a future-connector abstraction. It preserves the exact checkout → payment → retry → Kafka-lag story and its adversarial rejection, approval, verification, and learning gates.

## Acceptance repair 1 — causal utility and repair identity

The initial snapshot boundary was source-correct but too thin for causal review: it exposed service names and raw hashes but not the bounded operation, status, target, error, log, or metric facts needed to establish a mechanism. It also lacked the real local `change.applied` record, while the model's rollback schema differed from the adapter's checked-in recovery command.

Resolution: normalized trace, log, and metric summaries expose only bounded semantic fields. An active development snapshot adds exactly one deterministic `change` evidence record derived from `change.payment-unreachable.json` and its append-only `change.applied` event. Its content hash, manifest hash, ledger event ID, applied timestamp, target, flag, before/after values, and repair ID are retained. The source hash, content hash, and snapshot evidence IDs include this record.

The live-development GPT schema now has one literal repair contract: `repair-payment-reachable-v1`; `restore known-good paymentUnreachable flag and recreate checkout`; target `checkout`; command `astronomy.restore-payment-and-recreate-checkout`. The proposed repair, approval request, approval grant, and adapter invocation must all match it. `/api/live` remains a model-only frozen-evidence path without an active applied development change, so it never creates an executable-looking approval or repair.

## Acceptance repair 2 — redaction and causal execution gate

Safe telemetry is now a projection rather than a truncation convention. One deterministic sanitizer runs before trace targets, log messages, facts, values, tool results, and API projections. It removes URL userinfo, queries, and fragments; replaces bearer tokens, API keys, JWTs, emails, UUIDs, session/user/account identifiers, and long numeric identifiers with stable redaction labels; and retains only the host, path, operation, status, and bounded error terms needed for diagnosis.

Each OTLP batch selects a deterministic representative: trace errors/exceptions/dependency targets outrank healthy spans, error-severity logs outrank informational logs, and finite named metric datapoints outrank malformed values. Executable development snapshots reserve the immutable `change.applied` record and one post-change checkout/payment failure trace before applying general caps, then sort the final bounded result deterministically.

Executable repair is additionally a code gate, not an evaluator convention. The diagnosis must cite the exact frozen applied-change record matching the allowlisted repair contract and a post-change checkout/payment failure trace with bounded error evidence; the applied timestamp must precede the trace. Evaluator counter-evidence references are checked against the same snapshot. A missing, unrelated, reversed, or unknown reference records an `insufficient_evidence` or `agent_false_positive` outcome and cannot append a repair proposal or approval request.

The change record is constructed from the exact `change.applied` ledger payload and ledger event, never a later disk read of the manifest. Missing contract fields, inconsistent before/after values, or absent applied time fail closed.

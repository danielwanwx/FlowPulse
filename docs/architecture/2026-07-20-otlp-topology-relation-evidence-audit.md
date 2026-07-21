# OTLP topology relation evidence audit

**Scope.** Read-only evidence audit for the current 22-node OpenTelemetry Demo
fixture. It answers whether the six visually isolated nodes are genuinely
unconnected, and records the smallest evidence-backed correction. It does not
change the manifest, parser, API, or browser.

## Answer

The original checked-in manifest was intentionally bounded to 22 exact
parent-span dependencies, but it was **not a complete connectivity model** for
the captured OpenTelemetry Demo system. The corrected v2 manifest now keeps
the same 22 nodes, adds the four additional captured parent-span pairs for 26
`calls` relations, and records seven separately typed supporting relations.

- The v2 manifest and validator lock exactly 26 named captured `calls` edges
  and seven named typed supporting relations. Unknown or extra relations fail
  validation rather than being evaluated in the browser.
- The same ignored local capture named by the manifest's hashes contains
  additional cross-service parent relationships, cross-service span links, and
  safe peer/messaging attributes which the current topology parser does not
  consume.
- The pinned upstream source explicitly documents the Kafka asynchronous path,
  proxy routes to Flagd UI and Telemetry Docs, and telemetry export to the
  Collector. Those are real source-declared relationships, but not all are
  observed synchronous request edges.

Therefore Kafka, Accounting, Fraud Detection, Flagd UI, Telemetry Docs, and
the OTel Collector must not be rendered as permanently disconnected merely
because the v1 `calls` subset has degree zero. They must also not be connected
with browser-invented lines.

## Evidence classes

| Class | Repository evidence | What it proves | What it does **not** prove |
| --- | --- | --- | --- |
| Checked-in sanitized fixture | [`data/topology/otel-demo-system-v1.json`](../../data/topology/otel-demo-system-v1.json) | 22 captured component identities, 26 endpoint-valid redacted OTLP `calls` relationships, and seven typed supporting relations | Complete runtime, asynchronous, control, or telemetry topology |
| Checked-in incident bundle | [`data/incidents/astronomy-checkout.json`](../../data/incidents/astronomy-checkout.json) lines 19-34 | The deterministic incident path `checkout → kafka → accounting/fraud` is evidence-grounded for replay | A generic full-system live dependency graph |
| Ignored local capture | `outputs/live/otel/{traces,metrics,logs}.jsonl` | Additional observed parent/link/peer relationship evidence from the exact capture named by the fixture | A portable judge artifact or fresh/live health |
| Ignored pinned upstream source | `outputs/live/opentelemetry-demo` at commit `18b36c73…` | Declared asynchronous, proxy-route, and telemetry-export topology | A runtime observation in the captured window |
| Inference | Any line added merely because a component is “usually connected” | Nothing | It must never enter a topology projection |

The local capture and source are intentionally ignored by `.gitignore` lines
7-8. They are usable to derive a new sanitized fixture, not usable as a
browser dependency or as evidence that the current source is live.

## Checked-in contract facts

1. The fixture declares the upstream commit, `captured_fixture` mode,
   deterministic replay, unavailable current health, and SHA-256 hashes for
   the three raw input files in [`data/topology/otel-demo-system-v1.json`](../../data/topology/otel-demo-system-v1.json)
   lines 2-35. The local clone resolves to the same commit and its three local
   input hashes match those declarations.
2. Kafka, Accounting, Fraud Detection, Flagd UI, OTel Collector, and Telemetry
   Docs now occur in the checked-in v2 relation model only where the capture or
   pinned source proves the relationship. Kafka remains a typed asynchronous
   relation, never a fabricated synchronous call.
3. This is enforced rather than inferred at runtime: the manifest validator
   fixes the exact 26 direct IDs and seven supporting records in
   [`src/topology-manifest.mjs`](../../src/topology-manifest.mjs). The tests
   reject an unknown, duplicated, unordered, or endpoint-invalid relation.
4. The incident overlay maps two of its five edges to `observed_dependency` and
   three Kafka-path edges to `evidence_grounded_relation`; it does not create
   a browser-only relation category.

## Why the current parser misses real relationships

`LiveSource.topologyFrom` adds all services observed in any signal, but makes
an edge only when one trace span has a `parentSpanId` that resolves to a span
from another service: [`src/live-source.mjs`](../../src/live-source.mjs) lines
118-146. The sanitized fixture corrects this captured projection through an
explicit, reviewed manifest rather than teaching the browser to infer links.
The live-source parser itself intentionally does **not** inspect:

- OpenTelemetry span links, which are used for asynchronous handoff;
- bounded peer-target attributes; or
- source-declared proxy and telemetry-export relations.

The same module already reads peer-target attributes for safe detail facts
([`src/live-source.mjs`](../../src/live-source.mjs) lines 327-331), but does not
use them in `topologyFrom`. That implementation choice explains why the six
components are nodes but have no selected `calls` edge; it is not proof that
they have no upstream/downstream relationship.

## Exact local-only capture evidence

The following result was produced locally without printing raw span, log, or
metric payloads. It reads only service names, parent/link IDs, and a strict
allowlist of relationship attributes; the capture is stale and local-only.

| Relation evidence | Safe derived result | Classification |
| --- | --- | --- |
| Cross-service parent spans | 26 unique pairs. The current fixture retains 22 and omits `ad → flagd`, `payment → flagd`, `recommendation → flagd`, and `fraud-detection → flagd`. | Observed dependency; fixture is incomplete even within its current parent-span rule |
| Cross-service span links | `checkout → accounting`, `checkout → fraud-detection` | Observed asynchronous handoff, but not a direct broker edge |
| Safe peer target | `checkout → kafka` | Observed peer/messaging target; requires a dedicated, bounded relation rule |
| Messaging facts | Checkout, Accounting, and Fraud Detection each identify Kafka as their messaging system; Accounting and Fraud Detection identify the same orders destination. | Corroborating async-path evidence; a broker intermediary must be labelled as source-declared or evidence-derived, never disguised as a synchronous call |

The first three rows are reproducible from the input whose trace SHA-256 is
recorded in the checked-in fixture. No raw IDs, log bodies, payloads, paths,
or credentials are needed in the eventual manifest.

## Pinned source documentation evidence

These first-party files live in the ignored clone at the same commit declared
by the checked-in manifest. They substantiate topology semantics but must be
converted into a bounded, redacted provenance record before any browser use.

| Component(s) | Source declaration | Consequence for a topology projection |
| --- | --- | --- |
| Checkout, Kafka, Accounting, Fraud Detection | `outputs/live/opentelemetry-demo/src/kafka/README.md` lines 1-6 says Kafka connects Checkout to Accounting and Fraud Detection. The full compose profile calls Accounting/Fraud Kafka consumers and applies a Kafka dependency to Checkout: `compose.full.yaml` lines 4-5, 11, 25-30, 33-37, 44-45, 60-77, 84-85, and 124-130. Direct pinned implementation corroborates it: `src/checkout/main.go` lines 246-253, 409-412, and 652-730 produces orders to Kafka; `src/accounting/Consumer.cs` lines 42-48 and 83-131 consumes/processes them; `src/fraud-detection/src/main/kotlin/frauddetection/main.kt` lines 26-56 subscribes to the same topic. | A separate `declared_async_dependency` relation family can safely connect `checkout → kafka → accounting/fraud-detection`, with pin + configuration provenance. It must not be labelled `calls` or treated as fresh traffic. |
| Accounting | `src/accounting/README.md` lines 1-4 says it consumes new orders from a Kafka topic. | Confirms Kafka is a valid upstream of Accounting. |
| Fraud Detection | `src/fraud-detection/README.md` lines 1-4 says it receives new orders by Kafka topic. | Confirms Kafka is a valid upstream of Fraud Detection. |
| Flagd UI | Frontend Proxy routes `/feature` to the `flagd-ui` cluster: `src/frontend-proxy/envoy.tmpl.yaml` lines 59-66 and defines that cluster at lines 223-235. | `frontend-proxy → flagd-ui` is source-declared route topology, not necessarily observed traffic in this capture. |
| Telemetry Docs | Frontend Proxy routes `/telemetry/` to `telemetry-docs`: `src/frontend-proxy/envoy.tmpl.yaml` lines 53-58 and 276-288. | `frontend-proxy → telemetry-docs` is source-declared route topology, not necessarily observed traffic in this capture. |
| OTel Collector | Core compose calls it the telemetry receiver/processor at `compose.yaml` lines 813-841. Flagd UI and Telemetry Docs both declare OTLP Collector integration at lines 702-721 and 740-760. | These are observability-plane export relations. They should be drawn distinctly and never conflated with customer runtime data flow. |

## Smallest evidence-backed correction

This correction is implemented as one backend fixture/parser/projection
checkpoint, not as a browser inference change:

1. The versioned v2 manifest retains 26 captured parent-span `calls` relations
   and records seven bounded `declared_async_dependency`,
   `configuration_route`, and `telemetry_export` relations with provenance.
2. The server-owned topology view preserves the relation category. Live may
   draw every valid endpoint relation, but only direct captured `calls` paths
   receive the sequential traffic pulse; support relations never impersonate
   fresh traffic.
3. The manifest hash and tests bind the four newly selected parent-span edges,
   the Kafka async path, proxy routes, and Collector exports.
4. The incident overlay remains separate. It identifies five causal replay
   edges without silently promoting the Kafka path to synchronous calls.

This is the smallest correction that connects the six components with
verifiable evidence while preserving the browser's no-invented-topology and
no-false-live-truth rules.

## Decision

The earlier claim that these six components had “no verifiable relation” was
too strong. The original v1 manifest had no selected edge for them, but the
exact local capture and pinned OpenTelemetry Demo source provided enough
first-party evidence for the v2 source-owned typed expansion. The browser
consumes that corrected contract and does not supplement it.

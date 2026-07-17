# FlowPulse Live Development Workspace

Date: 2026-07-17  
Status: approved design, awaiting written-spec review  
Selected product direction: A — Production Workspace

## Decision summary

FlowPulse will open as a generic production incident product, not as an Astronomy Shop case page. The primary view is a live system map for the selected workspace and environment. A specific incident appears as contextual state inside that product shell.

The first real integration is the official OpenTelemetry Astronomy Shop running in a disposable local Docker development environment. FlowPulse will consume actual telemetry emitted by the running services, correlate it with versioned change and deployment records, gate a bounded local rollback behind owner approval, verify recovery from fresh telemetry, and finalize the real run as a hashed deterministic replay capture.

The existing complex Astronomy Shop replay remains the reliable judge path until an equivalent live capture has been produced and validated. FlowPulse must never label a fixture as live or claim a causal relationship that the observed telemetry does not support.

## Design decisions

### Selected: Production Workspace

- Product identity and workspace context remain stable across incidents.
- The system map is the first visual focus.
- Environment, source freshness, deployment revision, and ledger authority are visible before incident-specific copy.
- An active incident is a compact contextual strip with an `Open incident` action.
- The Incident Digital Twin continues to provide Live, Replay, and Compare on the same component identities.

### Rejected for this iteration: Fleet-first home

A multi-system fleet home would imply account management, persistence for many systems, search, permissions, and additional routes. It also moves the distinctive Digital Twin behind another click. This is unnecessary for the current competition build.

### Rejected for the default populated state: Connection-first home

Connection-first is the correct empty state for a workspace with no evidence sources, but it is not the default once a source is connected. It will be represented as a bounded empty/error state rather than a new onboarding product.

## Loop contract

### Goal

Demonstrate a real, evidence-grounded development incident loop:

`versioned change -> real deploy -> real OTLP telemetry -> detection -> adversarial diagnosis -> owner-approved bounded rollback -> real verification -> hashed replay capture -> regression case`

### Input scope

Allowed inputs:

- The standalone FlowPulse repository.
- A pinned official OpenTelemetry Astronomy Shop checkout created by the setup command.
- The local Docker Engine and Docker Compose.
- OTLP JSON written by the OpenTelemetry Collector file exporter.
- Local Git metadata, FlowPulse change manifests, and allowlisted Docker deployment status.
- Existing FlowPulse ledger, runtime, GPT-5.6, Langfuse, policy, replay, and Digital Twin code.

Disallowed inputs:

- Production credentials or production write access.
- Unversioned third-party sample data presented as FlowPulse evidence.
- Inferred telemetry values that were not observed or captured.
- Arbitrary shell commands proposed by an LLM.
- Imported visual or application code from an unrelated repository.

### Execute

1. Verify Docker, Compose, disk, memory guidance, and the pinned upstream revision.
2. Start the official full Astronomy Shop profile with Kafka and its downstream consumers.
3. Fan out Collector telemetry to the existing observability backend and three mounted OTLP JSONL capture streams: traces, metrics, and logs.
4. Continuously ingest new JSONL records, normalize them into stable FlowPulse evidence, and derive topology from resource and span relationships.
5. Record a versioned checkout configuration change and the resulting local deployment revision.
6. Detect the incident from fresh observed signals and open an investigation ledger run.
7. Let the investigator query only allowlisted telemetry, change, deployment, and topology tools.
8. Require the evaluator to reject any diagnosis whose cited evidence does not prove initiation and propagation.
9. Produce a bounded rollback proposal that names the exact change, target service, known-good revision, verification checks, timeout, and abort condition.
10. Pause for owner approval.
11. After approval, execute only the allowlisted local rollback adapter and record its stdout/stderr summary and resulting revision.
12. Generate new traffic and verify recovery from post-repair telemetry.
13. Freeze the capture window, hash raw inputs, persist the capture manifest, and create the deterministic regression case.

### Checks

- Source status is derived from observed file progress and timestamps, never hard-coded.
- Every discovered component has an observed `service.name` or an explicitly typed FlowPulse control-plane identity.
- Every dependency edge has an observed span or messaging relationship.
- Every material diagnosis cites evidence IDs that resolve to raw source offsets and capture hashes.
- Change time precedes or overlaps the first causal failure signal.
- A prominent symptom alone cannot establish root cause.
- The repair target and revision match the accepted causal finding.
- `approval.granted` exists before `repair.executed`.
- Verification uses telemetry recorded after repair completion.
- Capture replay reconstructs the same topology, evidence IDs, stage sequence, and verification result.
- Existing deterministic replay remains under three minutes and all existing tests stay green.

### Feedback rules

- Docker unavailable or resources insufficient -> keep replay available, show a setup diagnostic, and do not claim a live source.
- Upstream revision mismatch -> stop setup and require an explicit pin update in the repository.
- Collector stream stops advancing -> mark the source stale; do not continue live verification.
- Malformed OTLP JSON -> quarantine the line with file and byte offset, record `tool_data_failure`, and continue only if the remaining required evidence is sufficient.
- Topology entity has no observed provenance -> omit it from the live map; do not synthesize a production component.
- Unsupported hypothesis -> record evaluator rejection and replan toward the missing evidence category.
- Repair command differs from the allowlisted manifest -> reject before execution.
- Deployment fails -> record `repair_failure`, preserve the failed state, and stop automatic action.
- Recovery thresholds fail -> record `repair_failure`; do not attempt a second mutation.
- A live Kafka relationship is not supported by observed evidence -> remove that claim from the live incident. The deterministic complex replay remains separately labeled.

### Records

- Source registration and freshness transitions.
- Raw file path, byte range, signal type, and SHA-256 segment hash.
- Normalized evidence ID and raw provenance pointer.
- Observed services, instances, span relationships, and messaging relationships.
- Git SHA, change manifest ID, deployment target, image/config revision, and deploy result.
- Hypotheses, citations, evaluator scores, counter-evidence, and replans.
- Owner request and approval decision.
- Repair command identifier, result, and resulting revision.
- Verification window, thresholds, measurements, and outcome classification.
- Final capture manifest and regression/policy-gate results.

### Stop conditions

Success:

- A local real change is deployed.
- Actual Astronomy Shop telemetry is ingested and visible as `Live OTLP`.
- The agent produces an evidence-grounded finding after adversarial evaluation.
- The owner-approved rollback changes the real local development runtime.
- Fresh telemetry verifies the result.
- The run becomes a deterministic hashed replay capture.
- Automated tests, browser QA, documentation, and the existing judge path pass.

Stop and report:

- External credentials or production authority become necessary.
- The pinned upstream environment cannot run after three focused repair attempts.
- The observed evidence cannot support a root-cause conclusion.
- A requested repair falls outside the allowlisted local target.

### Human gates

- Owner approval before any local runtime mutation.
- Explicit user approval before connecting a non-local telemetry or deployment source.
- Explicit product review before promoting a captured live case into the default judge fixture.
- Existing human review before policy promotion.

## Product information architecture

### Persistent product bar

The top product bar contains:

- `FlowPulse`
- Workspace selector, initially `Development workspace`
- Environment selector, initially `dev / astronomy-shop`
- Source truth badge: `Live OTLP`, `Captured evidence`, `Replay`, `Stale`, or `Disconnected`
- Immutable ledger event count
- Optional Langfuse trace link when configured

The product bar never uses the active incident title as the page heading.

### Primary navigation

The first implementation keeps one route and uses compact working modes:

- System map
- Incidents
- Changes
- Evaluations

These are view filters over the existing workspace rather than new multi-page products. The System Map is selected by default.

### Main heading

Default populated heading:

`Production system map`

Supporting line:

`Observed services, dependencies, changes, and incident state from authoritative sources.`

When no source is connected, the same area becomes the connection empty state. When an incident is selected, the system heading remains stable and the incident title appears in the context strip and detail drawer.

### Active incident strip

The strip contains severity, concise symptom, detected time, investigation state, source mode, and `Open incident`. For the flagship replay, Astronomy Shop remains incident content, not product identity.

### Shared canvas

The canvas remains 65–75% of the primary viewport. Live, Replay, and Compare continue to share stable entity identities and deterministic geometry.

Live data changes the source of nodes and edges, not their interaction model:

- Production entities come only from observed telemetry.
- FlowPulse control-plane entities remain explicitly labeled as control-plane components.
- Selecting a node, edge, change, deploy, or incident opens the existing contextual drawer.
- Color remains localized to component icons, status beacons, annotations, and semantic pulses; surfaces remain white and structural lines remain neutral.

## Source truth modes

```text
Disconnected -> Connecting -> Live OTLP -> Capturing -> Verified capture -> Replay
                         |          |
                         +-> Stale <-+
```

Mode definitions:

- `Disconnected`: no authoritative telemetry source is registered.
- `Connecting`: setup or stream discovery is in progress.
- `Live OTLP`: raw Collector output is advancing and the latest observed record is inside the freshness window.
- `Stale`: a previously live stream has not advanced within the configured freshness window.
- `Capturing`: live ingestion continues while FlowPulse is finalizing an incident-bounded capture window.
- `Verified capture`: raw hashes, provenance pointers, normalization, and deterministic reconstruction checks passed.
- `Replay`: the UI is reconstructing an immutable capture and performs no external runtime mutation.

The existing `Live` tab must no longer mean captured-live. It displays `Live OTLP` only when the real source is fresh. Otherwise it displays the accurate source state and offers Replay.

## Runtime architecture

```text
Official Astronomy Shop services
        |
        | OTLP traces / metrics / logs
        v
OpenTelemetry Collector
        |
        +--> existing Grafana / Jaeger path
        |
        +--> mounted OTLP JSONL spool
                    |
                    v
          FlowPulse capture reader
                    |
                    +--> raw provenance index
                    +--> evidence normalizer
                    +--> topology projection
                    +--> append-only ledger
                                      |
                    GPT-5.6 investigator/evaluator
                                      |
                              owner approval gate
                                      |
                         allowlisted local deploy adapter
                                      |
                           post-repair telemetry verify
                                      |
                     hashed capture + deterministic replay
```

### Astronomy Shop integration

- Pin the official upstream repository to one reviewed commit or release.
- Fetch it into a gitignored runtime directory; do not vendor its application source into FlowPulse.
- Use full Docker Compose mode because the competition topology includes Kafka, Accounting, and Fraud Detection.
- Use a FlowPulse Compose override to mount Collector configuration and a writable capture directory.
- Keep the official service images and existing built-in observability backend.
- Record the upstream revision and all image digests in the source manifest.

### Collector capture spool

The first implementation uses the official Collector file exporter rather than implementing a new OTLP network server. Separate exporters write line-delimited OTLP JSON for traces, metrics, and logs into a mounted local directory.

This is still real OTLP telemetry from the running services. The UI describes it precisely as `Live OTLP via Collector` and exposes last record time and source revision.

The reader maintains per-file byte offsets. Each normalized evidence record stores:

- signal type
- source file identifier
- start and end offset
- resource identity
- event time and ingestion time
- stable content-derived evidence ID
- current segment hash

### Topology derivation

Service nodes come from observed OpenTelemetry resources. Dependency edges come from trace parent/child service transitions and supported messaging attributes. Repeated observations increase edge sample counts but do not create duplicate identities.

Layout stays deterministic:

- Preserve the existing semantic component grammar.
- Rank services from observed call direction.
- Break cycles with stable lexical tie-breaking.
- Preserve positions for known nodes across refreshes.
- Place newly observed nodes in the next free slot in their semantic rank.
- Never use random or force-directed layout.

### Change and deployment evidence

The first real case uses a versioned local checkout configuration change built on the official `paymentServiceUnreachable` scenario. The change manifest includes:

- change ID and Git SHA
- author type, including `ai-generated` when applicable
- target service
- before and after configuration values
- expected deployment command identifier
- known-good rollback manifest
- verification thresholds

Applying the manifest is a real change to the disposable development runtime. FlowPulse records the Docker service/container revision before and after application.

The live case must diagnose only what its observed telemetry proves. It may demonstrate payment unreachability and checkout failure without claiming that checkout retries caused Kafka lag. The existing complex replay retains its separate captured narrative until that exact cross-system propagation has been reproduced and verified from real raw telemetry.

### Bounded remediation adapter

The adapter accepts only a repository-owned repair manifest selected by ID. It does not accept free-form commands from GPT-5.6.

For the first integration the allowed mutation is:

`restore known-good checkout configuration and recreate only the affected local Docker service`

The adapter validates:

- source mode is local development
- incident target matches the manifest target
- approved change and rollback revisions match
- owner approval belongs to the current run
- command ID is allowlisted
- timeout and abort conditions are present

### Verification and capture finalization

Verification begins only after the deployment adapter records completion. It requires a bounded number of fresh requests and post-repair telemetry. Measurements carry their raw provenance and are compared with explicit thresholds.

Capture finalization:

1. Record start/end source offsets and event-time bounds.
2. Copy only the incident window into immutable capture segments.
3. Compute SHA-256 for every raw segment and the manifest.
4. Re-run normalization from the frozen segments.
5. Assert identical evidence IDs, topology, stage mapping, and verification outcome.
6. Mark the capture `verified` only if every assertion passes.

## Agent and evaluator behavior

The existing code-owned state machine remains runtime authority. GPT-5.6 may select evidence tools and propose findings, but it cannot:

- create a topology entity without observed provenance
- change a source mode
- bypass the evaluator
- approve a repair
- construct a free-form deployment command
- mark verification successful
- promote a policy

Live tool responses include source freshness and provenance pointers. The evaluator must distinguish:

- symptom correlation
- initiating change evidence
- failure mechanism evidence
- downstream propagation evidence
- missing or contradictory evidence

If the live evidence supports a simpler incident than the complex replay, the agent must return the simpler truthful result.

## Error and degraded states

- Docker missing: show `Local runtime unavailable`, exact prerequisite, and Replay action.
- Upstream download unavailable: show the pinned source and retry command; preserve the product UI.
- Resource check fails: show the official full-mode memory/disk guidance and do not start partial Kafka-free mode for this case.
- Collector not writing: show `Connecting` or `Stale`, file path, last record time, and diagnostic action.
- No telemetry yet: show the observed source with zero discovered services and wait for load-generator traffic.
- Malformed record: expose a quarantined-record count without placing malformed data in the evidence drawer.
- Deployment failure: keep the incident open, record `repair_failure`, and provide the captured command result.
- Verification timeout: retain before/after data and mark recovery unverified.
- Langfuse unavailable: show `Tracing not configured`; runtime behavior remains unchanged.

## Commands and judge experience

Existing commands remain compatible:

- `npm test`
- `npm run demo`
- `npm run judge`

New opt-in local-development commands:

- `npm run live:check` — read-only prerequisite and resource diagnostics
- `npm run live:setup` — fetch the pinned upstream and start the full disposable environment
- `npm run live:case` — apply the approved bad checkout change and start capture/investigation
- `npm run live:stop` — stop the disposable integration without deleting verified captures

The under-three-minute judge path uses a pre-verified deterministic capture by default. A warmed live environment may be shown as an additional proof path, but judge success cannot depend on downloading images or waiting for a cold build.

## Test design

### Deterministic unit tests

- Parse representative raw OTLP JSON for traces, metrics, and logs.
- Produce stable evidence IDs from the same raw records.
- Resume ingestion from byte offsets without duplicate evidence.
- Derive stable service identities and dependency edges.
- Reconstruct identical topology after capture finalization.
- Enforce source-mode freshness transitions.
- Correlate change, deployment, and first-failure timestamps.
- Reject unsupported live Kafka causality.
- Reject repair before owner approval.
- Reject repair target/revision mismatch.
- Require post-repair provenance for verification.

### API and integration tests

- Expose source status, topology provenance, capture status, and deployment revision without breaking existing `/api/state` consumers.
- Simulate a growing spool and confirm `Connecting -> Live OTLP -> Stale` transitions.
- Run the full loop against a fixture spool and a fake allowlisted deploy adapter.
- Preserve the current replay sequence, policy gates, and GPT-5.6 boundaries.

### Opt-in real smoke

When Docker is available:

- Start the pinned full Astronomy Shop environment.
- Confirm fresh trace, metric, and log records.
- Confirm Checkout, Payment, Kafka, Accounting, and Fraud identities are discovered from observed data.
- Apply the versioned checkout fault and observe real checkout/payment failure evidence.
- Execute the owner-approved local rollback.
- Confirm fresh post-repair evidence meets thresholds.
- Finalize and replay the capture.

The real smoke is not part of the default dependency-free unit test command.

### Browser QA

At 1440×900 and 1280×800 verify:

- Product heading is generic and incident copy is contextual.
- Source mode and freshness are visible and accurate.
- Live nodes and edges expose provenance in the drawer.
- Captured Replay remains clearly distinguished from Live OTLP.
- Owner gate, remediation, verification, Compare, and Evolve remain reachable.
- No clipped component, edge-label collision, browser error, or browser warning.
- Keyboard focus, accessible names, contrast, and reduced motion pass.

## Acceptance

- The repository remains standalone and contains no unrelated product content.
- The default first viewport reads as a production incident workspace.
- A disconnected workspace never shows fixture nodes as live.
- A connected local workspace discovers actual Astronomy Shop components from telemetry.
- Live evidence resolves to raw capture offsets and hashes.
- A real versioned checkout change is applied to the disposable environment.
- The agent/evaluator loop uses actual observed evidence.
- Owner approval precedes the real local rollback.
- Fresh telemetry verifies the result.
- A verified live run can be replayed deterministically.
- The existing complex replay and all tests remain compatible.
- Documentation explicitly separates real runtime, captured evidence, simulated behavior, and optional credentials.
- Final server runs latest code on port 4310, screenshots are recorded, changes are committed, and the worktree is clean.

## Non-goals

- No production Kubernetes connection in this iteration.
- No Argo Rollouts, Flagger, Chaos Mesh, or LitmusChaos integration in this iteration.
- No generic observability warehouse or replacement for Grafana, Jaeger, SigNoz, or OpenObserve.
- No multi-tenant fleet, authentication, billing, or team administration.
- No arbitrary LLM-generated shell execution or autonomous code deployment.
- No automatic policy promotion.
- No claim that a live Kafka symptom was caused by checkout unless observed evidence proves it.
- No replacement of the reliable deterministic judge path with a cold-start live environment.

## Research and provenance references

- OpenTelemetry Demo: <https://opentelemetry.io/docs/demo/>
- OpenTelemetry Demo feature flags: <https://opentelemetry.io/docs/demo/feature-flags/>
- OpenTelemetry Demo Docker deployment: <https://opentelemetry.io/docs/demo/docker-deployment/>
- OpenTelemetry Collector file exporter: <https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/fileexporter>
- RCAEval offline benchmark: <https://github.com/phamquiluan/RCAEval>
- OpenRCA benchmark: <https://github.com/microsoft/OpenRCA>
- HolmesGPT competitive reference: <https://github.com/HolmesGPT/holmesgpt>
- Argo Rollouts deferred deployment reference: <https://argo-rollouts.readthedocs.io/>

## Decision log

- 2026-07-17: User selected Product Workspace option A from the visual companion.
- 2026-07-17: Official Astronomy Shop selected as the real local runtime because it provides native multi-signal OpenTelemetry and the required service domain.
- 2026-07-17: Collector file export selected as the smallest reliable real-ingestion seam; a custom OTLP server is deferred.
- 2026-07-17: Docker Compose selected for the first real deployment loop; local Kubernetes and Argo Rollouts are deferred.
- 2026-07-17: Existing complex replay remains the default judge path until an equivalent real capture passes provenance and determinism checks.
- 2026-07-17: Live claims are restricted to observed causality even when that produces a simpler story than the current replay.

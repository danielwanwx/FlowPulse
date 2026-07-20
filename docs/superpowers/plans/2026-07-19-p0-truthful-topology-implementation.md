# P0 truthful topology composition implementation plan

Status: owner-amended plan-only checkpoint; implementation starts only after Daniel approves this full-topology revision

Date: 2026-07-19

Approved specification: `docs/superpowers/specs/2026-07-19-topology-live-graph-system-design.md`, originally committed at `79224a985c4755ecb3c57fbffb69cf2264c2210e` and amended alongside this plan for the owner-selected 4333/22-node baseline

Review branch: `codex/topology-live-integration`

Candidate under audit: `e4c6d87e41a074944f8358128e012ef72dec1a08`

Mainline boundary: preserve `origin/main`; do not merge, rebase, force-push, deploy, or modify Devpost

Scope: P0 topology semantics and read-only Architecture/Live integration only. P1 gesture arbitration and P2 shared visual styling are deferred non-goals.

## 1. P0 loop contract

| Element | Contract |
| --- | --- |
| Goal | Make Architecture render the complete evidence-grounded 22-node runtime/data graph plus four distinct FlowPulse control/evidence entities, make Live render the complete 22/22 selected source graph, and make Diagnose overlay the bounded six/five incident path without giving the browser topology or authority ownership. |
| Input scope | A sanitized checked-in manifest derived from the synthetic OpenTelemetry Demo capture, the bounded incident bundle, bounded evidence summaries, canonical ledger events, checked-in investigator/evaluator identities, actual append-only ledger capability, IncidentProjection v1, owner-accepted visual baseline `7426364` at port 4333, and candidate `e4c6d87`. Raw `outputs/live/**` and `.env*` are derivation inputs only and never judge/runtime dependencies. |
| Execute | Inventory and contract the 22/22 evidence; stop; audit/isolate compatible candidate hunks; normalize full source topology and incident overlay; compose Architecture; validate/project views through IncidentProjection/server; switch browser views to explicit backend-owned projections; perform contract and visual QA. |
| Check | Stable IDs, exact enums, provenance, deterministic order, endpoint integrity, caps/truncation, source labels, no invented entities, no authority inference, focused/backend/full tests, API counts, screenshots, console, dirty-tree and process checks. |
| Feedback | Missing provenance or a schema mismatch fails closed and stops the task. A browser-only truth patch is rejected. A visual-only request is deferred to P2. |
| Record | Candidate audit, red/green tests, before/after API counts, exact changed paths, per-task commit, screenshot matrix, review port/PID, console output, residual limitations, and owner verdict. |
| Stop | Stop after every task and wait for Daniel. Also stop on unisolatable dirty overlap, absent evidence, authority regression, stale-server ambiguity, a required P1/P2 change, or failing regression. |
| Human gates | Daniel authorizes the next task, final P0 acceptance, and any eventual merge. No task automatically advances to the next one. |

## 2. Mandatory branch and worktree preflight

Run these read-only commands before any implementation task:

```bash
cd /Users/danielwan/Documents/Codex/2026-07-16/flowpulse
git switch codex/topology-live-integration
git fetch origin
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git merge-base --is-ancestor origin/main HEAD
git status --short
git diff --check
git diff --name-status origin/main...HEAD
git log --oneline --decorate -8
```

Record SHA-256 fingerprints for every dirty/untracked path that belongs to the user. `state/connector_capabilities.json` is generated and remains untracked unless an existing repository rule changes. Do not stage it.

Stop before editing if:

- the branch is not `codex/topology-live-integration`;
- `origin/main` is not an ancestor of the branch;
- an overlapping uncommitted change cannot be attributed and isolated;
- mainline moved in a way that invalidates the approved spec;
- any command suggests that implementing P0 would require resetting, cleaning, or merging.

The implementation session must use explicit path staging. It must never use `git add .`, `git reset --hard`, a whole-tree checkout, an amend of `e4c6d87`, or a force-push.

## 3. Audit of `e4c6d87`

This audit is required before any wiring change, but the first implementation checkpoint is the fixture inventory/contract in Task 0. Apply no `e4c6d87` follow-up code change until Daniel has reviewed Task 0 and confirms this disposition table.

| File / hunk | Candidate behavior | Classification | P0 disposition |
| --- | --- | --- | --- |
| `src/evidence-source.mjs` / `CapturedBundleEvidenceSource.captureTopology` and `.topology()` | Exposes the six incident services and five causal edges | **Reuse for Diagnose; supersede for Architecture/Live** | Preserve it as the bounded incident overlay only. Normalize alias `fraud` to canonical `fraud-detection`; never treat this six/five graph as the complete system topology. |
| `src/evidence-source.mjs` / `LiveOtlpEvidenceSource.topology()` | Normalizes the full OTLP-derived topology when configured | **Reuse + amend** | Keep the full-source path and make it conform to the same strict 22/22 manifest contract. LIVE requires validated fresh authoritative input; stale/frozen states remain LAST-KNOWN/STALE or explicitly frozen. No identity is synthesized. |
| `src/evidence-source.mjs` / `FrozenEvidenceSnapshot.topology()` returning empty | Avoids inventing a frozen topology | **Amend** | Keep fail-closed behavior. A frozen snapshot may expose topology only if its server-owned capture recorded and bound one; otherwise topology remains unavailable. No fallback to fixture topology. |
| `src/evidence-source.mjs` / `capturedTopology()` and `sourceTopology()` helpers | Filters missing endpoints and freezes arrays | **Amend** | Move strict reusable validation/composition responsibility into the P0 topology modules; retain source-specific extraction. Add exact 22/22 manifest validation, duplicate/semantic-edge/bounds/provenance checks, and separate six/five overlay validation. |
| `src/server.mjs` / `sourceProjection()` selects `selected.topology()` | Correctly prevents one source from silently borrowing another source's topology, but replay selection currently yields six/five | **Reuse principle; amend data source** | Preserve source ownership while making the code-owned judge selection the sanitized 22/22 fixture and retaining the incident bundle separately. Captured remains CAPTURED, never LIVE or LAST-KNOWN. |
| `src/server.mjs` / `stateWithSource()` passes `sourceState.topology` directly to IncidentProjection | Gives IncidentProjection the selected source graph, currently six nodes | **Amend** | Pass the server-owned 22-plus-four Architecture composition to IncidentProjection, retain the full 22/22 source graph for Live, and pass six/five as a separately typed Diagnose overlay. |
| `src/server.mjs` / `redactedSource()` derives source topology from `projection.graph` | Causes one graph shape to serve incompatible Architecture and Live meanings | **Amend** | Redact the selected bounded source topology for Live and expose composed Architecture through `incident_projection.graph`. Do not leak raw events/evidence/provider data. |
| `src/incident-projection.mjs` / existing `graphFor()` | Caps and redacts nodes/edges but drops plane/layer/provenance fields | **Amend** | Strictly validate and preserve P0 graph fields, include them in revision binding, deterministically truncate, and fail closed on invalid endpoints/duplicates/unknown enums. |
| `public/twin-state.mjs` / `topologyIntegrity()` accepts both `nodes/edges` and `services/dependencies` | Bridges two browser shapes | **Amend** | Keep endpoint normalization temporarily only where the explicit backend view contract requires it. Tests must enforce Architecture from `incident_projection.graph` and Live from bounded source topology; no ambiguous fallback chain. |
| `public/app.js` / `architectureTopology()` normalizes `source.topology` and returns it when nonempty | Replaces the full/product graph with whichever source graph is selected; under replay this is six/five | **Amend / supersede** | Read the composed `incident_projection.graph` containing the full runtime/data base plus four non-duplicated control/evidence identities. Never use the incident overlay or `TWIN_NODES` to claim complete/active participation. |
| `public/app.js` / captured branch in `captureLabel()` | Top header says Captured replay | **Reuse + amend** | Centralize source-label mapping so header, node origin, detail drawer, and accessibility copy all agree on CAPTURED. Correct the remaining `sourceOrigin()` LAST-KNOWN wording for captured replay. |
| `public/app.js` / node handling added to `handleCanvasKeydown()` | Adds node Enter/Space drawer behavior | **Revert from P0; defer to P1/accessibility work** | Apply a targeted inverse in Task 1's candidate-isolation commit so P0 does not carry an unreviewed interaction change. Preserve the hunk reference for the later P1 plan. |
| `public/styles.css` / stronger Live edge stroke/opacity | Changes graph visual styling | **Revert from P0; defer to P2** | Restore baseline style in Task 1's candidate-isolation commit. If baseline edges cannot provide P0 functional evidence, stop for Daniel instead of starting P2 styling. |
| `test/evidence-source.test.mjs` / six-node/five-edge test | Proves only the bounded incident topology | **Reuse as Diagnose overlay coverage** | Keep exact six/five assertions, canonical aliasing, provenance, and invalid-edge rejection, but move full Live/Architecture expectations to the sanitized manifest/composition tests. |
| `test/server.test.mjs` / source and IncidentProjection both expected as six/five | Conflates incident overlay, Live source graph, and Architecture | **Supersede** | Assert Live is exact 22/22 CAPTURED, Architecture is exact 26 nodes for the judge fixture, and Diagnose exposes exact six/five overlay membership without replacing the system graph. |
| `test/twin-state.test.mjs` / compatibility, label, CSS, keyboard assertions in one test | Mixes P0, P1, and P2 acceptance | **Amend** | Keep only P0 view-selection, count, endpoint, and label tests. Remove CSS/keyboard assertions from P0; they return in later plans. |

Audit records:

```bash
git show --stat e4c6d87
git show --format= --unified=40 e4c6d87 -- \
  src/evidence-source.mjs src/server.mjs src/incident-projection.mjs \
  public/app.js public/twin-state.mjs public/styles.css \
  test/evidence-source.test.mjs test/server.test.mjs test/twin-state.test.mjs
git diff --name-status origin/main...HEAD
```

**Owner stop A:** report the table, existing dirty fingerprints, and exact targeted reverts. Do not proceed to Task 1 until Daniel accepts the audit.

## 4. Target P0 read-projection contract

### 4.1 One server-owned composition, three explicit view contracts

P0 introduces one strict checked-in topology-manifest loader and one pure server-side topology composer with three bounded outputs:

```text
loadTopologyManifest(codeOwnedPath)
  -> validated, canonical, deeply frozen 22-node/22-edge runtime/data graph

composeTopologyViews({ run, source, systemTopology, incidentOverlay, events, evidence, harness })
  -> {
       architecture: { nodes, edges, totals, truncated },
       live: { nodes, edges, totals, truncated },
       diagnose: { base_graph_ref, overlay_nodes, overlay_edges, totals, truncated }
     }
```

The production caller is `stateWithSource()` in `src/server.mjs`; its inputs come from the code-owned judge manifest or explicitly configured valid source, the bounded incident bundle, actual runtime/ledger projection, bounded evidence, and checked-in harness/component metadata. No route/body/query/model/UI value can supply a node, edge, component registry, provenance ref, plane, layer, kind, status, overlay membership, or source truth.

The contract belongs in two narrow modules:

- `src/topology-manifest.mjs` for strict manifest parsing, hashing, identity normalization, and source-truth validation;
- `src/topology-projection.mjs`
- focused manifest tests in `test/topology-manifest.test.mjs`;
- focused tests in `test/topology-projection.test.mjs`

The manifest loader reads only the checked-in code-owned fixture path selected at server startup. The composer is a read-only projection utility, not an authority provider. It imports checked-in component identities internally rather than accepting a caller-defined registry. Neither module performs a ledger write, source mutation, network request, provider call, filesystem write, approval, or execution.

The deterministic judge fixture path is exact:

```text
data/topology/otel-demo-system-v1.json
```

Its semantic contract includes `schema_version`, `fixture_id`, `source_system`, `source_version`, `evidence_mode`, `execution_mode`, `captured_at`, `derivation`, `nodes`, `edges`, and `content_sha256`. `evidence_mode` is exactly `captured_fixture`; capture provenance is represented inside the bounded `derivation` record rather than a second competing truth axis. `derivation` contains only upstream/synthetic provenance, normalization version, source-input hashes, and explicit exclusion flags. It contains no local input path. Fixture nodes and edges are the exact lists in the amended specification; canonicalization sorts keys, nodes, edges, signals, and provenance refs before SHA-256.

### 4.2 Stable node contract

Each node must contain exactly:

```text
id
kind
display_class
plane
layer
label
status
source_health
provenance_refs
```

Allowed values:

```text
kind: service | deployment | dag | job | task | topic | dataset | table | query | incident
display_class: client | service | api | stream | worker | change | agent | evaluator | ledger
plane: runtime | data | control | evidence
source_health: live | stale | disconnected | unavailable
```

P0 layer IDs are code-owned and view-neutral:

```text
experience | commerce | processing | platform |
change | investigation | evaluation | evidence
```

`status` is a bounded display enum derived on the server:

```text
idle | observed | active | rejected | accepted | recording | stale | unavailable
```

Stable runtime/data IDs in the checked-in judge fixture are exact:

```text
accounting | ad | cart | checkout | currency | email | flagd | flagd-ui |
fraud-detection | frontend | frontend-proxy | frontend-web | image-provider |
kafka | load-generator | otelcol-contrib | payment | product-catalog | quote |
recommendation | shipping | telemetry-docs
```

Stable FlowPulse control/evidence IDs are:

```text
deployment | agent | evaluator | ledger
```

The 22 runtime/data IDs come from the validated sanitized topology manifest or the same strict contract populated by explicitly configured source evidence. The final four are code-owned system components whose provenance and active status are server-derived:

- `deployment`: requires bounded deployment/change evidence such as `ev-deploy-checkout`; status is observed/active only when that evidence or a canonical change event exists;
- `agent`: identity is bound to the checked-in investigator skill ID/version/hash; ledger event refs indicate participation;
- `evaluator`: identity is bound to the checked-in evaluator skill ID/version/hash; evaluator ledger refs distinguish idle, rejected, and accepted;
- `ledger`: represents the actual append-only ledger capability for this server/run and binds a safe run/event identity, never a database path or SQL detail.

The judge manifest has no collision with the four code-owned IDs, so Architecture has exactly 26 nodes and an exact 22-edge runtime dependency base. Canonical control/evidence relations are counted in a separate field because their presence depends on bounded ledger/evidence prerequisites. Other valid sources deduplicate by canonical ID before composition; a source cannot shadow or redefine a code-owned control/evidence identity. The code-owned structural identity allows a control/evidence component to appear as idle. Only canonical ledger/evidence refs may make it active, rejected, accepted, or recording. Browser constants do not supply status.

### 4.3 Stable edge contract

Each edge contains exactly:

```text
id | from | to | kind | plane | label | status | provenance_refs
```

Allowed P0 kinds:

```text
calls | publishes_to | consumes_from | affects | investigates | evaluates | records
```

The checked-in judge Live dependencies are exact and directed:

```text
cart->flagd
checkout->cart | checkout->currency | checkout->email | checkout->payment |
checkout->product-catalog | checkout->shipping
frontend->ad | frontend->cart | frontend->checkout | frontend->currency |
frontend->product-catalog | frontend->recommendation | frontend->shipping
frontend-proxy->flagd | frontend-proxy->frontend | frontend-proxy->image-provider
frontend-web->frontend-proxy
load-generator->flagd | load-generator->frontend-proxy
recommendation->product-catalog
shipping->quote
```

These are 22 unique semantic edges with 22 valid source/target pairs. Edge IDs are canonical `${from}->${to}` unless the strict manifest contract declares a stable safe ID with the same semantic tuple.

The Diagnose incident overlay is separately typed and exact:

```text
frontend->checkout
checkout->payment
checkout->kafka
kafka->accounting
kafka->fraud-detection
```

`frontend->checkout` and `checkout->payment` match observed source dependencies. The other three are incident-evidence causal relations and must not be recast as OTLP-observed dependencies. The bounded incident source alias `fraud` is normalized to `fraud-detection` before overlay membership is checked.

The Architecture graph may add only provenance-backed edges:

- `deployment-checkout` from deployment evidence;
- `agent-evaluator` when the code-owned investigation/evaluation handoff exists, with ledger refs when it has occurred;
- `evaluator-ledger` and `agent-ledger` as structural recording paths bound to checked-in component/ledger identity, with active status only from ledger rows.

Accounting and Fraud Detection may use canonical `kind=job` only when the sanitized fixture declares that evidence-backed classification. The fixture contains no database, table, query, or DAG node; `astronomy-db` may not be added from a browser layout constant. Any future data entity requires a normalized evidence envelope or equally strict source manifest in an approved source scope.

### 4.4 Determinism, validation, and bounds

`composeTopologyViews()` must:

1. Validate collection counts and serialized bytes before sorting, hashing, or graph traversal.
2. Reject unknown/extra graph fields, unsafe strings, duplicate node IDs, duplicate edge IDs, duplicate semantic edges, unknown enums, unbounded provenance, and cross-run/cross-incident refs.
3. Require every edge endpoint to exist in the same view after truncation.
4. Sort nodes by plane order, layer order, code-owned order, then ID.
5. Sort edges by plane order, from, to, kind, then ID.
6. Preserve source truth: the judge manifest is `evidence_mode=captured_fixture`, `execution_mode=deterministic_replay`, and visible label CAPTURED. Only fresh authoritative explicitly configured input may be LIVE; frozen, stale, and disconnected states remain distinct.
7. Apply IncidentProjection limits: 512/1024 input nodes/edges, 128/256 output nodes/edges, 32 provenance/evidence refs per event, and 256 KiB total projection.
8. Remove incident edges when truncation removes an endpoint and set deterministic truncation metadata.
9. Include node/edge plane, layer, status, source-health, and provenance in the IncidentProjection revision hash.
10. Return explicit unavailable/non-actionable topology on invalid input. It must not fall back to `TWIN_NODES` or captured fixture data.

`architecture` contains the 22-node runtime/data base plus four non-duplicated control/evidence nodes. `live` contains the full 22-node/22-edge source-owned runtime/data graph. `diagnose` references the same complete base and carries only the six/five overlay membership and causal edge semantics. `redactedSource()` exposes the bounded `live` view. `incident_projection.graph` exposes the composed `architecture` view, and the bounded Diagnose field exposes the overlay. All originate from the same server-owned composition result.

## 5. Small implementation tasks

Every task is a separate owner checkpoint. The implementation session must stop after recording and pushing the task commit; it must not begin the next task merely because tests are green.

### Task 0: inventory evidence and define the sanitized topology fixture contract

Goal: establish the exact 22/22 deterministic judge evidence as a bounded, reviewable artifact before changing any source, projection, server, or browser behavior.

Allowed files only:

- add `data/topology/otel-demo-system-v1.json`;
- add `docs/qa/2026-07-19-otel-demo-topology-inventory.md`;
- add `src/topology-manifest.mjs`;
- add `test/topology-manifest.test.mjs`.

Inventory procedure:

1. Set `FLOWPULSE_OTLP_CAPTURE_DIR` explicitly to an owner-authorized local synthetic OpenTelemetry Demo capture. Do not commit or record its absolute value.
2. Use the existing `LiveSource` topology projection in a read-only scratch command to write a candidate to a temporary directory outside the repository.
3. Record only input file SHA-256 values, upstream synthetic-demo identity/version, capture window, normalization version, observed node/edge counts, rejected unsafe fields, and canonical output hash in the inventory document.
4. Compare the candidate IDs/endpoints with the exact 22-node/22-edge lists in the approved spec. Any difference stops the task; do not silently edit the list or fabricate an entity.
5. Create the sanitized manifest with bounded safe topology metadata only. Review it for raw trace/log/metric bodies, IDs, operations, hostnames, paths, customer/session/local identifiers, credentials, secrets, tokens, SQL, prompts, and environment material.
6. Validate deterministic ordering, endpoint integrity, strict schema, safe fields, canonical SHA-256, and input nonmutation through `topology-manifest.mjs`.

Write these red tests first:

1. `sanitized OpenTelemetry Demo manifest contains exactly 22 stable nodes and 22 endpoint-valid dependencies`;
2. `manifest canonicalization is byte-identical across key order and repeated loads`;
3. `manifest content hash binds every node edge provenance ref truth field and derivation field`;
4. `unknown extra duplicate unsafe orphan oversized or nondeterministically ordered manifest data fails closed`;
5. `manifest excludes raw telemetry paths environment customer session local credential secret SQL prompt and provider payload fields`;
6. `captured judge manifest declares captured_fixture deterministic_replay and never live source health`;
7. `manifest contains no database table query or DAG identity absent from the evidence inventory`;
8. `object input without duplicate-aware parse proof cannot become a runtime-ready topology manifest`.

Commands:

```bash
node --test test/topology-manifest.test.mjs
node --input-type=module - <<'NODE'
import { loadTopologyManifest } from './src/topology-manifest.mjs';
const topology = loadTopologyManifest('./data/topology/otel-demo-system-v1.json');
console.log(JSON.stringify({
  fixture_id: topology.fixture_id,
  nodes: topology.nodes.length,
  edges: topology.edges.length,
  invalid_endpoints: topology.edges.filter((edge) =>
    !topology.nodes.some((node) => node.id === edge.from) ||
    !topology.nodes.some((node) => node.id === edge.to)).length,
  content_sha256: topology.content_sha256,
  evidence_mode: topology.evidence_mode,
  execution_mode: topology.execution_mode
}, null, 2));
NODE
git diff --check
git status --short
```

Acceptance:

- exact result is 22 nodes, 22 edges, zero invalid endpoints;
- fixture IDs and edge endpoint pairs exactly match the approved spec;
- every item has a bounded manifest provenance ref and deterministic order;
- `evidence_mode=captured_fixture`, `execution_mode=deterministic_replay`, current source health is unavailable/not asserted, and visible truth is CAPTURED;
- raw `outputs/live/**`, `.env*`, scratch output, databases, logs, and personal paths remain unstaged/untracked;
- no existing application or test file changes.

Commit: `test: define sanitized OTLP topology fixture`

Rollback: revert this task commit only. Do not substitute the six/five incident bundle or Daniel's untracked capture.

**Owner stop B:** report the 22 IDs, 22 endpoint pairs, fixture/content hashes, exclusion audit, exact files, and test result. Wait. No candidate isolation or wiring is authorized by a green Task 0.

### Task 1: isolate the candidate to P0

Goal: preserve useful full-topology-compatible `e4c6d87` normalization/projection work while removing its P1/P2 hunks and superseding its six-node-only display assumptions.

Allowed files:

- `public/app.js`: targeted inverse of node keyboard hunk only; do not yet change topology selection;
- `public/styles.css`: targeted inverse of the Live stroke/opacity hunk only;
- `test/twin-state.test.mjs`: remove only the matching P1/P2 assertions from the mixed candidate test.

Checks:

```bash
git diff --check
node --test test/twin-state.test.mjs
git diff --name-only
git diff --cached --name-only
```

Acceptance:

- compatible selected-source normalization/server projection hunks remain available for later amendment;
- no assertion treats six/five as the complete Architecture or Live P0 target;
- node gesture/keyboard and shared visual styling are absent from the P0 delta;
- restored `7426364` baseline behavior otherwise remains unchanged;
- only the three explicit paths are staged.

Commit: `chore: isolate full topology candidate`

Rollback: after recording the exact Task 1 commit as `TASK_1_SHA`, run `git revert "$TASK_1_SHA"` only after owner direction; never reset or amend `e4c6d87`.

**Owner stop C:** report the diff, hunk disposition, and test result. Wait.

### Task 2: define and test strict source, overlay, and view contracts

Goal: create the pure bounded topology composer and prove Architecture, Live, and Diagnose semantics before HTTP/browser wiring.

Allowed files:

- add `src/topology-projection.mjs`;
- add `test/topology-projection.test.mjs`;
- amend `src/evidence-source.mjs` only for full selected-source extraction, bound source topology hash/ref, and separate bounded incident overlay extraction;
- amend `test/evidence-source.test.mjs` only for those strict contracts;
- amend `src/topology-manifest.mjs` and `test/topology-manifest.test.mjs` only for a contract defect discovered by real composition tests.

Write these red tests first:

1. `composeTopologyViews projects 22 captured runtime/data nodes and 22 endpoint-valid Live edges deterministically`;
2. `Architecture adds exactly four non-duplicated proven control/evidence identities for an exact 26-node judge graph`;
3. `Diagnose retains the 22-node system base and exposes exactly six overlay nodes and five causal edges`;
4. `incident alias fraud canonicalizes to fraud-detection without duplicating identity`;
5. `control component identity alone is idle and ledger events alone determine active/rejected/accepted status`;
6. `captured source exposes CAPTURED truth and never claims LIVE or LAST-KNOWN`;
7. `fresh authoritative input may use LIVE while stale frozen disconnected and unavailable remain distinct`;
8. `frozen source exposes the complete bound topology only when its snapshot manifest and topology hashes match`;
9. `unknown kinds extra fields duplicate IDs semantic duplicate edges orphan endpoints unsafe refs and oversize input fail closed`;
10. `deterministic truncation removes orphaned edges and reports totals without input mutation`;
11. `unproven database table query and DAG entities are absent`;
12. `connector/provider labels cannot change node status plane provenance overlay or authority-visible output`.

Focused red/green command:

```bash
node --test \
  test/topology-manifest.test.mjs \
  test/topology-projection.test.mjs \
  test/evidence-source.test.mjs
```

Acceptance:

- pure repeated calls are byte-identical;
- normalized inputs remain unmodified and outputs are deeply frozen;
- captured Live is exactly 22 nodes/22 edges;
- Architecture is exactly 26 nodes in the deterministic judge fixture and has runtime/data/control/evidence planes;
- Diagnose overlay is exactly six nodes/five edges on the complete base;
- no authority/action/approval/verification fields exist in graph output;
- no file outside the six allowed paths changes.

Commit: `feat: define full topology projections`

Rollback: revert this task commit; Tasks 0 and 1 remain intact.

**Owner stop D:** report red-to-green evidence, output hashes/counts, changed paths, and remaining contract risks. Wait.

### Task 3: bind composition into IncidentProjection and server state

Goal: make the real backend emit the 26-node composed Architecture graph, the full selected-source 22/22 Live graph, and a separate six/five Diagnose overlay.

Allowed files:

- `src/server.mjs`;
- `src/incident-projection.mjs`;
- `test/server.test.mjs`;
- `test/incident-projection.test.mjs`;
- `test/topology-projection.test.mjs` only for a discovered contract edge case.

Exact function changes:

- `stateWithSource()`: call `composeTopologyViews()` once after bounded manifest/source/incident/evidence/ledger reads; pass `views.architecture` and `views.diagnose` to `buildIncidentProjection()` and retain `views.live` for redacted source output;
- `sourceProjection()`: select the code-owned sanitized fixture for deterministic judge replay, or an explicitly configured valid live/frozen source through the same contract; preserve topology hash/ref and truthful status without borrowing another source or using browser input;
- `redactedSource()`: serialize only the already-bounded Live view, not `incident_projection.graph`;
- `normalize()` and `graphFor()` in `src/incident-projection.mjs`: strict exact validation and safe projection of plane/layer/display class/status/source health/provenance;
- `revisionTopology()`: bind every retained graph semantic and relationship field;
- `enforceSerializedCap()`: preserve fail-closed endpoint/truncation invariants when reducing output.

Write these red server/projection tests first:

1. `server state separates 26-node Architecture 22-by-22 Live and six-by-five Diagnose overlay`;
2. `IncidentProjection graph preserves strict node and edge semantics in deterministic order`;
3. `payload-only provenance plane layer kind status or relationship drift changes projection_revision`;
4. `invalid or oversized topology becomes bounded non-actionable state before graph traversal`;
5. `redacted source excludes control/evidence nodes, raw ledger rows, facts, provider payloads, paths, SQL, prompts, and secrets`;
6. `GET state is non-mutating and graph composition adds no ledger event`;
7. `stale disconnected and unavailable source states preserve truth and never select captured fallback`;
8. `judge server starts without outputs live otel or environment topology paths and uses only the checked-in sanitized manifest`;
9. `explicit fresh configured source may replace the judge fixture through the same contract without changing authority`.

Focused command:

```bash
node --test \
  test/topology-manifest.test.mjs \
  test/topology-projection.test.mjs \
  test/evidence-source.test.mjs \
  test/incident-projection.test.mjs \
  test/server.test.mjs
```

Backend authority regression:

```bash
node --test \
  test/ledger.test.mjs \
  test/runtime.test.mjs \
  test/agent-control-service.test.mjs \
  test/incident-projection.test.mjs \
  test/server.test.mjs
```

Acceptance from `/api/state`:

```text
incident_projection.graph.nodes.length == 26
incident_projection.graph contains runtime/data/control/evidence planes
incident_projection.graph runtime/data dependency edge count == 22
control/evidence relation count is reported separately and each relation has canonical evidence
source.topology.services.length == 22
source.topology.dependencies.length == 22
every source edge endpoint exists
incident_projection.diagnose_overlay.nodes.length == 6
incident_projection.diagnose_overlay.edges.length == 5
incident_projection.diagnose_overlay.base_graph_revision == incident_projection.graph revision
incident_projection.evidence_mode == captured_fixture
incident_projection.execution_mode == deterministic_replay
source.status == captured
```

Commit: `feat: compose Architecture topology on the server`

Rollback: revert this task commit. Do not loosen IncidentProjection validation to preserve a UI state.

**Owner stop E:** report API JSON evidence, manifest/projection revisions, focused/backend results, and authority review. Wait.

### Task 4: make Architecture, Live, and Diagnose consume their explicit backend views

Goal: remove browser-owned topology meaning while preserving the accepted `7426364` shell and all non-P0 views.

Allowed files:

- `public/app.js`;
- `public/twin-state.mjs`;
- `test/twin-state.test.mjs`.

Exact function changes:

- `architectureTopology()`: read and validate `state.incident_projection.graph`; never prefer `source.topology` and never use `TWIN_NODES` as participation truth;
- `renderSourceCanvas("architecture")`: group by server-projected plane/layer and render the composed nodes; do not introduce P2 connector styling;
- `renderSourceCanvas("live")`: read only the bounded Live source view and render all 22 captured fixture dependencies; do not use `primaryLiveEdges()` to hide valid relations;
- `renderReplay()` / Diagnose topology selection: retain the complete system graph and apply only the backend-projected six-node/five-edge overlay emphasis; do not substitute the incident graph for the base;
- `captureLabel()` and `sourceOrigin()`: use one exact source-truth mapper so all visible/a11y copy says CAPTURED for deterministic fixture replay;
- `topologyIntegrity()`: validate the explicit backend shape and endpoint integrity without choosing a source or inventing fallback nodes;
- `primaryLiveEdges()`: supersede any one-incoming-edge filtering for the judge view so all 22 dependencies remain inspectable; if retained for presentation ordering, it must return every valid edge and never own topology truth.

Write these red frontend tests first:

1. `Architecture consumes IncidentProjection graph and cannot be replaced by source-only topology`;
2. `Architecture deterministic fixture has exactly 26 non-duplicated nodes across runtime data control and evidence planes`;
3. `Live consumes captured source topology with exactly 22 nodes and 22 valid visible edges`;
4. `Diagnose retains the complete graph and highlights exactly six nodes and five causal edges`;
5. `CAPTURED label is consistent in header origin drawer and aria copy`;
6. `LIVE requires fresh authoritative configured input while LAST-KNOWN STALE and UNAVAILABLE never fall back silently`;
7. `browser constants glyphs and layout cannot add nodes status provenance overlay or authority`;
8. `Architecture Live Diagnose Recovery and Compare existing state projections regress cleanly`;
9. `no browser import reaches policy registry receipt issuer authority provider executor or model tools`.

Focused command:

```bash
node --test \
  test/twin-state.test.mjs \
  test/topology-manifest.test.mjs \
  test/topology-projection.test.mjs \
  test/incident-projection.test.mjs \
  test/server.test.mjs
```

Acceptance:

- no `public/styles.css` change in this task;
- no pan, pointer, zoom, shared token, node-card, port, connector-style, group-style, or animation change;
- Architecture shows exactly 26 judge nodes, Live shows the captured 22/22 runtime projection, and Diagnose retains the full graph under the exact six/five overlay;
- Diagnose, Recovery Console, Compare, drawers, replay, and existing keyboard behavior remain at their accepted baseline/P0-isolated behavior;
- graph selection and presentation state do not mutate the ledger.

Commit: `fix: render backend-owned topology views`

Rollback: revert only this task commit; backend projection remains reviewable through API tests.

**Owner stop F:** report DOM counts, overlay counts, focused tests, changed paths, and a local review URL. Wait before final QA.

### Task 5: final P0 regression, visual evidence, and branch checkpoint

Goal: prove the complete P0 branch without changing P1/P2 or product authority.

No planned application edits. A failing check permits one bounded repair in the owning prior task’s file set, followed by a new isolated repair commit and owner report. It does not permit scope expansion.

If every check passes without a repair, do not create an empty commit: the Task 4 commit is the final P0 branch commit. Push it, verify remote SHA equality, and record that SHA as the P0 checkpoint. If a bounded repair is required, use `fix: close P0 topology acceptance gap`, stage only the owning task paths, then push and report the repair SHA.

Focused topology/projection/frontend command:

```bash
node --test \
  test/topology-manifest.test.mjs \
  test/topology-projection.test.mjs \
  test/evidence-source.test.mjs \
  test/incident-projection.test.mjs \
  test/server.test.mjs \
  test/twin-state.test.mjs
```

Backend/core regression:

```bash
node --test \
  test/ledger.test.mjs \
  test/runtime.test.mjs \
  test/agent-control-service.test.mjs \
  test/autonomy-policy.test.mjs \
  test/incident-projection.test.mjs \
  test/server.test.mjs
```

Full suite and repository checks:

```bash
npm test
npm audit --audit-level=high
git diff --check
git status --short
git diff --name-status origin/main...HEAD
```

The default `npm test` must exit naturally with its TAP summary. Do not use force-exit or pipe masking. After tests, verify that no `node --test`, `npm test`, or unintended FlowPulse test server remains.

## 6. Unique local review service and stale-port protection

Port 4333 is the historical owner-accepted `7426364` visual baseline with the full 22/22 source configured. Port 4310 is known to have served stale six-node/zero-edge state, and 4312 served the `e4c6d87` six/five review candidate. Do not use any of those existing processes as new P0 acceptance evidence. Preserve the 4333 screenshots as comparison evidence, then start the current task on a unique port.

Before starting QA:

```bash
ps -ax | rg 'node src/server\.mjs|node --test|npm test'
lsof -nP -iTCP:44312 -sTCP:LISTEN
```

If port 44312 is occupied, choose another explicit unused port and record it. Do not kill an unverified process. Start the review server with a unique temporary database:

```bash
export FLOWPULSE_REVIEW_PORT=44312
export FLOWPULSE_REVIEW_TMP=$(mktemp -d /tmp/flowpulse-p0-topology.XXXXXX)
PORT=$FLOWPULSE_REVIEW_PORT \
FLOWPULSE_DB=$FLOWPULSE_REVIEW_TMP/ledger.db \
FLOWPULSE_TOPOLOGY_SOURCE=captured_fixture \
FLOWPULSE_OTLP_DIR= \
OPENAI_API_KEY= \
node src/server.mjs
```

`FLOWPULSE_TOPOLOGY_SOURCE` is a bounded server-startup enum introduced by the approved P0 wiring. `captured_fixture` loads the code-owned `data/topology/otel-demo-system-v1.json` path internally; no caller may pass a fixture path. `otlp` is allowed only for an explicitly configured server-owned `FLOWPULSE_OTLP_DIR` and must meet source freshness/contract checks. Browser routes, query parameters, request bodies, model output, and local storage cannot select this mode.

The terminal must record the review server PID, branch, HEAD, port, database path, and startup time. Do not reuse a server started before the current task commit.

Health and API inspection commands:

```bash
curl -sS http://127.0.0.1:$FLOWPULSE_REVIEW_PORT/api/health
curl -sS http://127.0.0.1:$FLOWPULSE_REVIEW_PORT/api/state | jq '{
  run_id,
  truth: {
    source_status: .source.status,
    source_health: .incident_projection.source_health,
    evidence_mode: .incident_projection.evidence_mode,
    execution_mode: .incident_projection.execution_mode
  },
  architecture: {
    nodes: (.incident_projection.graph.nodes | length),
    edges: (.incident_projection.graph.edges | length),
    planes: ([.incident_projection.graph.nodes[].plane] | unique),
    runtime_dependencies: ([.incident_projection.graph.edges[] | select(.plane == "runtime" or .plane == "data")] | length),
    control_evidence_relations: ([.incident_projection.graph.edges[] | select(.plane == "control" or .plane == "evidence")] | length)
  },
  live: {
    nodes: (.source.topology.services | length),
    edges: (.source.topology.dependencies | length),
    endpoints: [.source.topology.dependencies[] | [.from, .to]]
  },
  diagnose: {
    overlay_nodes: (.incident_projection.diagnose_overlay.nodes | length),
    overlay_edges: (.incident_projection.diagnose_overlay.edges | length),
    base_graph_revision: .incident_projection.diagnose_overlay.base_graph_revision
  }
}'
```

Capture the raw API JSON outside the repository under the unique temporary directory. Do not commit it.

## 7. Browser QA and screenshot evidence

Use the exact unique review URL, not a pre-existing tab whose process identity is unknown:

```text
http://127.0.0.1:<FLOWPULSE_REVIEW_PORT>/
```

Required browser sequence:

1. Open the URL and verify the page process corresponds to recorded HEAD/port.
2. At 1440×900, capture Architecture, Live with active captured replay, and Diagnose with its incident overlay.
3. At 1280×800, capture Architecture, Live with active captured replay, and Diagnose with its incident overlay.
4. Inspect DOM counts, endpoint integrity, overlay membership, and the absence of duplicated identities.
5. Verify CAPTURED in visible header, node source copy, drawer/provenance copy, and accessible canvas label.
6. Open Recovery Console and Compare once each to confirm their view-specific projections do not blank/crash/regress.
7. Inspect browser console at warning and error levels.

Screenshot paths outside the repository:

```text
/tmp/flowpulse-p0-topology-qa/architecture-1440x900.png
/tmp/flowpulse-p0-topology-qa/live-captured-1440x900.png
/tmp/flowpulse-p0-topology-qa/diagnose-overlay-1440x900.png
/tmp/flowpulse-p0-topology-qa/architecture-1280x800.png
/tmp/flowpulse-p0-topology-qa/live-captured-1280x800.png
/tmp/flowpulse-p0-topology-qa/diagnose-overlay-1280x800.png
```

Required browser assertions:

```text
Architecture node count == 26
Architecture planes include runtime, data, control, evidence
Architecture runtime/data node count == 22
Architecture runtime/data dependency edge count == 22
Architecture duplicate canonical ID count == 0
Live node count == 22
Live edge count == 22
Live invalid endpoint count == 0
Diagnose base node count == 22
Diagnose overlay node count == 6
Diagnose overlay edge count == 5
at least one captured replay signal is visible during playback
no horizontal overflow at either viewport
no console warning or error
all source labels say CAPTURED, not LIVE or LAST-KNOWN
```

The implementation report must include a PASS/FAIL matrix and absolute screenshot paths. A new acceptance screenshot from stale port 4310, the historical 4333 process, candidate port 4312, an unknown process, a loading state, or an old commit is invalid. The old 4333 capture is comparison evidence only.

After QA, stop only the exact server PID started for this task. Re-run the process check and prove no task-owned server/test process remains. Do not kill unrelated processes.

**Owner stop G:** push the isolated final P0 branch checkpoint, verify its remote SHA, report the complete test/API/screenshot/console/process matrix, and wait. Do not merge, begin P1/P2, deploy, or open a second implementation checkpoint automatically.

## 8. Before/after acceptance matrix

| Requirement | Before `e4c6d87` / stale state | Candidate `e4c6d87` | P0 required after |
| --- | --- | --- | --- |
| Architecture meaning | `7426364` at 4333 proves the full 22/22 runtime graph, but source selection can replace it | Six incident nodes replace product/system graph | Backend-composed exact 26-node judge graph: 22 proven runtime/data plus four non-duplicated control/evidence entities in separate layers |
| Architecture provenance | Browser constants carry product identity | Source-only nodes have limited semantics | Every node/edge has server-owned safe provenance and honest status |
| Live captured topology | Accepted 4333 baseline showed 22 nodes/22 edges; stale 4310 showed six/zero | Candidate shows six/five incident graph | Exact 22-node/22-edge sanitized runtime graph, deterministically ordered and endpoint-valid |
| Diagnose incident context | Six/five incident graph exists as the only selected replay topology | Six/five can replace the complete graph | Complete system base remains visible; exactly six nodes/five causal edges are overlaid/highlighted with distinct evidence semantics |
| Source label | Could imply last-known/live OTLP | Header says captured but other copy may disagree | CAPTURED everywhere for deterministic fixture; LIVE/LAST-KNOWN/UNAVAILABLE exact and mutually exclusive |
| Extra data entities | Layout constants include identities not observed in the 22-node capture | None added by candidate | Exact sanitized manifest only; no `astronomy-db`, table, query, DAG, or additional entity without normalized evidence |
| Browser authority | Existing projection boundary | No intended authority change | Browser remains read-only; no topology, risk, approval, execution, or verification inference |
| Other views | Owner-accepted `7426364`/4333 behavior | Candidate includes unrelated keyboard/style hunks | Diagnose overlay, Recovery Console, Compare, drawer, replay, and baseline shell regress cleanly; P1/P2 changes absent |

P0 is not accepted merely because counts pass. Plane/layer semantics, provenance, labels, endpoint integrity, truncation, browser behavior, and authority regression must all pass.

## 9. Commit, push, rollback, and owner gates

For every task:

1. Record HEAD/status/fingerprints.
2. Write the named red tests and prove they fail for the intended missing behavior.
3. Implement only the allowed file set.
4. Run the focused and required regression commands.
5. Run `git diff --check`.
6. Verify unrelated dirty fingerprints are byte-identical.
7. Stage explicit paths only and inspect:

```bash
git diff --cached --name-only
git diff --cached --check
git diff --cached
```

8. Commit with the task’s exact message.
9. Push only `codex/topology-live-integration`.
10. Verify the remote SHA with:

```bash
git rev-parse HEAD
git ls-remote --heads origin codex/topology-live-integration
```

11. Stop and wait for Daniel.

Rollback rules:

- assign the exact recorded task commit to `TASK_SHA` and use a normal `git revert "$TASK_SHA"` only after owner direction;
- never reset, clean, amend `e4c6d87`, force-push, rewrite mainline history, or discard user work;
- if one task fails, revert or repair that task only; do not roll back the approved backend authority chain;
- if P0 cannot meet its contract without P1/P2, a connector, or invented evidence, stop and report the blocker.

Final P0 branch checkpoint:

- all task commits are isolated and pushed;
- `origin/main` is unchanged;
- remote branch SHA equals local HEAD;
- only expected `state/` generated artifacts remain untracked;
- no merge or pull request merge occurs;
- Daniel receives the API evidence, test counts, screenshots, console result, diff scope, residual limitations, and exact recommendation for P0 approval or repair.

## 10. Deferred non-goals

P0 explicitly excludes:

- P1 pan-from-node/edge behavior, movement thresholds, pointer-capture changes, zoom behavior, or gesture redesign;
- P2 node/port/group/edge/label/join visual unification, new graph tokens, reference-image styling, edge contrast redesign, or theme work;
- a new graph framework, layout dependency, vendor SDK, or connector;
- a new production OTLP, database, warehouse, Kafka, Airflow, OpenLineage, or provider connector; the existing read-only OTLP source may populate the same contract only when explicitly configured and validated;
- invented database, table, query, DAG, job, consumer, topic, or service identities beyond the exact sanitized 22-node fixture or another approved normalized source;
- committing raw `outputs/live/**`, `.env*`, traces, logs, metrics, personal paths, customer identifiers, credentials, or secrets;
- approval, reject, defer, repair, executor, verification, receipt, policy, or authority changes;
- Devpost, Session ID, README marketing, video, deployment, submission, merge to main, or push to main;
- a broad frontend rewrite or three-stage shell migration.

## 11. Plan acceptance and next gate

This plan is ready for P0 execution only if Daniel confirms:

1. the exact sanitized 22-node/22-edge fixture inventory and its code-owned `data/topology/otel-demo-system-v1.json` path;
2. the `e4c6d87` hunk dispositions, including superseding every six-node-only display assumption and targeted reversion of keyboard/style changes;
3. the three-view contract: exact 26-node composed Architecture in `incident_projection.graph`, exact 22/22 selected-source Live topology, and exact six/five Diagnose overlay on the complete base;
4. the four control/evidence identities and their allowed provenance/status rules;
5. the per-task stop/commit/push cadence;
6. use of the accepted `7426364`/4333 rendering only as comparison and a unique current review port for acceptance;
7. that no P1/P2 work may begin after P0 without a new owner-approved plan.

After approval, the first implementation session is authorized for **Task 0 only: data/evidence inventory plus sanitized topology-fixture contract**. It must stop after its isolated fixture-contract commit and owner report. It must not change `e4c6d87`, evidence-source selection, IncidentProjection, server, frontend, P1, or P2. Task 1 and every later task require a fresh explicit owner instruction.

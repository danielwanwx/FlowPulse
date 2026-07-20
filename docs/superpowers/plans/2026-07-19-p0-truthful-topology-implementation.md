# P0 truthful topology composition implementation plan

Status: plan-only checkpoint; implementation starts only after Daniel approves this document

Date: 2026-07-19

Approved specification: `docs/superpowers/specs/2026-07-19-topology-live-graph-system-design.md` at `79224a985c4755ecb3c57fbffb69cf2264c2210e`

Review branch: `codex/topology-live-integration`

Candidate under audit: `e4c6d87e41a074944f8358128e012ef72dec1a08`

Mainline boundary: preserve `origin/main`; do not merge, rebase, force-push, deploy, or modify Devpost

Scope: P0 topology semantics and read-only Architecture/Live integration only. P1 gesture arbitration and P2 shared visual styling are deferred non-goals.

## 1. P0 loop contract

| Element | Contract |
| --- | --- |
| Goal | Make Architecture render the backend-composed system graph it can prove, while Live renders the selected captured runtime graph, without giving the browser topology or authority ownership. |
| Input scope | Selected captured source topology, bounded evidence summaries, canonical ledger events, checked-in investigator/evaluator identities, actual append-only ledger capability, IncidentProjection v1, baseline `7426364`, and candidate `e4c6d87`. |
| Execute | Audit/isolate candidate hunks; normalize source topology; compose Architecture graph; validate/project it through IncidentProjection/server; switch browser views to the correct backend-owned projections; perform contract and visual QA. |
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

This audit is the first implementation checkpoint. Apply no code change until Daniel confirms the disposition table.

| File / hunk | Candidate behavior | Classification | P0 disposition |
| --- | --- | --- | --- |
| `src/evidence-source.mjs` / `CapturedBundleEvidenceSource.captureTopology` and `.topology()` | Exposes the six captured services and five fixture edges | **Amend** | Keep the selected-source concept, but produce strict stable IDs, canonical `kind`, `display_class`, `plane`, `layer`, source status, and a source-manifest provenance ref. Do not treat every fixture node as generic `service`. |
| `src/evidence-source.mjs` / `LiveOtlpEvidenceSource.topology()` | Normalizes the current OTLP topology | **Amend** | Keep the method, but use the same strict source-topology contract and truthful LIVE/LAST-KNOWN/UNAVAILABLE metadata. No vendor or database node is synthesized. |
| `src/evidence-source.mjs` / `FrozenEvidenceSnapshot.topology()` returning empty | Avoids inventing a frozen topology | **Amend** | Keep fail-closed behavior. A frozen snapshot may expose topology only if its server-owned capture recorded and bound one; otherwise topology remains unavailable. No fallback to fixture topology. |
| `src/evidence-source.mjs` / `capturedTopology()` and `sourceTopology()` helpers | Filters missing endpoints and freezes arrays | **Amend** | Move strict reusable validation/composition responsibility into the P0 topology module; retain only source-specific extraction here. Add duplicate/semantic-edge/bounds/provenance checks. |
| `src/server.mjs` / `sourceProjection()` selects `selected.topology()` | Correctly stops captured replay from using unrelated collector topology | **Reuse + amend** | Preserve selection. Add exact source-view fields and a bound source topology hash/ref. Captured remains CAPTURED, never LIVE or LAST-KNOWN. |
| `src/server.mjs` / `stateWithSource()` passes `sourceState.topology` directly to IncidentProjection | Gives IncidentProjection the six-node source graph | **Amend** | Replace the direct pass with the server-owned Architecture composition. Keep source topology separately for Live. |
| `src/server.mjs` / `redactedSource()` derives source topology from `projection.graph` | Causes one graph shape to serve incompatible Architecture and Live meanings | **Amend** | Redact the selected bounded source topology for Live and expose composed Architecture through `incident_projection.graph`. Do not leak raw events/evidence/provider data. |
| `src/incident-projection.mjs` / existing `graphFor()` | Caps and redacts nodes/edges but drops plane/layer/provenance fields | **Amend** | Strictly validate and preserve P0 graph fields, include them in revision binding, deterministically truncate, and fail closed on invalid endpoints/duplicates/unknown enums. |
| `public/twin-state.mjs` / `topologyIntegrity()` accepts both `nodes/edges` and `services/dependencies` | Bridges two browser shapes | **Amend** | Keep endpoint normalization temporarily only where the explicit backend view contract requires it. Tests must enforce Architecture from `incident_projection.graph` and Live from bounded source topology; no ambiguous fallback chain. |
| `public/app.js` / `architectureTopology()` normalizes `source.topology` and returns it when nonempty | Hides Deployment, Investigator, Evaluator, and Evidence Ledger | **Amend / supersede** | Read the composed `incident_projection.graph`. Never replace Architecture with source-only topology or use `TWIN_NODES` to claim active participation. |
| `public/app.js` / captured branch in `captureLabel()` | Top header says Captured replay | **Reuse + amend** | Centralize source-label mapping so header, node origin, detail drawer, and accessibility copy all agree on CAPTURED. Correct the remaining `sourceOrigin()` LAST-KNOWN wording for captured replay. |
| `public/app.js` / node handling added to `handleCanvasKeydown()` | Adds node Enter/Space drawer behavior | **Revert from P0; defer to P1/accessibility work** | Apply a targeted inverse in the first implementation commit so P0 does not carry an unreviewed interaction change. Preserve the hunk reference for the later P1 plan. |
| `public/styles.css` / stronger Live edge stroke/opacity | Changes graph visual styling | **Revert from P0; defer to P2** | Restore baseline style in the P0 isolation commit. If baseline edges cannot provide P0 functional evidence, stop for Daniel instead of starting P2 styling. |
| `test/evidence-source.test.mjs` / six-node/five-edge test | Proves deterministic captured topology | **Amend** | Retain count and edge assertions; add canonical fields, provenance, bounds, input nonmutation, duplicate/invalid-edge rejection, and no authority fields. |
| `test/server.test.mjs` / source and IncidentProjection both expected as six/five | Confates Architecture graph with Live source graph | **Amend** | Assert source Live projection is exactly six/five and `incident_projection.graph` is the composed Architecture graph with at least ten proven nodes and explicit planes. |
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

### 4.1 One server-owned composition, two explicit views

P0 introduces one pure server-side topology composer with two bounded outputs:

```text
composeTopologyViews({ run, source, sourceTopology, events, evidence, harness })
  -> {
       architecture: { nodes, edges, totals, truncated },
       live: { nodes, edges, totals, truncated }
     }
```

The production caller is `stateWithSource()` in `src/server.mjs`; its inputs come from the selected source, actual runtime/ledger projection, bounded evidence, and checked-in harness/component metadata. No route/body/query/model/UI value can supply a node, edge, component registry, provenance ref, plane, layer, kind, status, or source truth.

The composer belongs in a narrow new module:

- `src/topology-projection.mjs`
- focused tests in `test/topology-projection.test.mjs`

It is a read-only projection utility, not an authority provider. It imports checked-in component identities internally rather than accepting a caller-defined registry. It performs no ledger write, source mutation, network request, provider call, filesystem write, approval, or execution.

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
entry | commerce | processing | async | change | investigation | evaluation | evidence
```

`status` is a bounded display enum derived on the server:

```text
idle | observed | active | rejected | accepted | recording | stale | unavailable
```

Stable P0 IDs are:

```text
frontend | checkout | payment | kafka | accounting | fraud |
deployment | agent | evaluator | ledger
```

The first six come from the selected captured source topology. The final four are code-owned system components whose provenance and active status are server-derived:

- `deployment`: requires bounded deployment/change evidence such as `ev-deploy-checkout`; status is observed/active only when that evidence or a canonical change event exists;
- `agent`: identity is bound to the checked-in investigator skill ID/version/hash; ledger event refs indicate participation;
- `evaluator`: identity is bound to the checked-in evaluator skill ID/version/hash; evaluator ledger refs distinguish idle, rejected, and accepted;
- `ledger`: represents the actual append-only ledger capability for this server/run and binds a safe run/event identity, never a database path or SQL detail.

The code-owned structural identity allows a control/evidence component to appear as idle. Only canonical ledger/evidence refs may make it active, rejected, accepted, or recording. Browser constants do not supply status.

### 4.3 Stable edge contract

Each edge contains exactly:

```text
id | from | to | kind | plane | label | status | provenance_refs
```

Allowed P0 kinds:

```text
calls | publishes_to | consumes_from | affects | investigates | evaluates | records
```

The captured Live edges are exact and directed:

```text
frontend-checkout
checkout-payment
checkout-kafka
kafka-accounting
kafka-fraud
```

The Architecture graph may add only provenance-backed edges:

- `deployment-checkout` from deployment evidence;
- `agent-evaluator` when the code-owned investigation/evaluation handoff exists, with ledger refs when it has occurred;
- `evaluator-ledger` and `agent-ledger` as structural recording paths bound to checked-in component/ledger identity, with active status only from ledger rows.

Accounting and Fraud may use canonical `kind=job` because the captured fixture contains consumer evidence for both. No P0 test requires a database, table, query, DAG, or additional job node. Those entities remain absent unless a normalized evidence envelope proves them in an approved source scope.

### 4.4 Determinism, validation, and bounds

`composeTopologyViews()` must:

1. Validate collection counts and serialized bytes before sorting, hashing, or graph traversal.
2. Reject unknown/extra graph fields, unsafe strings, duplicate node IDs, duplicate edge IDs, duplicate semantic edges, unknown enums, unbounded provenance, and cross-run/cross-incident refs.
3. Require every edge endpoint to exist in the same view after truncation.
4. Sort nodes by plane order, layer order, code-owned order, then ID.
5. Sort edges by plane order, from, to, kind, then ID.
6. Preserve source truth: captured fixture is `evidence_mode=captured_fixture`, `execution_mode=deterministic_replay`, and visible label CAPTURED.
7. Apply IncidentProjection limits: 512/1024 input nodes/edges, 128/256 output nodes/edges, 32 provenance/evidence refs per event, and 256 KiB total projection.
8. Remove incident edges when truncation removes an endpoint and set deterministic truncation metadata.
9. Include node/edge plane, layer, status, source-health, and provenance in the IncidentProjection revision hash.
10. Return explicit unavailable/non-actionable topology on invalid input. It must not fall back to `TWIN_NODES` or captured fixture data.

`architecture` contains the composed system view. `live` contains only source-owned runtime/data nodes and dependencies. `redactedSource()` exposes the bounded `live` view. `incident_projection.graph` exposes the composed `architecture` view. Both originate from the same server-owned composition result.

## 5. Small implementation tasks

Every task is a separate owner checkpoint. The implementation session must stop after recording and pushing the task commit; it must not begin the next task merely because tests are green.

### Task 0: isolate the candidate to P0

Goal: preserve useful `e4c6d87` work while removing its P1/P2 hunks from the active P0 candidate.

Allowed files:

- `public/app.js`: targeted inverse of node keyboard hunk only;
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

- selected-source topology, server projection, and captured label hunks remain;
- node gesture/keyboard and shared visual styling are absent from the P0 delta;
- restored baseline frontend behavior otherwise remains unchanged;
- only the three explicit paths are staged.

Commit: `chore: isolate truthful topology candidate`

Rollback: `git revert <task-0-sha>` only after owner direction; never reset or amend `e4c6d87`.

**Owner stop B:** report the diff and test result. Wait.

### Task 1: define and test the strict source and view contracts

Goal: create the pure bounded topology composer and prove its two views before HTTP/browser wiring.

Allowed files:

- add `src/topology-projection.mjs`;
- add `test/topology-projection.test.mjs`;
- amend `src/evidence-source.mjs` only for selected source topology extraction and bound source topology hash/ref;
- amend `test/evidence-source.test.mjs` only for the strict source contract.

Write these red tests first:

1. `composeTopologyViews projects six captured runtime/data nodes and five endpoint-valid Live edges deterministically`;
2. `Architecture adds exactly the four proven control/evidence identities with safe provenance`;
3. `control component identity alone is idle and ledger events alone determine active/rejected/accepted status`;
4. `captured source exposes CAPTURED truth and never claims LIVE or LAST-KNOWN`;
5. `unknown kinds, extra fields, duplicate IDs, semantic duplicate edges, orphan endpoints, unsafe refs, and oversize input fail closed`;
6. `deterministic truncation removes orphaned edges and reports totals without input mutation`;
7. `unproven database table query dag and additional job entities are absent`;
8. `connector/provider labels cannot change node status, plane, provenance, or authority-visible output`.

Focused red/green command:

```bash
node --test test/topology-projection.test.mjs test/evidence-source.test.mjs
```

Acceptance:

- pure repeated calls are byte-identical;
- normalized inputs remain unmodified and outputs are deeply frozen;
- captured Live is exactly six nodes/five edges;
- Architecture is at least ten nodes in the deterministic judge fixture and has runtime/data/control/evidence planes;
- no authority/action/approval/verification fields exist in graph output;
- no file outside the four allowed paths changes.

Commit: `feat: define truthful topology projections`

Rollback: revert this task commit; Task 0 remains intact.

**Owner stop C:** report red-to-green evidence, output hashes/counts, changed paths, and remaining contract risks. Wait.

### Task 2: bind composition into IncidentProjection and server state

Goal: make the real backend emit a composed Architecture graph and a separate selected-source Live graph.

Allowed files:

- `src/server.mjs`;
- `src/incident-projection.mjs`;
- `test/server.test.mjs`;
- `test/incident-projection.test.mjs`;
- `test/topology-projection.test.mjs` only for a discovered contract edge case.

Exact function changes:

- `stateWithSource()`: call `composeTopologyViews()` once after bounded source/evidence/ledger reads; pass `views.architecture` to `buildIncidentProjection()` and retain `views.live` for redacted source output;
- `sourceProjection()`: preserve the selected source, topology hash/ref, and truthful status without substituting unrelated collector data;
- `redactedSource()`: serialize only the already-bounded Live view, not `incident_projection.graph`;
- `normalize()` and `graphFor()` in `src/incident-projection.mjs`: strict exact validation and safe projection of plane/layer/display class/status/source health/provenance;
- `revisionTopology()`: bind every retained graph semantic and relationship field;
- `enforceSerializedCap()`: preserve fail-closed endpoint/truncation invariants when reducing output.

Write these red server/projection tests first:

1. `server state separates composed Architecture graph from captured Live source graph`;
2. `IncidentProjection graph preserves strict node and edge semantics in deterministic order`;
3. `payload-only provenance plane layer kind status or relationship drift changes projection_revision`;
4. `invalid or oversized topology becomes bounded non-actionable state before graph traversal`;
5. `redacted source excludes control/evidence nodes, raw ledger rows, facts, provider payloads, paths, SQL, prompts, and secrets`;
6. `GET state is non-mutating and graph composition adds no ledger event`;
7. `stale disconnected and unavailable source states preserve truth and never select captured fallback`.

Focused command:

```bash
node --test \
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
incident_projection.graph.nodes.length >= 10
incident_projection.graph contains runtime/data/control/evidence planes
source.topology.services.length == 6
source.topology.dependencies.length == 5
every source edge endpoint exists
incident_projection.evidence_mode == captured_fixture
incident_projection.execution_mode == deterministic_replay
source.status == captured
```

Commit: `feat: compose Architecture topology on the server`

Rollback: revert this task commit. Do not loosen IncidentProjection validation to preserve a UI state.

**Owner stop D:** report API JSON evidence, projection revision, focused/backend results, and authority review. Wait.

### Task 3: make Architecture and Live consume their explicit backend views

Goal: remove browser-owned topology meaning while preserving the accepted `7426364` shell and all non-P0 views.

Allowed files:

- `public/app.js`;
- `public/twin-state.mjs`;
- `test/twin-state.test.mjs`.

Exact function changes:

- `architectureTopology()`: read and validate `state.incident_projection.graph`; never prefer `source.topology` and never use `TWIN_NODES` as participation truth;
- `renderSourceCanvas("architecture")`: group by server-projected plane/layer and render the composed nodes; do not introduce P2 connector styling;
- `renderSourceCanvas("live")`: read only the bounded Live source view and render all five captured fixture dependencies;
- `captureLabel()` and `sourceOrigin()`: use one exact source-truth mapper so all visible/a11y copy says CAPTURED for deterministic fixture replay;
- `topologyIntegrity()`: validate the explicit backend shape and endpoint integrity without choosing a source or inventing fallback nodes;
- `primaryLiveEdges()`: for the captured judge topology, preserve all five edges; any future filtering must be labelled and expose full bounded counts.

Write these red frontend tests first:

1. `Architecture consumes IncidentProjection graph and cannot be replaced by source-only topology`;
2. `Architecture deterministic fixture has at least ten nodes across four planes`;
3. `Live consumes only captured source topology with exactly six nodes and five valid edges`;
4. `CAPTURED label is consistent in header origin drawer and aria copy`;
5. `LAST-KNOWN and UNAVAILABLE remain distinct and never fall back to captured data`;
6. `browser constants glyphs and layout cannot add nodes status provenance or authority`;
7. `Architecture Live Diagnose Recovery and Compare existing state projections regress cleanly`;
8. `no browser import reaches policy registry receipt issuer authority provider executor or model tools`.

Focused command:

```bash
node --test \
  test/twin-state.test.mjs \
  test/topology-projection.test.mjs \
  test/incident-projection.test.mjs \
  test/server.test.mjs
```

Acceptance:

- no `public/styles.css` change in this task;
- no pan, pointer, zoom, shared token, node-card, port, connector-style, group-style, or animation change;
- Architecture shows the composed projection and Live shows the captured runtime projection;
- Diagnose, Recovery Console, Compare, drawers, replay, and existing keyboard behavior remain at their accepted baseline/P0-isolated behavior;
- graph selection and presentation state do not mutate the ledger.

Commit: `fix: render backend-owned topology views`

Rollback: revert only this task commit; backend projection remains reviewable through API tests.

**Owner stop E:** report DOM counts, focused tests, changed paths, and a local review URL. Wait before final QA.

### Task 4: final P0 regression, visual evidence, and branch checkpoint

Goal: prove the complete P0 branch without changing P1/P2 or product authority.

No planned application edits. A failing check permits one bounded repair in the owning prior task’s file set, followed by a new isolated repair commit and owner report. It does not permit scope expansion.

Focused topology/projection/frontend command:

```bash
node --test \
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

Port 4310 is known to have served stale six-node/zero-edge state. Do not use it for P0 acceptance.

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
OPENAI_API_KEY= \
node src/server.mjs
```

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
    planes: ([.incident_projection.graph.nodes[].plane] | unique)
  },
  live: {
    nodes: (.source.topology.services | length),
    edges: (.source.topology.dependencies | length),
    endpoints: [.source.topology.dependencies[] | [.from, .to]]
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
2. At 1440×900, capture Architecture and Live with active captured replay.
3. At 1280×800, capture Architecture and Live with active captured replay.
4. Inspect DOM counts and endpoint integrity.
5. Verify CAPTURED in visible header, node source copy, drawer/provenance copy, and accessible canvas label.
6. Open Diagnose, Recovery Console, and Compare once each to confirm no blank/crash/regression.
7. Inspect browser console at warning and error levels.

Screenshot paths outside the repository:

```text
/tmp/flowpulse-p0-topology-qa/architecture-1440x900.png
/tmp/flowpulse-p0-topology-qa/live-captured-1440x900.png
/tmp/flowpulse-p0-topology-qa/architecture-1280x800.png
/tmp/flowpulse-p0-topology-qa/live-captured-1280x800.png
```

Required browser assertions:

```text
Architecture node count >= 10
Architecture planes include runtime, data, control, evidence
Live node count == 6
Live edge count == 5
Live invalid endpoint count == 0
at least one captured replay signal is visible during playback
no horizontal overflow at either viewport
no console warning or error
all source labels say CAPTURED, not LIVE or LAST-KNOWN
```

The implementation report must include a PASS/FAIL matrix and absolute screenshot paths. A screenshot from port 4310, an unknown process, a loading state, or an old commit is invalid evidence.

After QA, stop only the exact server PID started for this task. Re-run the process check and prove no task-owned server/test process remains. Do not kill unrelated processes.

## 8. Before/after acceptance matrix

| Requirement | Before `e4c6d87` / stale state | Candidate `e4c6d87` | P0 required after |
| --- | --- | --- | --- |
| Architecture meaning | Product fallback exists, but source topology can replace it | Six source nodes replace product graph | Backend-composed system graph with at least ten proven entities and visible runtime/data/control/evidence distinction |
| Architecture provenance | Browser constants carry product identity | Source-only nodes have limited semantics | Every node/edge has server-owned safe provenance and honest status |
| Live captured topology | Stale port showed six nodes/zero edges | Six nodes/five edges | Exactly six nodes/five endpoint-valid edges, deterministically ordered |
| Source label | Could imply last-known/live OTLP | Header says captured but other copy may disagree | CAPTURED everywhere for deterministic fixture; LIVE/LAST-KNOWN/UNAVAILABLE exact and mutually exclusive |
| Extra data entities | No evidence-backed database/table/job expansion | None added | None fabricated; Accounting/Fraud are evidence-backed consumers, while databases/tables/queries/DAGs/additional jobs require their own evidence |
| Browser authority | Existing projection boundary | No intended authority change | Browser remains read-only; no topology, risk, approval, execution, or verification inference |
| Other views | Accepted `7426364` behavior | Candidate includes unrelated keyboard/style hunks | Diagnose, Recovery Console, Compare, drawer, replay, and baseline shell regress cleanly; P1/P2 changes absent |

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

- use a normal `git revert <task-sha>` only after owner direction;
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
- live production OTLP, database, warehouse, Kafka, Airflow, OpenLineage, or provider integration;
- invented database, table, query, DAG, additional job, consumer, topic, or service entities beyond the six evidence-backed captured components;
- approval, reject, defer, repair, executor, verification, receipt, policy, or authority changes;
- Devpost, Session ID, README marketing, video, deployment, submission, merge to main, or push to main;
- a broad frontend rewrite or three-stage shell migration.

## 11. Plan acceptance and next gate

This plan is ready for P0 execution only if Daniel confirms:

1. the `e4c6d87` hunk dispositions, including targeted reversion of keyboard and style changes;
2. the two-view contract: composed Architecture in `incident_projection.graph`, selected source Live topology in `source.topology`;
3. the four control/evidence identities and their allowed provenance/status rules;
4. the per-task stop/commit/push cadence;
5. use of a unique review port instead of stale 4310;
6. that no P1/P2 work may begin after P0 without a new owner-approved plan.

After approval, the first implementation session is authorized for **Task 0 only**. It must stop after the isolated candidate-scope commit and owner report. Task 1 and every later task require a fresh explicit owner instruction.

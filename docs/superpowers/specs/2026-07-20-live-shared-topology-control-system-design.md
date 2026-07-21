# FlowPulse shared Architecture-to-Live topology and Control System

**Status:** Owner-approved design checkpoint. This document defines a staged integration only; it does not authorize implementation beyond the review gates below.

**Branch context:** `codex/frontend-architecture-polish` after `73ff745c46d657ee9d23f7edb137d815ee5982ca`.

**Scope:** The Architecture and Live relationship, their backend-owned topology read models, and the FlowPulse Control System identity correction. Diagnose, Recovery Console, Compare, real remediation, deployment, and the demo lifecycle are out of scope.

## 1. Decision and loop boundary

Architecture and Live are two modes of one canonical workspace, not two disconnected product pages. Architecture is the quiet structural view: four technical stack layers containing the canonical observed components. Live is the operating view of those same components: the layer containers relax into one runtime canvas, backend-projected dependencies become visible, and truthful traffic or incident activity is animated.

This work follows five independently reviewable implementation stages. Each stage stops after its own tests and browser evidence. No stage implicitly authorizes the next one.

| Loop element | Decision |
| --- | --- |
| Goal | Preserve one identity-bearing observed topology while making Architecture structurally scannable and Live operationally legible. |
| Inputs | Sanitized 22-node manifest with 26 captured OTLP `calls` dependencies and seven typed evidence-grounded supporting relations, `IncidentProjection v1`, append-only ledger projections, source truth axes, bounded agent-control projection, and existing demo lifecycle frames. |
| Owner | Server projections and ledger-derived truth own identity, source state, gate state, evidence, and readiness. The browser owns only presentation, local focus, and motion timing. |
| Output | A strict, bounded topology read model that tells the browser exactly what to render in Architecture and Live, plus a five-capability FlowPulse control read model. |
| Stop rule | Stop for owner review after stages A, B, C, D, and E. Do not convert this document into UI-only assumed truth. |

## 2. Current evidence and the correction

The checked-in sanitized OTEL Demo manifest is the complete observed runtime/data system: **22 stable nodes, 26 endpoint-valid captured OTLP `calls` dependencies, and seven typed supporting relations**. Supporting relations are declared async dependencies, configured routes, or telemetry exports, each grounded in bounded capture and code provenance; they are not promoted to fabricated live-call traffic. `src/topology-projection.mjs` exposes this model through `composeTopologyViews`; `/api/state` and `/api/source` return the same bounded topology view from `src/server.mjs`.

| Current ID | Current label | Correction |
| --- | --- | --- |
| `deployment` | Deployment | Remove from the persistent FlowPulse Control System. It is an external observed-change evidence record only when a real bounded deployment evidence record exists. |
| `agent` | Investigator | Migrate the display identity to stable `investigator`; retain ledger/event compatibility only in server-side projection mapping. |
| `evaluator` | Evaluator | Keep as the quality-gate capability, not an owner-approval capability. |
| `ledger` | Evidence Ledger | Keep as the immutable-provenance capability. |

The current control array is incomplete because it omits source observation and workflow orchestration. It also gives an external change record the misleading appearance of a persistent FlowPulse runtime component. The target Control System has exactly these five canonical capabilities:

1. **Observer** — bounded connector, OTEL, log, metric, and change-evidence intake; source freshness/connectivity and incident-signal observation.
2. **Orchestrator** — server-owned workflow-stage progression and task dispatch; it may invoke agents or request a human gate but does not grant approval.
3. **Investigator** — evidence collection, cited hypotheses, tests, and bounded replanning; no repair or approval authority.
4. **Evaluator** — adversarial causal-evidence and remediation-quality assessment; acceptance/rejection is not owner approval.
5. **Evidence Ledger** — append-only events, provenance, evaluations, approvals, verification records, and replay record integrity.

Deployment evidence is not a sixth control node. A deployment record may appear as a bounded external-change evidence marker associated with the evidence-grounded observed component IDs it affects, such as `checkout`. It must not be rendered if such evidence is absent, stale without an explicit stale state, malformed, or out of scope.

## 3. Canonical identities, ownership, and backend mapping

### 3.1 Identity rules

| Domain | Stable identities | Owner | Browser prohibition |
| --- | --- | --- | --- |
| Observed system | The 22 IDs in `data/topology/otel-demo-system-v1.json` | Sanitized topology manifest and server projection | Do not create, deduplicate by label, rename for authority, or replace with compatibility `source.topology`. |
| Runtime dependencies | The 26 captured `calls` IDs and seven typed supporting-relation IDs | Manifest plus `composeTopologyViews` | Do not infer missing paths, call traffic, or causal edges. |
| Incident overlay | The bounded six node/five relation overlay | `IncidentProjection v1` and server projection | Do not turn a selected or animated node into incident truth. |
| Control System | `observer`, `orchestrator`, `investigator`, `evaluator`, `ledger` | Server-side composition from canonical sources below | Do not add a control capability or infer control status from display state. |
| Deployment change evidence | Actual bounded evidence/ledger record IDs | Server projection | Never turn it into a durable node, arbitrary client arrow, or a claim that a production deployment occurred. |

Every identity is carried as an immutable `id` in the topology projection and as a `data-topology-node-id` or `data-control-node-id` in the DOM. Display labels are safe bounded presentation fields and never keys.

### 3.2 Current implementation sources for the five capabilities

| Target capability | Existing implementation and evidence | Allowed projected facts | Authority boundary |
| --- | --- | --- | --- |
| Observer | `src/live-source.mjs`, `src/evidence-source.mjs`, `src/evidence-envelope.mjs`, `src/connector-manifest.mjs`, and server source projection | source health, freshness, capture mode, bounded evidence/signal counts and safe provenance references | Inputs can propose evidence only; no incident, approval, execution, or verification is minted. |
| Orchestrator | `src/agent-control-service.mjs`, `src/agent-team-harness.mjs`, `src/runtime.mjs`, and bounded `agent_control` projection from `src/server.mjs` | canonical stage, dispatch state, a safe current activity summary, sequence/timestamp when present | It coordinates from ledger/runtime truth; the browser cannot advance a stage by selecting a node. |
| Investigator | `src/development-runtime.mjs`, `src/agent-team-harness.mjs`, `src/runtime.mjs`, and `src/incident-projection.mjs` | investigation state, bounded cited evidence references, hypothesis/replan state when canonically projected | It stops before Owner Gate closure and cannot execute repair. |
| Evaluator | `src/autonomy-policy.mjs`, `src/agent-team-harness.mjs`, `src/runtime.mjs`, and `src/incident-projection.mjs` | canonical evaluator/gate verdict, bounded reason category, evidence count/references | Evaluation does not mean human approval and cannot authorize repair. |
| Evidence Ledger | `src/ledger.mjs`, `src/server.mjs`, `src/incident-projection.mjs` | immutable event count, latest bounded sequence, integrity/availability result, safe provenance references | Ledger is append-only server persistence. Browser display cannot append, verify, or issue receipts. |

The current agent-control graph has lower-level role IDs such as `manager`, `monitor`, `evidence`, `diagnosis`, and `evaluator`. The five Control System identities are a bounded *read-model grouping*, not a replacement for those ledger event IDs or a rewrite of the agent harness. Stage A maps `monitor`/source intake to `observer`, manager/coordinator dispatch to `orchestrator`, diagnosis/investigation to `investigator`, evaluator to `evaluator`, and ledger persistence to `ledger`.

### 3.3 Target strict projection envelope

The existing `flowpulse.topology-views.v1` schema has a strict Architecture object of `graph`, `runtime_data`, and `control_evidence`. It mixes observed and control nodes and therefore cannot represent this correction without an explicit contract revision. Stage A introduces **`flowpulse.topology-views.v2`** atomically in server and strict browser parser; it must not loosen v1 validation or silently reinterpret a v1 payload.

The target bounded shape is:

```text
topology_views = {
  schema_version: "flowpulse.topology-views.v2",
  projection_revision,
  run_id,
  incident_id,
  truth,
  readiness,
  architecture: {
    runtime_data: { graph: { nodes: [22], edges: [26] }, node_count: 22, edge_count: 26, supporting_relations: [7], supporting_relation_count: 7 },
    control_system: { nodes: [5], relations: [...], node_count: 5, relation_count },
    external_change_evidence: { records: [...], relation_count }
  },
  live: {
    runtime_data: { graph: { nodes: [22], edges: [26] }, node_count: 22, edge_count: 26, supporting_relations: [7], supporting_relation_count: 7 },
    control_system: { nodes: [5], relations: [...], node_count: 5, relation_count },
    external_change_evidence: { records: [...], relation_count },
    activity: { frames: [...], revision }
  },
  diagnose: { runtime_data, overlay, ... },
  demo: { ... }
}
```

`external_change_evidence.records` is empty when no deployment/change evidence is canonically present. Each accepted record is bounded and contains its actual record ID, type, ordered affected runtime IDs, exact safe status, and ordered provenance/evidence references. It is an evidence annotation, not a `nodes` entry or an invented graph edge. `control_system.relations` contains only evidence-grounded internal control relations; empty is valid. The concrete strict field schemas, length caps, enum values, semantic revision hashing, and response cap remain owned by server code and test fixtures in stage A.

`projection_revision` binds the runtime graph, control records, external evidence records, truth axes, readiness, and safe activity frames. Any semantic change invalidates the prior revision. `/api/state` and `/api/source` must either expose the same scoped v2 revision and counts or explicitly report the view unavailable.

## 4. Architecture information model

Architecture remains a structural, no-edge overview. It uses only `topology_views.architecture` from a valid v2 projection.

### Default surface

- Four macro layers show only their technical layer name, member component icons, concise canonical names, and accessible status dots.
- The observed system contains exactly 22 runtime/data nodes. The FlowPulse Control System is a separate nested surface with exactly the five target capabilities.
- A control component default shows icon, concise name, and status dot. It does not show a role paragraph, count badge, relation-count prose, source-health sentence, or activity text.
- Architecture renders no runtime paths, control paths, cross-boundary lines, arrowheads, port marks, relation labels, or pulses. External deployment evidence is compact safe metadata in detail only.
- Redundant source, service, runtime, healthy, and layer-role prose is removed from visible copy. Equivalent bounded meaning is carried in `aria-label`, visually hidden descriptions, and keyboard focus labels.

### Consistent disclosure choice

Architecture uses an **in-place expanded component face** for both observed and Control System components. An observed component replaces the selected component's macro-module region; a Control System component replaces the complete existing FlowPulse Control System surface with one white bounded detail canvas. Repeat click on that canvas or Escape returns to the compact controls. It does not open a right drawer, route, modal, or a second disconnected card hierarchy.

The expanded face may show only fields supplied by the valid projection:

- what the component does, if the backend supplies a bounded safe responsibility field;
- bounded input and output categories;
- authority/permission boundary;
- integration/source provenance and safe evidence references;
- exact backend-projected status and source truth.

Absent facts are omitted rather than filled with guessed business prose. Escape or activating the same component returns its local tile face. Detail scrolling is contained within the expanded face; wheel/touch scrolling never accidentally closes it. A click on its non-interactive background returns to the tile face only after the scroll gesture ends and without consuming interactive links/buttons.

## 5. Live information model

Live consumes only `topology_views.live` with the matching v2 revision. It renders the observed runtime/data system as a single operating canvas. The same five server-projected Control System identities mount in the fixed right-side rail through the exact Architecture Control System tile/template. This rail is not part of the observed runtime topology, and a selected node's safe detail surface temporarily replaces the rail until that selection closes.

### Default surface

- All 22 observed components retain their exact IDs, labels, icons, and safe status dots while occupying deterministic upstream/downstream runtime positions.
- The five Control System capabilities remain server-projected and semantically separate in the shared right-side rail. They never join the monitored runtime dataflow.
- Runtime edges appear only after the node relayout: 26 captured `calls` paths use the signal grammar, while the seven supporting relations use distinct non-pulse evidence/configuration/telemetry styling.
- Cross-boundary deployment/change evidence appears only as a safe external evidence annotation tied to affected observed IDs. It is not a permanent FlowPulse node or broad arrow fan-out.

### Live disclosure

Observed runtime nodes retain their existing safe detail interaction. Control tiles use the same compact visual template and bounded server-projected detail rules as Architecture, while remaining observational and unable to display raw logs, trace bodies, prompts, provider payloads, secrets, arbitrary action controls, or a browser-created diagnosis.

## 6. Shared Architecture-to-Live choreography

### 6.1 State machine

| State | Entry | Allowed behavior | Exit |
| --- | --- | --- | --- |
| `architecture_stable` | Valid v2 Architecture read model | Macro layers visible, no paths/pulses, local disclosure allowed | User selects Live with a valid matching Live model. |
| `to_live` | Last requested mode is Live | Freeze current node rectangles; preserve keyed DOM identities; close architecture-only local detail after returning focus to the selected node; merge boundaries and animate nodes to live positions | Finish node relayout, or reverse/cancel according to latest request. |
| `live_stable` | Live node relayout complete | Draw valid runtime paths progressively, then play truthful pulses; only observed runtime-node detail is available | User selects Architecture or projection becomes unavailable. |
| `to_architecture` | Last requested mode is Architecture | Stop pulses, withdraw paths, preserve node identity, return nodes to macro-layer positions, then restore layer boundaries | Finish relayout or reverse/cancel according to latest request. |
| `unavailable` | Missing, mismatched, invalid, stale beyond usable contract, or scoped revision mismatch | Render bounded non-actionable unavailable surface. Preserve fixed navigation and truthful source label. | A new valid matching projection arrives. |

Repeated clicks are deterministic: the latest requested mode wins. During a transition, the implementation reads each keyed element's current computed transform, uses it as the next FLIP starting point, then reverses toward the newest target. It never queues duplicate transitions, clones a second graph, crossfades screenshots, or leaves mirrored content. Resize, reduced-motion change, or projection revision change cancels pulses, resolves current transforms, recomputes the deterministic target layout, and resumes only if the new model is valid.

### 6.2 Shared-element strategy

The browser keeps one keyed DOM element per canonical **observed** identity for the lifetime of a valid Architecture/Live projection. In the existing vanilla frontend, this means one renderer path with stable `data-topology-node-id` attributes, a per-ID layout map, and `Element.animate` or CSS transforms for FLIP inversion/playback. Architecture and Live Control System tiles reuse the same `data-control-node-id` identity and renderer template inside their separate fixed rail/surface. Macro layer containers and the Live runtime canvas are layout parents, not duplicate runtime card trees.

The sequence is:

1. Record source rectangles for each stable observed node and keep the header, source badge, navigation, and outer glass workspace fixed.
2. Update only layout classes/positions to the deterministic Live target, record destination rectangles, apply inverse transforms, and animate transform/opacity for 420–520 ms.
3. At node relayout completion, reveal only valid runtime edge paths in a short ordered draw sequence.
4. Start bounded repeated packets only on paths with backend-projected runtime activity or deterministic captured/demo frames.
5. Reverse these steps in the opposite order when returning to Architecture.

The implementation changes no graph geometry during the animation frame itself. It animates transform, opacity, and edge stroke effects only. In reduced-motion mode the same state transition uses a short opacity swap or an immediate layout update; paths and status remain meaningful, but no FLIP movement or packets run.

### 6.3 Layout, collision, and overflow

Architecture retains its four macro-layer membership groups. Live uses deterministic render-only topology lanes derived from the server-projected graph: upstream/entry, commerce/core, async/stream/data, and downstream/warehouse/consumers. These are layout lanes, not client-owned topology truth. Node order is stable by canonical server order then ID.

Nodes have minimum readable dimensions and collision padding. When a 1440x900 or 1280x800 viewport cannot accommodate a lane without overlap, the unified Live canvas remains pannable/zoomable within bounded transform limits rather than shrinking text or routing edges through cards. Edge routing must avoid cards, labels, controls, and group titles. If a valid endpoint cannot be laid out safely within caps, that path is withheld and the view reports its bounded unavailable/partial reason; the browser never invents an alternate relationship.

## 7. Runtime edge, status, and pulse truth

Architecture has no edges or pulses. Live renders only canonical relation IDs and their exact endpoints: captured `calls` paths, plus clearly distinct evidence-grounded supporting relations.

| Backend-projected condition | Live presentation | Forbidden inference |
| --- | --- | --- |
| Captured deterministic baseline | CAPTURED/DEMO source label, neutral node state, ordered single-packet traversal on each captured `calls` path only when the captured projection represents flow | Do not label it production LIVE or fresh OTEL. |
| Fresh authoritative source state | Normal/connected presentation with source freshness exactly as projected | Do not equate source data with owner approval or verification. |
| Warning/lag | Amber dot/path only when bounded server status says warning, lag, or pending | Do not infer warning from a sparse graph or timer. |
| Proven incident impact | Red only for server-projected incident overlay/frame status and its exact affected IDs | Do not make a selected node, low metric, or UI animation a fault. |
| Disconnected or stale | Gray/muted state with exact stale/disconnected label | Do not continue normal pulses as though fresh input exists. |
| Recovery/verified state | Green only when server projection exposes recovery or canonical verification truth | Do not paint recovery after a client animation ends. |

Packets are small electronic markers with an eased launch, cruise, and arrival. Exactly one packet occupies a direct `calls` path at a time; the next path starts only after arrival so the captured sequence remains legible. Supporting evidence/configuration/telemetry relations never impersonate live traffic. Red propagation happens stepwise along the incident overlay; green recovery happens only after projected recovery/verification. Reduced motion removes packet travel but preserves paths, status dots, and explicit text alternatives.

## 8. Loading, incident, recovery, and fallback states

| State | Architecture | Live | Action boundary |
| --- | --- | --- |
| Loading | Stable outer workspace and non-authoritative skeleton; no fabricated components | No runtime edge/pulse canvas until the matching projection validates | Read-only. |
| Empty | Explicit bounded empty/unavailable state | Explicit no-runtime-data state | No compatibility fallback. |
| Captured healthy demo | Layer inventory and green normal baseline dots with CAPTURED/DEMO truth | 22 nodes, 26 captured `calls` paths, and seven separately typed supporting relations when the view is valid | Trigger/injection remains a separately authorized future control. |
| Incident detected | Structural inventory remains bounded and no Architecture edge map | Exact overlay/frame IDs may show incident path and red impact | Diagnose readiness comes from server only. |
| Stale/disconnected | Preserve exact source truth, do not imply freshness | Gray/muted operating state; stop untruthful packets | No browser retry that changes run or source mode. |
| Recovery | Structure unchanged | Green only from projected recovery/verification evidence | Compare remains governed by backend readiness. |

## 9. Accessibility, interaction, and material continuity

- Navigation remains an accessible tab set. The active Architecture or Live mode is announced without implying that a local mode click changed backend state.
- Every component has a keyboard-reachable control, concise accessible name, exact status text, and bounded source/provenance description. Icon-only status is never the sole signal.
- Enter and Space expand a component; Escape returns the local face. On Architecture-to-Live transition, focus remains on the same canonical node if it survives the valid new projection; otherwise it moves to the active mode tab and announces the unavailable reason.
- Focus rings remain visible even where the spatial-glass style removes decorative borders. Hover, selection, and focus do not use health color as an interaction cue.
- `prefers-reduced-motion` removes FLIP movement, progressive edge drawing, and packets. `prefers-reduced-transparency` uses opaque off-white surfaces with the same hierarchy, readable text, and no loss of semantic separation.
- Blur is limited to bounded outer/macro surfaces with an opaque fallback. No nested high-radius blur stack is used. The header, fixed navigation, page field, workspace, macro surfaces, nodes, menus, and drawer retain the approved spatial-glass material family without turning every primitive into a translucent card.

## 10. Security and authority boundary

- The append-only ledger, server runtime, `IncidentProjection v1`, and validated topology projection remain the only truth for incident, diagnosis, gate, owner approval, execution, verification, recovery, and readiness.
- The browser may request read models and a future separately approved demo action, but it cannot send component status, activity, graph layout as truth, risk, repair proposal, evidence, approval, execution, receipt, or verification fields.
- Control System details are observational. They cannot expose an executor callback, provider control, approval token, model chain of thought, raw telemetry, raw logs/traces, prompts, credentials, or unrestricted event payload.
- Connector and OTEL input remain evidence proposals subject to existing envelope/manifest validation. A source label, glyph, display name, or animated pulse grants no policy authority.
- A v2 mismatch, malformed edge, duplicate ID, cross-run/incident record, missing provenance, excess count/bytes, or inconsistent revision fails closed to the bounded unavailable surface.

## 11. Tests and visual acceptance

### Focused contract tests

Stage A changes and extends `test/topology-projection.test.mjs`, `test/server.test.mjs`, and `test/twin-state.test.mjs` before renderer work. Existing assertions that deliberately require four controls must be replaced in the same atomic contract change:

- `src/topology-projection.mjs` `CONTROL_IDS`, `controlGraph`, `control_evidence`, and current `deployment-checkout`, `agent-evaluator`, `evaluator-ledger` relation assumptions;
- `test/topology-projection.test.mjs` assertions for `control_evidence.relation_count` and absent deployment evidence;
- `test/server.test.mjs` Architecture assertions at the current 26-node/4-control/1-control-relation shape;
- `public/twin-state.mjs` strict v1 key validation and Architecture boundary parser;
- `test/twin-state.test.mjs` `backendArchitectureView`, 4-control mock, `deployment-checkout` boundary expectation, and legacy `PULSE_SLOTS` assumptions;
- `public/app.js` Architecture count/control relation reads, only when the strict v2 parser is already available.

The test suite must prove all of the following:

1. Server and `/api/source` return the same valid scoped v2 revision or explicitly unavailable; 22 observed nodes, 26 captured `calls` edges, and seven typed supporting relations remain endpoint-valid.
2. The strict v2 Architecture and Live projections expose exactly five canonical Control System IDs, never a Deployment control node; unsupported/extra control IDs fail closed. Architecture and Live reuse the same five-control rail/tile renderer without putting those controls into runtime dataflow.
3. Deployment/change evidence is an external bounded record with actual affected observed IDs, or absent; it is not a node/arrow invented by the browser.
4. Current source, activity, gate, evidence, and readiness facts can only weaken to unavailable, never be strengthened by compatibility fields, local selection, cursor, animation timing, or browser input.
5. Architecture renders four layer modules, 22 observed component tiles, five independent control tiles, zero Architecture paths/arrowheads/pulses, and no visible redundant role/count prose.
6. Live reuses the same DOM identities, produces deterministic layout ordering, rejects invalid endpoints, and does not use `source.topology` or a stale v1 graph as a fallback.
7. Each motion direction, repeated tab selection, resize, reduced-motion, reduced-transparency, stale/disconnected transition, and projection-revision interruption finishes without cloned nodes, leaked pulses, focus loss, or console errors.
8. Raw/sensitive fields remain absent from all browser-facing detail output and no user gesture adds authority.

Run focused projection/server/twin/frontend tests first, then `npm test` once with natural exit, `npm audit --audit-level=high`, and `git diff --check`. Every staged change must preserve frozen primitives and leave generated `state/` and `outputs/live/**` untracked.

### Screenshot and browser review gate

At each visual stage inspect both **1440x900** and **1280x800** with no clipped controls, node text, Architecture FlowPulse surface, or detail. Required final evidence includes:

- Architecture structural overview with no paths and an independently readable five-capability FlowPulse surface.
- Architecture local control/observed component disclosure with only safe bounded facts.
- Architecture-to-Live transition midpoint and completed Live canvas, demonstrating stable identity rather than a page crossfade.
- Captured healthy Live flow, stale/disconnected Live state, and an evidence-grounded incident/recovery sequence where the backend makes those states available.
- Reduced-motion and reduced-transparency versions.
- A schema/revision unavailable state proving no v1/raw compatibility fallback.

Browser console and network must be clean. Local review servers use a fresh verified port; stale servers are stopped only when started by the current task.

## 12. Reviewable implementation plan

### A. Backend projection correction

Implement `flowpulse.topology-views.v2` in `src/topology-projection.mjs` and `src/server.mjs`, with strict browser parsing in `public/twin-state.mjs` and projection/server tests. Split the observed runtime graph, five-item Control System, and external deployment-change evidence record. Preserve the 22-node graph, 26 captured OTLP calls, seven typed supporting relations, and all existing authority boundaries. Stop for contract review before UI work.

### B. Progressive-disclosure Control System

Update the Architecture consumer only after stage A is approved. Render five canonical controls with default compact identity/status and consistent in-place safe disclosure. Live reuses the exact same Control System rail and tile renderer, while node detail replaces that rail rather than creating a new sidebar language. Remove visible redundant copy without losing accessible meaning. Stop for visual and accessibility review.

### C. Shared Architecture-to-Live re-layout

Replace independent Architecture/Live node trees with a stable keyed renderer and deterministic dual layout maps. Implement the reversible FLIP/shared-element transition, focus preservation, collision handling, interruption rules, and fallbacks. Do not add runtime edges or packets yet. Stop for transition review.

### D. Runtime edges, pulses, and truthful status

Render only valid Live runtime edges after relayout. Add bounded progressive path drawing, repeated packets, and status presentation driven only by v2 truth and frames. Add stale/disconnected/incident/recovery regression coverage. Stop for truth and visual review.

### E. Integration and final visual review

Verify endpoint parity, contract caps, no raw disclosure, natural full-suite exit, 1440x900 and 1280x800 screenshots, keyboard/reduced-motion/reduced-transparency behavior, and no Architecture fallback. This stage does not proceed to Diagnose, Recovery, Compare, real remediation, or deployment without a new owner checkpoint.

Rollback is a normal revert of the most recent approved stage commit. No stage rewrites history, merges to main, changes a remote, or advances to the following stage without owner review.

## 13. Non-goals

- No change to LiveSource ingestion, connector capabilities, OTEL collection, provider calls, GPT behavior, ledger primitives, Owner Gate, repair execution, verification, demo fault injection, or real production systems in this design checkpoint.
- No hidden page fallback, client-authored graph, UI-only Control System node, synthetic health, or invented deployment relation.
- No Diagnose, Recovery Console, Compare, Agent Control redesign, global visual redesign, new framework, dependency, deployment, Devpost modification, or main merge.

## 14. Recorded decisions

- Architecture is structural and renders no dependency edges; Live is the operating canvas for the same canonical identities.
- Live transition preserves observed-node identity through a single keyed DOM path and reversible FLIP strategy.
- The FlowPulse Control System is exactly Observer, Orchestrator, Investigator, Evaluator, and Evidence Ledger.
- The Control System rail persists across Architecture and Live through one shared template, while remaining outside observed runtime dataflow.
- Deployment is external bounded change evidence, not a FlowPulse component.
- All dynamic, health, gate, readiness, evidence, and recovery claims remain server-derived and fail closed when invalid or unavailable.
- No product decision blocks stage A. The first next action, after owner review, is only the strict backend projection correction.

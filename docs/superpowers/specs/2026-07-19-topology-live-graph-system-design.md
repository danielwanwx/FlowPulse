# FlowPulse topology, Live interaction, and shared Graph system design

Status: owner-amended direction; the 4333/`7426364` full-topology decision supersedes the earlier ten-node Architecture and six-node Live target

Date: 2026-07-19

Frontend baseline: `7426364`, visually accepted by Daniel at port 4333 (the `public/` surface is byte-identical through `86c5e02`)

Review branch: `codex/topology-live-integration`

Existing review candidate: `e4c6d87e41a074944f8358128e012ef72dec1a08`; it is not approved for merge

Scope: graph data semantics, Live canvas interaction, and a shared graph visual language. This document grants no approval, remediation, execution, provider, deployment, or submission authority.

## 1. Decision and loop contract

### Product decision

FlowPulse will improve its graph system in three separately reviewed phases:

1. **P0: truthful topology composition.** The backend composes the complete bounded graph it can prove from the selected source, append-only ledger, and code-owned component metadata. The browser renders that read-only projection.
2. **P1: usable Live navigation.** Live supports pan and zoom from graph content without turning a drag into an accidental node or edge selection.
3. **P2: one shared visual language.** Architecture, Live, Diagnose, Agent/Recovery, and Compare reuse the same node, port, group, connector, label, join, and state primitives.

No phase may be combined with a later phase merely because the files overlap. P0 data correctness is reviewed before P1 interaction work; P1 is reviewed before P2 visual unification.

### Loop contract

| Element | Contract |
| --- | --- |
| Goal | Present a truthful, navigable, visually coherent system graph without giving the browser or a fixture authority over incident, approval, execution, or verification truth. |
| Input scope | IncidentProjection v1, bounded source topology, canonical ledger events, code-owned component metadata, a sanitized checked-in topology manifest derived from the synthetic OpenTelemetry Demo capture, the bounded six-node incident bundle, baseline `7426364`, and the owner reference image. |
| Execute | Compose and validate topology on the server; render bounded view projections; then improve Live gestures; then apply shared visual primitives. |
| Check | Provenance, node/edge bounds, endpoint integrity, deterministic ordering, truth labels, interaction tests, accessibility, browser screenshots, console output, and no authority import or inference. |
| Feedback | Missing evidence yields omitted or unavailable nodes, never invented topology. Gesture conflict yields a targeted P1 repair. Visual inconsistency yields a P2 token/primitive repair, not a data-contract change. |
| Record | Contract tests, before/after counts, screenshots, console results, decision log, exact commit scope, and owner verdict after each phase. |
| Stop | Stop on absent evidence, ambiguous product meaning, authority regression, interaction ambiguity that needs an owner choice, accepted-shell redesign, or repeated visual/test failure. |
| Human gates | Daniel approves each phase and any merge. No branch merge, deployment, provider mutation, or Devpost change is implicit. |

## 2. Problem and verified evidence

### 2.1 Distinct graph meanings

The UI currently uses the word “topology” for several different things. They must remain separate even when a view overlays them.

| Graph meaning | Question answered | Authoritative input | Example |
| --- | --- | --- | --- |
| System architecture | What FlowPulse components and observed product components are present? | Backend-composed read projection from source, ledger, and code-owned component metadata | Runtime services plus Deployment, Investigator, Evaluator, and Evidence Ledger |
| Observed incident subgraph | Which entities and relations have evidence for this incident? | Selected bounded source topology and evidence provenance | Frontend → Checkout → Payment and Checkout → Kafka → consumers |
| Live runtime projection | What topology is currently observable, and how healthy is its source? | Bounded live or last-known source projection | Valid OTLP-derived service dependencies with explicit freshness |
| Control plane | Which FlowPulse components investigated, evaluated, or proposed work? | Canonical ledger events and code-owned agent/component identities | Investigator and Evaluator |
| Evidence plane | Where are immutable evidence and decisions recorded? | Append-only Ledger and bounded projection | Evidence Ledger and cited evidence relationships |

Architecture is the composed product/system view. Live is the runtime/data-flow view. Diagnose is a timeline-selected incident subgraph. Agent/Recovery is a ledger-derived control-flow view. Compare overlays incident and verified frames without changing the underlying topology truth.

### 2.2 Verified causes of the current incomplete and blank-Live reports

| Observation | Verified cause | Consequence |
| --- | --- | --- |
| Port 4333 showed 22 nodes and 22 edges on `7426364` | `FLOWPULSE_OTLP_DIR` pointed at the local synthetic OpenTelemetry Demo capture, and the accepted baseline rendered the fuller observed component/dependency graph. | This is the owner-accepted visual and data-completeness baseline. The raw local capture is evidence for deriving a bounded fixture, not a judge dependency. |
| Port 4310 showed 6 nodes and 0 edges | It was a stale service process exposing an older captured browser state. | Port 4310 is not acceptance evidence for the review branch. |
| Port 4312 showed 6 nodes and 5 edges | It loaded review candidate `e4c6d87`, which projects the bounded incident bundle topology. | The incident paths are valid for diagnosis, but they are not the complete runtime topology. |
| Architecture showed only 6 nodes | `architectureTopology()` replaces the product graph whenever `source.topology` is nonempty, and the selected replay source is the bounded incident bundle. | The incident subgraph replaces rather than overlays the 22-node system graph and also hides Deployment, Investigator, Evaluator, and Evidence Ledger. |
| Live appeared blank or fixed | The stale state had no dependencies; the restored frontend also accepts pan only from blank canvas because `startLivePan()` rejects node, edge, button, input, and summary targets. | A correct topology contract and a separate gesture repair are both required. |
| The source looked like live production data | The judge source is a deterministic sanitized fixture derived from synthetic OTLP, not a production database or live vendor connection. | UI labels must say CAPTURED. LIVE is reserved for fresh authoritative input explicitly configured at server startup. |

The synthetic OpenTelemetry Demo capture proves this exact 22-node runtime/data identity set for the P0 judge fixture:

```text
accounting, ad, cart, checkout, currency, email, flagd, flagd-ui,
fraud-detection, frontend, frontend-proxy, frontend-web, image-provider,
kafka, load-generator, otelcol-contrib, payment, product-catalog, quote,
recommendation, shipping, telemetry-docs
```

It also proves 22 directed dependency edges. Their canonical endpoint pairs are:

```text
cart->flagd
checkout->cart, checkout->currency, checkout->email, checkout->payment,
checkout->product-catalog, checkout->shipping
frontend->ad, frontend->cart, frontend->checkout, frontend->currency,
frontend->product-catalog, frontend->recommendation, frontend->shipping
frontend-proxy->flagd, frontend-proxy->frontend, frontend-proxy->image-provider
frontend-web->frontend-proxy
load-generator->flagd, load-generator->frontend-proxy
recommendation->product-catalog
shipping->quote
```

The bounded incident bundle remains a different artifact. It proves an exact six-entity/five-relation causal overlay:

```text
frontend -> checkout -> payment
                    -> kafka -> accounting
                             -> fraud-detection
```

The existing incident ID `fraud` is a source alias for canonical system ID `fraud-detection`; the backend performs that code-owned normalization before matching the overlay. The three causal relations absent from the 22 observed dependency edges remain explicitly typed incident-evidence relations. They are not relabelled as observed OTLP dependencies.

The current product model also contains four provable control/evidence entities: Deployment, Investigator, Evaluator, and Evidence Ledger. None collides with the exact 22 runtime/data IDs above, so the deterministic Architecture fixture has exactly 26 nodes. Its runtime dependency base remains exactly 22 edges. Additional control/evidence relations are projected only when their canonical ledger/evidence prerequisites exist, so they are reported separately and are not used to inflate the fixed runtime-edge acceptance count. Their presence and active status must be projected from server-owned evidence, ledger state, and code-owned component identity. Static browser constants may provide presentation defaults only; they cannot assert that a component participated in an incident.

### 2.3 Source-truth labels

The visible source label is a projection of orthogonal truth fields, not a styling choice.

| Label | Required truth | Allowed behavior |
| --- | --- | --- |
| `LIVE` | `source_health=live` and `evidence_mode=live_stream`, with validated current freshness | May animate current observed signals. It still grants no action authority. |
| `CAPTURED` | `evidence_mode=captured_fixture`; the judge path is `execution_mode=deterministic_replay` and current availability is not asserted | May replay recorded signals. It must not imply current source health or production connectivity. |
| `LAST-KNOWN` / `STALE` | A previously validated live or frozen-real topology is retained while `source_health=stale` or `disconnected` | Display-only and non-actionable. Preserve the actual evidence/execution modes, display STALE health explicitly, and show the last observation time when available. |
| `UNAVAILABLE` | No valid bounded topology can be projected, or the schema/source is unavailable | Render an explicit empty/degraded state. Never fall back to a captured fixture. |

`frozen_real_snapshot` remains a distinct evidence badge. It must not be collapsed into LIVE or CAPTURED fixture language. A freshly captured frozen snapshot is still not a live stream; its current source-health label is projected independently.

## 3. Graph data contract

### 3.1 Backend-owned read-only composition

The canonical flow is:

```text
selected source topology + bounded evidence provenance
  + canonical append-only ledger events
  + checked-in component identity metadata
  -> server-owned graph composition and validation
  -> IncidentProjection v1 graph/view projections
  -> browser layout and rendering only
```

Connectors, fixtures, model output, query parameters, local storage, replay cursors, and browser state cannot add graph authority. A connector can contribute bounded topology/evidence facts only through the approved normalization contract. It cannot create a control-plane node, approval state, action, receipt, verification, or repair truth.

The server composes separate provenance domains rather than flattening them into an unlabeled list:

- **Observed runtime/data:** the exact 22 entities and 22 dependencies in the sanitized checked-in OpenTelemetry Demo topology manifest for the deterministic judge path, or the same strict contract populated from explicitly configured fresh/frozen input.
- **Incident overlay:** the exact six canonical incident entities and five bounded causal relations from the incident bundle, matched onto the system graph without replacing it.
- **Change/control:** Deployment only when bounded change/deploy evidence or a canonical ledger reference exists.
- **Investigation/control:** Investigator and Evaluator from code-owned identities plus canonical ledger participation/status. Their presence does not mean their conclusion passed.
- **Evidence:** Evidence Ledger from the actual append-only ledger capability and bounded run projection. The browser receives no filesystem path, SQL, raw event payload, or secret.

### 3.2 Deterministic judge topology fixture and provenance

The judge path must not read Daniel's untracked `outputs/live/otel`, any `.env`, or a running collector. P0 checks in one bounded product fixture:

```text
data/topology/otel-demo-system-v1.json
```

The file is derived once from the synthetic OpenTelemetry Demo capture and contains only:

- schema and fixture version;
- synthetic source identity and upstream project/version reference;
- evidence mode `captured_fixture` and execution mode `deterministic_replay`;
- a fixed capture window and derivation metadata;
- the exact 22 bounded nodes and 22 directed dependencies listed in section 2.2;
- safe component labels, kinds, planes/layers, ordered signal-type summaries, and content hashes;
- ordered provenance references that bind each node/edge to the sanitized topology manifest without exposing raw telemetry.

It contains no trace/log/metric bodies, span or trace IDs, raw operation names, environment variables, filesystem paths, provider payloads, customer identifiers, hostnames, connection strings, SQL, prompts, credentials, secrets, tokens, or local/session IDs. `outputs/live/**` and `.env*` remain excluded. The derivation inventory records input hashes and the exact redaction/normalization algorithm; the checked-in fixture is deterministically sorted and carries a canonical SHA-256 over its semantic content.

The server owns fixture selection at startup. Browser/query/body/local-storage/model input cannot select a topology source or truth mode. An explicitly configured live connector may populate the same strict topology contract and replace the judge fixture only when current source health and freshness validate; it does not merge arbitrary caller topology into the fixture. Missing, stale, invalid, or mismatched live data renders LAST-KNOWN/STALE or UNAVAILABLE according to its real state and never silently falls back to CAPTURED.

### 3.3 Node contract

Each projected node has a strict bounded shape:

```text
id                stable, browser-safe canonical ID
kind              canonical entity kind
display_class     presentation class derived by the server
plane             runtime | data | control | evidence
layer             stable view-neutral layer/group ID
label             bounded safe display label
status            bounded non-authoritative display status
source_health     live | stale | disconnected | unavailable
provenance_refs   ordered bounded evidence/event/manifest references
```

Canonical entity kinds remain aligned with the approved EntityGraph vocabulary:

```text
service | deployment | dag | job | task | topic | dataset | table | query | incident
```

`display_class` supports the existing visual distinctions without changing policy semantics:

```text
client | service | api | stream | worker | change | agent | evaluator | ledger
```

For example, Kafka is `kind=topic, display_class=stream`; Accounting is `kind=job, display_class=worker`; the append-only ledger is a server-owned evidence component rendered as `display_class=ledger`. Provider names and glyphs are display metadata only.

Databases, datasets, tables, queries, DAGs, and jobs appear only when a normalized source envelope, selected frozen snapshot, or canonical ledger reference proves them. Product familiarity, a vendor logo, or a desired dense layout is not evidence.

### 3.4 Edge contract

Each projected edge has:

```text
id                stable canonical edge ID
from / to         IDs present in the same bounded node set
kind              calls | publishes_to | consumes_from | produces | reads |
                  writes | deployed_by | investigates | evaluates | records |
                  affects
label             bounded safe relation label or null
plane             runtime | data | control | evidence
status            neutral | active | change | failed | verified | unavailable
provenance_refs   ordered bounded evidence/event/manifest references
```

Edges are directed. Every endpoint must exist after deterministic truncation. Duplicate IDs, duplicate semantic edges, orphan endpoints, cross-run/cross-incident references, unknown kinds, malformed provenance, and unbounded labels fail closed. If truncation removes a node, every incident edge is removed deterministically and the projection reports truncation.

Layout routes, pixel coordinates, edge bends, label offsets, pulse position, selection, hover, pan, and zoom are presentation state. They never enter the authority or evidence contract.

### 3.5 Determinism, bounds, and truncation

The graph inherits the IncidentProjection v1 limits:

| Item | Limit |
| --- | ---: |
| Output nodes | 128 |
| Output edges | 256 |
| Input nodes | 512 |
| Input edges | 1024 |
| Evidence refs per event | 32 |
| Serialized IncidentProjection | 256 KiB UTF-8 |

Nodes sort by `plane`, `layer`, stable code-owned order where defined, then `id`. Edges sort by `plane`, `from`, `to`, `kind`, then `id`. The server validates counts and bytes before graph traversal or hashing. Output uses deterministic truncation with `truncated` and `next_cursor` where applicable.

The browser may compute deterministic positions from `plane`, `layer`, and order. It may not drop a valid edge silently. A visual aggregation or primary-path mode must expose that it is filtered, retain the full bounded count, and make the omitted relations inspectable. For the full captured judge topology, all 22 nodes and all 22 endpoint-valid dependencies must be available and rendered in Live. Diagnose additionally exposes the exact six-node/five-edge causal overlay without dropping the complete system context.

### 3.6 View projections

| View | Included graph truth | Presentation behavior | Forbidden behavior |
| --- | --- | --- | --- |
| Architecture (Monitor) | Exact 22-node/22-edge runtime/data base plus four non-duplicated, separately layered control/evidence entities | Structured/layered overview; exactly 26 nodes for the checked-in judge fixture, with control/evidence relation activity only when ledger/evidence proves it | Replacing the system graph with the incident subgraph; asserting participation from browser constants |
| Live (Monitor) | Full 22-node/22-edge runtime/data graph from the selected valid source | Pannable/zoomable presentation inherited from baseline; source-health labels and signals only on projected edges | Showing control-plane authority; calling captured data live; hiding valid captured edges; changing P1 gestures during P0 |
| Diagnose / Workbench | Complete system graph plus the exact six-node/five-edge timeline-selected incident causal overlay, selected/counter evidence, and evaluator relationships | Stable topology with ledger-derived stage emphasis | Replacing the complete graph with the overlay; client-derived cause, gate pass, risk, or accepted hypothesis |
| Agent / Recovery | Ledger-derived control/evidence relationships and the referenced incident entities | Explain investigation/evaluator/Owner Gate flow while keeping topology visible | Treating a visual connection or button as approval/execution permission |
| Compare | Two server-projected frames sharing canonical node identity | Incident vs recovery overlay/split; changed path highlighted | Client-generated verified state or mismatched run/incident comparison |

Architecture and Live remain Monitor subviews. Diagnose maps to Agent Workbench. Agent/Recovery and Compare map to Decision & Recovery under the approved three-stage product model, even while the restored baseline still exposes five compatibility tabs.

## 4. P0 acceptance: topology completeness and truth

P0 is complete only when all of the following are proven against the deterministic judge scenario:

1. The checked-in sanitized topology fixture validates to exactly 22 runtime/data nodes and 22 directed, endpoint-valid dependencies in deterministic order.
2. Architecture renders those 22 runtime/data nodes plus four server/ledger-derived control/evidence entities: Deployment, Investigator, Evaluator, and Evidence Ledger. Because the checked-in fixture has no identity collision with those four, the exact P0 judge count is 26 nodes and the runtime dependency base remains exactly 22 edges. Canonical control/evidence relations are counted separately. A future source collision is canonicalized and deduplicated rather than rendered twice.
3. Each node and edge carries a safe backend-owned provenance reference. Each control/evidence node has an honest inactive/active/status value; a static browser constant cannot make it active.
4. Architecture visibly separates runtime/data, control, and evidence planes. It does not relabel the six-node incident subgraph as the whole system architecture.
5. Live deterministic replay renders exactly 22 runtime/data nodes and all 22 valid directed dependencies from the sanitized fixture. Every endpoint exists and every signal travels on a projected edge.
6. Diagnose retains the complete system graph and highlights exactly six canonical incident nodes and five evidence-backed causal relations. `fraud` normalizes to `fraud-detection`; overlay relations that are not observed OTLP dependencies remain distinctly typed causal evidence.
7. The deterministic judge path displays `CAPTURED`, `captured_fixture`, and `deterministic_replay`; it does not say LIVE OTLP, production database, or current vendor connectivity. Only explicitly configured, fresh authoritative input may display LIVE. Frozen/stale/disconnected states remain distinct.
8. Database, table, dataset, query, DAG, or job identities appear only when the sanitized manifest or another approved normalized source proves them. The current 22-node fixture contains no database/table/query/DAG node; no desired layout may create one.
9. Invalid, stale, disconnected, schema-mismatched, oversized, cross-run, or cross-incident topology becomes explicit LAST-KNOWN/STALE or UNAVAILABLE/non-actionable state as appropriate.
10. Architecture, Live, and Diagnose consume server-owned view projections. The browser cannot inject nodes, edges, overlay membership, status, provenance, or source truth.
11. The visible shell and graph presentation remain the owner-accepted `7426364` behavior demonstrated at port 4333. P0 contains no pan/drag changes and no shared visual restyling.

Required evidence:

- contract tests for node/edge counts, deterministic ordering, endpoint integrity, provenance, bounds, truncation, and truthful labels;
- server/IncidentProjection tests proving source and composed graph outputs;
- fixture and contract tests proving the exact 22/22 manifest, derivation metadata, content hash, deterministic order, safe fields, and exclusion of raw/personal/secret material;
- frontend tests proving Architecture retains all 22 runtime/data entities plus four non-duplicated control/evidence entities, Live renders all 22 dependencies, and Diagnose retains the system graph while highlighting exactly six/five;
- browser screenshots at 1440×900 and 1280×800 for Architecture and active Live replay;
- browser DOM evidence of node/edge counts, zero invalid endpoints, visible signals, no overflow, and no console errors or warnings;
- before/after API evidence that identifies the exact process/port under review.

## 5. P1 interaction: Live pan and zoom

### 5.1 Gesture model

Live must allow a pan gesture to start on blank canvas, a node card, an edge hit target, an edge label, or a group background. It must not start from toolbar controls, form fields, open drawers/dialogs, timeline controls, or page navigation.

Pointer handling uses a candidate-drag model:

1. `pointerdown` records pointer ID, origin, and current viewport transform, then captures the pointer on the canvas.
2. Movement below a 5 CSS-pixel threshold remains a click candidate.
3. Crossing the threshold starts panning, suppresses the pending node/edge click, and updates only transform state.
4. `pointerup` below the threshold preserves the original click/selection action.
5. `pointerup`, `pointercancel`, and `lostpointercapture` always clear drag state, CSS state, and pointer capture.

This replaces the current blanket rejection of `.twin-node` and `.edge-hit`. Graph nodes may remain semantic buttons; the gesture arbiter, not a tag-name exclusion, distinguishes select from pan.

### 5.2 Navigation controls

- Zoom is centered on the canvas pointer when initiated by wheel/trackpad and on the viewport center for explicit zoom buttons.
- Existing minimum/maximum scale bounds remain deterministic and testable.
- Reset/Fit computes one contained transform from the current viewport and world bounds.
- A canvas focus target provides keyboard-accessible pan or equivalent directional controls; Enter/Space opens the focused node/edge, and Escape closes the drawer without losing graph focus.
- Touch uses the same pointer-capture lifecycle; multi-touch pinch is optional and not required for P1.
- Panning cannot alter replay cursor, source mode, stage, evidence selection, or authority state.

### 5.3 View-specific behavior

| View | Interaction contract |
| --- | --- |
| Architecture | Structured/static by default. Node and relation inspection remain available; free pan is not required for P1. |
| Live | Pannable and zoomable from graph content; repeatable signal playback does not reset the viewport. |
| Diagnose | Timeline-driven. The selected frame changes server-projected emphasis, not topology truth or free-form coordinates. |
| Agent/Recovery and Compare | Retain their current reviewed interactions until a later explicitly approved checkpoint. |

`prefers-reduced-motion` disables kinetic easing and moving packets. Pan/zoom still work immediately, and the current path is shown with a static high-contrast state.

### 5.4 P1 acceptance

- Dragging from blank canvas, each node class, an edge, and an edge label pans after the threshold.
- Clicking or pressing Enter/Space on those same elements opens the correct bounded detail without pan drift.
- Pointer release/cancel outside the canvas leaves no stuck capture or `is-panning` state.
- Zoom, Reset/Fit, keyboard navigation, drawer focus return, and reduced-motion behavior pass focused tests.
- Live viewport remains stable through replay restart and repeat.
- Browser evidence covers mouse, keyboard, reduced motion, 1440×900, and 1280×800 with zero console errors.

## 6. P2 visual language: shared Graph primitives

The owner reference is a structural reference, not a color target. FlowPulse will borrow its readable parallel paths, compact cards, visible ports, restrained junctions, nested groups, and labelled orthogonal connectors while retaining a white-first FlowPulse identity.

### 6.1 Shared tokens and primitives

| Primitive | Shared contract |
| --- | --- |
| Canvas | White/off-white surface with a very subtle dot/grid texture; no gradient, glass blur, neon glow, or decorative shadow field |
| Node | Compact solid card; 1 px border; 14–18 px radius; high-contrast label; secondary kind/source/status line; distinct existing Phosphor glyph by `display_class` |
| Port | Quiet visible input/output anchor, approximately 6–8 px, aligned to the routed edge; not an authority affordance |
| Group | Quiet nested container with 20–24 px radius, clear title, and visual separation from child nodes; used for runtime/data/control/evidence or parallel work |
| Edge | Directed 1.25–1.75 px orthogonal/elbow path with 10–14 px corner radius and compact arrowhead; background edges use one cool neutral |
| Edge label | Small solid outlined capsule placed on a straight segment; bounded text; never covers a node, port, junction, or another label |
| Join/split | Restrained 12–16 px diamond when multiple paths genuinely join or split; it is a routing aid, not a fabricated entity |
| State | Neutral gray at rest; blue active flow; orange change/decision branch; red verified fault propagation; green verified recovery |
| Pulse | Two to four repeated packets along the actual edge, approximately 0.8–1.2 seconds per traversal; node activation and red fault propagation occur step-by-step |

All primitives use current HTML, SVG, CSS, and Phosphor assets first. No graph framework or rendering dependency is added unless the existing implementation fails a measured density, routing, accessibility, or performance acceptance criterion and the owner approves the trade-off.

### 6.2 Shared versus view-specific styling

Shared across every graph:

- node geometry, typography, ports, focus rings, status marker placement, and glyph mapping;
- group frames, connector stroke/arrow/label primitives, join/split shape, hit targets, selection, hover, and disabled/unavailable states;
- semantic color meanings, pulse timing contract, reduced-motion alternative, and dark-theme semantic parity where the current theme remains supported.

View-specific:

- Architecture uses calm plane/layer grouping and minimal active color;
- Live emphasizes source health, current flow, pan/zoom, and repeated packets;
- Diagnose emphasizes timeline-selected causal/counter-evidence paths;
- Agent/Recovery emphasizes ledger-derived work and gate relationships;
- Compare emphasizes the incident path versus the verified recovery path.

View-specific styling cannot fork the underlying node/edge component grammar or redefine state colors.

### 6.3 P2 acceptance

- The same entity renders with the same card, port, icon, focus, and status grammar across Architecture, Live, Diagnose, Agent/Recovery, and Compare.
- Parallel and joined paths remain readable without thick pipes, giant U-shaped detours, card overlap, label overlap, or hidden arrow direction.
- Node/edge labels remain legible at 1440×900 and 1280×800 without shrinking primary text below the accepted baseline.
- Light theme is the competition acceptance theme. Existing dark theme, if retained, uses deliberate dark tokens and identical semantics rather than simple inversion.
- Active packets follow exact rendered edges; background edges remain visible at rest; fault and recovery color changes are sequential.
- Screenshots and keyboard review cover each graph view plus reduced motion and unavailable state before P2 is accepted.

## 7. Phased implementation and review plan

This section fixes sequencing and boundaries. A separate implementation plan must convert it into exact test-first tasks before code changes.

### Phase P0: server-owned graph composition

Likely files:

- `data/topology/otel-demo-system-v1.json`
- `src/topology-manifest.mjs`
- `src/evidence-source.mjs`
- `src/server.mjs`
- `src/incident-projection.mjs`
- `public/app.js`
- `public/twin-state.mjs`
- `test/evidence-source.test.mjs`
- `test/topology-manifest.test.mjs`
- `test/incident-projection.test.mjs`
- `test/server.test.mjs`
- `test/twin-state.test.mjs`

Tests and records:

- red tests for the exact sanitized 22-node/22-edge fixture, 26-node composed Architecture, 22-node/22-edge Live, six-node/five-edge Diagnose overlay, endpoint integrity, provenance, deterministic ordering, truth labels, bounds, and no client authority;
- focused backend/projection/frontend suites;
- `/api/health` and `/api/state` evidence from the exact review process/port;
- 1440×900 and 1280×800 Architecture and Live screenshots with DOM counts and console logs.

Stop: required entities/relations lack evidence; Architecture needs browser constants to claim participation; source/projection schemas disagree; authority tests regress; or the accepted shell would require redesign.

Rollback: keep P0 in its own commit. If review fails, revert that commit on the review branch or add a bounded repair commit; do not reset shared history or mix P1/P2 changes.

### Phase P1: Live gesture arbitration

Likely files:

- `public/app.js`
- `public/twin-state.mjs` only if pure gesture geometry helpers are needed
- `public/styles.css` only for cursor/focus/panning states
- `test/twin-state.test.mjs`

Tests and records:

- threshold, node/edge/label drag, click preservation, pointer capture/cancel, zoom, Reset/Fit, keyboard, replay stability, and reduced-motion tests;
- browser gesture evidence at 1440×900 and 1280×800;
- node/edge drawer selection before and after pan.

Stop: click and pan cannot be distinguished reliably without changing semantic controls; pointer capture leaks; keyboard access regresses; or viewport state affects replay/authority truth.

Rollback: revert only the P1 commit. P0 graph truth remains intact.

### Phase P2: shared Graph visual system

Likely files:

- `public/app.js`
- `public/twin-state.mjs`
- `public/styles.css`
- `public/index.html` only if shared accessible SVG definitions or graph landmarks require it
- `test/twin-state.test.mjs`

Tests and records:

- primitive/token contract tests and existing geometry/drawer/Compare/reduced-motion regression tests;
- screenshot matrix for Architecture, Live rest, Live active replay, Diagnose rejection/replan, Agent/Recovery, Compare, drawer, unavailable, and reduced motion;
- visual QA for overlap, clipping, contrast, port/arrow/label legibility, and semantic color consistency.

Stop: the work becomes a non-graph redesign, requires a new framework without measured need, weakens the accepted shell, changes product truth, or repeats a visual failure class after two targeted repairs.

Rollback: revert only the P2 commit. P0 semantics and P1 gestures remain separately reviewable.

### Existing candidate `e4c6d87`

`e4c6d87` remains a review candidate, not the assumed implementation base for all three phases.

| Candidate part | Initial disposition for the implementation plan |
| --- | --- |
| Selected-source topology normalization and server projection | Reuse only after it accepts the strict full 22/22 manifest/live contract; supersede every six-node-only display assumption |
| IncidentProjection graph receives selected source topology | Amend so Architecture receives the composed 22-plus-four graph, Live receives the full selected 22/22 runtime graph, and Diagnose receives a separate six/five overlay |
| Browser accepts `services/dependencies` compatibility aliases | Audit; prefer one canonical IncidentProjection shape rather than permanent dual truth |
| Architecture replaces the product graph with source-only topology | Supersede in P0 |
| Fixed Live edge contrast adjustment | Re-evaluate in P2 against shared tokens, not P0 |
| Node keyboard drawer support | Preserve if focused accessibility tests pass |

Do not amend `e4c6d87`, merge it to main, or silently fold P1/P2 into it. Its six-node Live result is evidence that the read path works, not the P0 target. The implementation plan must choose explicit follow-up commits that reuse, repair, or supersede its hunks. Owner review decides whether the branch is eventually squashed, merged as multiple commits, or abandoned.

## 8. Security and authority invariants

The append-only Ledger and IncidentProjection remain authoritative. This graph design changes visualization and read-only topology composition only.

The browser never computes, selects, submits, or strengthens:

- incident stage or accepted diagnosis;
- risk tier or contract hash;
- source freshness or evidence completeness;
- registry, intent, lock state, receipt, preauthorization, or authority;
- approval, repair, execution, verification, promotion, or recovery truth.

Graph node presence, edge presence, selection, hover, color, pulse, label, cursor, pan, zoom, grouping, layout, and Compare position have zero authority effect. Captured fixtures and replay controls cannot append canonical events or become live evidence.

Browser responses contain only bounded safe projection fields. They exclude raw ledger rows, provider payloads, logs, trace bodies, prompts, model reasoning, SQL, credentials, tokens, filesystem paths, local/session IDs, and unrestricted metadata. Node/edge labels and provenance references remain length-bounded and text-rendered; no HTML trust is permitted.

Any unknown schema, unknown enum, malformed/cross-scope reference, duplicate sequence/ID, orphan edge, stale or unavailable source, overflow, or truncation inconsistency fails closed. The UI may remain inspectable but must be visibly non-actionable.

## 9. Decision log

| Decision | Rationale |
| --- | --- |
| P0 data semantics precede gesture and visual work | A polished or pannable graph cannot compensate for incomplete or mislabeled topology. |
| Correct frontend reference is `7426364` at port 4333 | Daniel explicitly accepted the 22-node/22-edge rendering; the `public/` files are identical through `86c5e02`. Ports 4310/4312 do not supersede that baseline. |
| Architecture composes multiple graph meanings | The full 22/22 OTLP Demo graph is the runtime/data base; the six/five incident bundle is an overlay, not a replacement; control/evidence identities occupy separate planes. |
| Live renders only selected source runtime/data topology | Control/evidence relationships belong to Architecture, Workbench, or Recovery projections and must not imply live telemetry. |
| The deterministic judge Architecture count is exactly 26 | The sanitized manifest proves 22 runtime/data identities and none duplicates Deployment, Investigator, Evaluator, or Evidence Ledger. Other sources use canonical deduplication rather than a hard-coded density target. |
| Judge topology is checked in as a sanitized manifest | Judges must not depend on Daniel's untracked capture directory. The fixture preserves bounded topology/provenance only; raw OTLP and environment data stay excluded. |
| Live pan starts from graph content with a movement threshold | Dense graphs otherwise feel fixed, while immediate panning would break click/keyboard inspection. |
| Shared primitives precede any framework decision | Existing HTML/SVG/CSS and Phosphor assets already support the required grammar; dependency cost needs measured justification. |
| Owner reference informs structure, not palette or product truth | FlowPulse remains white-first and preserves its semantic colors and evidence hierarchy. |
| `e4c6d87` remains unmerged | It proves part of the source-to-Live path but does not satisfy Architecture composition, P1 gestures, or the P2 shared visual system. |

## 10. Non-goals

This design does not authorize:

- production OTLP, database, warehouse, Kafka, Airflow, OpenLineage, or vendor connector work; the existing read-only live source may populate the same contract when explicitly configured, but P0 adds no connector;
- invented databases, tables, queries, jobs, DAGs, or topology used only to make the canvas denser; only the exact manifest identities may appear in the judge runtime/data base;
- committing or reading judge data from `outputs/live/**`, `.env*`, raw logs/traces/metrics, or personal filesystem paths;
- approval/reject/defer endpoints, remediation, executor, provider, Astronomy, or authority-policy changes;
- Devpost form, Session ID, submission, video, README marketing, deployment, or push to main;
- merge of `e4c6d87` or any later phase without owner review;
- a dark-theme redesign, unrelated shell/navigation redesign, or non-graph UI rewrite;
- a new graph framework, canvas engine, layout dependency, or vendor SDK without a measured and owner-approved need;
- one mega-commit covering P0, P1, and P2.

## 11. Acceptance and owner review gate

The written specification is ready for implementation planning only when:

- all P0/P1/P2 boundaries are unambiguous and independently testable;
- source labels and graph meanings cannot be confused;
- the exact 22/22 sanitized runtime/data fixture, 26-node Architecture composition, 22/22 Live replay, and six/five Diagnose overlay are evidence-backed;
- gesture threshold and pointer lifecycle are explicit;
- shared visual primitives are defined without prescribing a new framework;
- authority, privacy, bounds, and fail-closed behavior are explicit;
- `e4c6d87` has an explicit audit disposition rather than an implied merge;
- no application or test file changes are included with this document.

After Daniel approves this amendment and its revised P0 plan, the first implementation checkpoint is the data/evidence inventory plus sanitized topology-fixture contract only. It must stop for owner review before source, projection, server, or browser wiring. P1 and P2 remain unauthorized until the preceding phase is accepted.

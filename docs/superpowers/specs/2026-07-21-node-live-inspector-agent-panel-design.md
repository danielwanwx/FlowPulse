# Node Live Inspector and Compact Agent Investigation

## Goal and bounded loop

This checkpoint turns the existing right rail into one compact, truthful live
narrative. A selected runtime node replaces Agent Team Home in the same rail;
it does not create a second panel, modal, canvas reflow, graph remount, or
pulse restart. **Ask Observer** changes that exact rail into Agent
Investigation. Back restores the same Inspector state, including selected node,
open disclosure sections, scroll position, and evidence cursor. Closing the
Inspector restores Team Home.

The loop is: project only the bounded backend v1 detail, render a smaller
Inspector, verify interaction and schema handling, then stop for Owner
screenshot review. The separate backend worktree and its planned N1 Node
Investigation Plane are not modified by this checkpoint.

## Inputs, truth, and compatibility

The current sources of truth are:

- `flowpulse.component-detail.v1`, revision-bound to the canonical Live
  topology, for node purpose, runtime truth, bounded relationships,
  observability, evidence, provenance, and data resources when present;
- Agent Team conversation/provider/loop envelopes already integrated on this
  branch for a safe answer, citations, count-only tools, explicit handoffs, and
  contextual workspace gates;
- the canonical selected runtime node ID and topology revision.

The browser remains a strict renderer. It must not manufacture metrics, logs,
database/table/job/DAG relations, tool activity, freshness, health, incident
status, repair, verification, or readiness. Missing facts are omitted rather
than displayed as `N/A` or simulated.

The upcoming N1 contract will be a separate, versioned parser seam. It is
unavailable until its exact backend schema lands. Unknown versions, extra keys,
malformed IDs, unsafe strings, unbound revisions, or unexpected event fields
fail closed and show a bounded unavailable state. This checkpoint starts no
component event SSE stream and never claims that v1 is realtime streaming.

## Right-rail state model

```text
Team Home
  └─ select runtime node → Inspector(node, detail, disclosures, scroll)
       ├─ Ask Observer → Agent Investigation(node, conversation, disclosures,
       │                  inspector snapshot)
       │                  └─ Back → exact Inspector snapshot
       └─ Close/Escape → Team Home
```

The Team rail dimensions and outer material do not change in any state. A node
selection covers Team Home in place. Selecting a dependency updates only the
canonical selected node and its Inspector read model; it never remounts the
Live canvas or restarts path/pulse animation. Escape closes the current detail
surface in the same order as explicit controls.

## Compact Node Live Inspector

The Inspector is one vertically scrollable narrative with a stable compact
header and no static report tabs.

### Header

The fixed header has the component glyph/name, a server-projected status dot,
truth/freshness only when supplied, **Ask Observer**, and Close. It omits the
duplicated `Service` label, repeated component name, permanent
`service.name` line, and engineering IDs.

### Live Pulse

At most four ranked, backend-projected signal summaries are shown. Supported
forms are error rate, p95 latency, throughput/lag, and last event. A summary
contains only supplied value, unit, status, and observed time. No empty metric
tiles or browser clock appear.

### Event Stream

The default stream contains the newest five safe, bounded events in canonical
descending time/sequence order. Each event has supplied time, severity/type,
redacted summary, and optional trace/change marker. A View more control reveals
additional already-projected events; it fetches neither raw payloads nor an
imaginary stream. Empty state states that no bounded events are projected.

### Dependency Impact

Upstream and downstream groups each render at most three canonical nodes and a
`+N` disclosure where additional projected nodes exist. Impact/health appears
only when the backend supplied it. Each relation button safely selects its
canonical target and preserves the active Live canvas.

### Evidence, source, and data resources

Evidence & Source is collapsed by default. Its compact summary uses only
available record count and freshness. When expanded it can show source mode,
source health, freshness, safe evidence IDs, hashes/provenance, topology/detail
revision, and explicit truncation/gap markers. Data Resources appears only when
the backend projects a resource. It never infers a database, table, topic,
consumer group, job, or DAG.

## Compact Agent Investigation

Agent Investigation retains the same rail and its fixed header/context/composer
geometry. Its default surface contains only:

1. role icon/name/status and one concise context line, for example Observer ·
   Checkout · captured freshness when present;
2. the scrollable server-projected timeline;
3. contextual workspace actions; and
4. a composer for conversational roles, or a read-only Ledger state.

Static Inputs, Outputs, Boundary, Provenance, and capability/activity copy move
to a collapsed **Agent capability** disclosure. Run/incident IDs move to a
collapsed **Run details** disclosure. Citations begin as `N cited records` and
expand only to safe references. Tool activity shows exact backend tool name,
action, result count, and explicit handoff. Handoffs render as compact
`from → to · reason`; user messages are visually subordinate to Agent findings.

`safe_answer` remains plain text. Future Observed, Assessment, Missing, or Next
sections render only if a future strict backend contract supplies those named
fields. The Evidence Ledger remains non-conversational and has no composer.

## Security, accessibility, and motion

Only strict safe projections render. Raw prompts, provider payloads,
chain-of-thought, credentials, raw logs, and raw traces are absent from both
the DOM and local persistence. Action buttons only navigate to backend-gated
workspaces; they never repair, approve, execute, or verify.

Buttons use real controls and ARIA-expanded state for disclosures. Keyboard
activation, Escape, focus return, and scroll containment are mandatory. The
frosted light material uses the established rail geometry, radius, and status
colors; reduced transparency preserves hierarchy with opaque surfaces, and
reduced motion removes nonessential transitions.

## Test and review contract

Tests are written before implementation and cover:

1. node selection replacing Team Home inside the same rail;
2. Inspector → Ask Observer → Back restoration of node, disclosure, scroll,
   and context;
3. Close restoring Team Home without canvas remount/pulse restart;
4. omission of redundant header/capability metadata;
5. only supported Live Pulse facts, ordered/deduplicated/redacted events, empty
   state, dependency caps/groups, and canonical dependency selection;
6. Evidence & Source, Agent capability, and Run details collapsed by default;
7. no permanent run/incident IDs, raw data, fabricated SSE, or legacy manager
   endpoint;
8. Ledger read-only, v1 compatibility, and strict N1-unavailable parser seam.

Browser review at 1440×900 captures the Checkout Inspector default, expanded
Evidence & Source, Event Stream/Dependency Impact, Ask Observer, a real
tool/citation/handoff where current data supplies it, and Back-restored
Inspector. It also checks 1280×800 and console diagnostics. The checkpoint
stops after its focused/full test evidence, audit, diff check, commit, and push;
it does not redesign Diagnose, Recovery, or Compare.

## Non-goals and stop rules

No backend worktree change, no new dependency, no React migration, no mock
realtime event data, and no authority-policy change are permitted. If the
feature requires backend N1 fields that v1 does not project, the UI omits that
section and records the gap for the backend checkpoint rather than fabricating
it. If canonical topology or Agent schemas are incompatible, render an explicit
unavailable state and stop rather than falling back to legacy data.

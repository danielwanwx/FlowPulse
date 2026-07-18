# Ledger-first Architecture and Recovery Density

**Status:** Implemented; verification in progress 2026-07-17
**Scope:** Frontend information architecture only. Runtime telemetry, append-only ledger, agent control service, evaluator authority, replay semantics, and owner approval remain unchanged.

## Design read

Production developer workspace for an engineering manager and incident commander: crisp light/black technical surfaces, restrained monochrome structure, transparent vectors, semantic status dots, and only evidence that exists in the active source window.

## Audit basis

The current Architecture, Compare, and Recovery Console views were inspected against the running local FlowPulse workspace. The audit found four recurring issues:

1. Architecture cards expose both capability and runtime fragments without a clear system-level hierarchy.
2. Recovery Console repeats stage, collaborator, evaluator, and activity data across its header, graph, rail, and chat panel.
3. The stage rail renders unreached recovery milestones as disabled future steps, which reads as a pre-scripted recovery rather than a projection of the current ledger.
4. The common node drawer exposes technical categories before the user knows whether a component has any relevant signal, dependency, or evidence for the current window.

## Information architecture

### Architecture

- Keep Architecture line-free and sourced only from the current OTLP/captured topology.
- Group services into four named layers with a human-readable role and a short purpose line: Experience, Edge and Commerce, Core Services, and Async, Data and Platform.
- Each card presents the concrete component name, component class/runtime identity, one business responsibility, and the existing status dot. It does not fabricate a vendor, data store, or dependency.
- Layer separators are structural and neutral; status dots remain the only color used for runtime condition.

### Recovery Console

- Preserve the six-agent graph and right collaboration panel, but reduce the visible summary to one current state, one grounded signal, two quick prompts, the conversation, and the composer.
- Hide the metric cluster and legend in this mode because they duplicate the graph and agent panel. Full activity, actions, role boundaries, evidence citations, and controls remain in the existing disclosure or drawer.
- The diagnosis band shows the current ledger stage and human gate only when either has an actual value. Empty evaluator scores are not displayed.

### Timeline

- The rail renders only milestones that are unlocked by ledger events. The last visible event is marked current.
- Unreached stages are represented by one honest next-state message, such as “Next: awaiting cited evidence”; they are not shown as timestamped future events.
- The deterministic replay path reveals later stages only when it appends the corresponding ledger records. Compare retains its explicit captured-preview provenance and does not make unrecorded steps look completed.

### Entity drawer

- Source components use only data-bearing sections: Overview, Signals, Dependencies, and Evidence. Sections are removed when their source data is unavailable.
- Overview shows source identity, observed status, capability, runtime language, source age, and cited-record count.
- Signals groups actual OTLP evidence by type. Dependencies exposes only observed upstream/downstream endpoints.
- Agent drawers use a compact operational brief, latest recorded work, and a collapsed role boundary. Full manifests/proposals remain inspectable but do not dominate the first view.
- Replay/control node tabs remain evidence-first and continue to expose raw payload/provenance through existing disclosures.

## State rules

- No client-only success, repair, verification, regression, or timestamp is introduced.
- Stage availability remains derived from `availableStage(state.events)` and agent details from `/api/agent-control`.
- Architecture and source drawers derive only from `state.source`, OTLP evidence, and topology integrity results.
- Missing data is labelled as an evidence gap or omitted from the first view; it is never filled with a generic “healthy” or a synthetic metric.

## Accessibility and motion

- Layer labels remain visible text and are no longer hidden from assistive technology.
- Status remains available in each node’s accessible name; color is supplementary.
- Timeline buttons retain deterministic keyboard seeking only for unlocked stages.
- The simplified layout preserves existing reduced-motion behavior; no new motion is introduced.

## Acceptance checks

- Architecture visibly states its system layers and each card identifies a real observed component without connection lines.
- Recovery Console has one primary summary, a readable graph, and chat as the dominant right-panel interaction.
- An incomplete run does not display dated recovery, learning, or owner-gate milestones as if they happened.
- Each drawer first view contains only entity-appropriate available data; immutable evidence and payload disclosures remain reachable.
- Existing agent, replay, approval, and source topology tests stay green; focused tests cover visible ledger stages and data-bearing source tabs.
- Browser QA at 1440×900 and 1280×800 shows no console errors, clipped labels, or hidden required controls.

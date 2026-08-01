# Reference Glass Incident Workspace Design

## Intent

Rework the V3 Incident workspace to match the supplied soft-white dashboard
reference: borderless rounded glass surfaces, quiet icon circles, blue active
controls, semantic status dots, and details revealed by explicit interaction.
The workflow, V3 projection, series, evidence, and SSE contracts remain the
only sources of truth.

## Layout

On desktop, the active stage uses a 8/12 dashboard and 4/12 floating Agent
Portal. The left side contains a compact row of real signal cards, an impact
path card, and a component-state card. The right pane is collapsible and
contains `Now`, `Activity`, and `Evidence` tabs. It defaults to the active
stage and switches to the selected component or edge when the user clicks a
signal card, component, arrow, or Dataflow node.

The stage rail stays compact. Long explanatory copy stays in the Portal or a
modal; the stage surface shows labels, values, statuses, and immediate actions
only.

## Components and interactions

- Cards, buttons, graph nodes, and panels have no resting border. They use
  20–26px radii, semi-transparent white surfaces, soft elevation, inner
  highlight, and keyboard-only focus rings.
- A component card opens the Portal with its real status, metric samples,
  related Agent activity, evidence count, and incident relations.
- An impact-path arrow is an interactive relation, not decoration. It selects
  the corresponding source/target context in the Portal.
- Monitor and Activity remain drawers/modal views but mirror the same glass
  language and display only real typed series or Agent activity.
- The Portal input starts a scoped V3 Agent run for the currently selected
  component during Triage, Investigate, or Decide. It must expose the actual
  question to the bridge request and then show only returned activity and
  evidence. Other stages are explicitly read-only.

## Dataflow

Dataflow renders every evidence-backed node and edge that belongs to the real
`impacted_path`; it never expands the topology with decorative dependencies.
Edges have a direction marker and only live `active_pulses` animate. Node tone
comes from real runtime/impact/freshness state. A node click keeps the graph
open while synchronizing the Portal/Quick Peek to that real component.

If the projection has only `Checkout -> Payment`, the modal truthfully shows
two components. If the projection later exposes the full affected path, all
real path components render through the existing deterministic layout.

## Agent and evidence boundary

The small backend change passes `AgentRunCommandV3.question` into the existing
redacted `GuidedAgentBridgeRequestV3`, without adding a separate chat service.
There is no raw V3 log-body endpoint today. The Portal therefore exposes real
evidence-query summaries and references rather than fabricated log entries.

## Verification

At the same 1440px desktop viewport, capture: Detect with Portal closed,
Detect with Checkout selected and Portal open, Dataflow with a real active
pulse and Quick Peek, and Live with the active path. Compare the relevant
content region against the supplied reference for borderlessness, radius,
opacity, spacing, typography, interaction affordance, and information
hierarchy. Independent Staff review must report no P0/P1 before handoff.

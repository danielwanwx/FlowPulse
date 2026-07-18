# Recovery Console and Signal Path QA

Date: 2026-07-17  
Server: `http://127.0.0.1:4310/`  
Design contract: `docs/superpowers/specs/2026-07-17-recovery-console-and-signal-path-design.md`

## Automated checks

- `npm test`: 41/41 passing.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passing.
- Agent-control tests prove safe task, PR review, and Jira work-item events are evidence-cited, idempotent, append-only, and never append `approval.granted`.
- Server test proves the generic agent action endpoint returns the ledger-derived work-item projection.
- UI/state tests cover the compact shared-border stack, Live active-path classes, source/target acknowledgement, reduced motion, Recovery Console controls, and pure-black contrast tokens.

## Visible-browser checks

Browser: Codex in-app browser, latest server code on port 4310.

### 1440×900

- Architecture rendered 21 observed components as four touching tiers.
- Adjacent Architecture cards overlap only their shared 1 px border; consecutive tiers also share the 1 px boundary.
- Architecture contained no dependency SVG or pulse layer.
- Live showed a single active semantic path at a time. The active path used a 2.8 px blue stroke while quiet paths remained 1.45 px neutral strokes.
- The signal sequence advanced deterministically to the next edge and acknowledged the destination component.
- Recovery Console displayed the accepted root cause (94%), rejected Kafka diagnosis (22%), synchronized agent graph, Manager command, action queue, and timeline.
- Internal task delegation, PR review proposal/approval, Jira draft/approval, and conversational task assignment were exercised successfully.
- The work queue reached six real append-only ledger records.
- Pure-black mode computed `--line-strong: #f0f0f0`, node borders `rgba(255, 255, 255, 0.78)`, and agent connector strokes `rgb(240, 240, 240)`.

### 1280×800

- Architecture rendered 22 observed components within the viewport (`84.5 px` to `1195.5 px`).
- Every horizontal and vertical Architecture boundary measured `-1 px`, confirming shared borders with no visual gaps.
- Settled Live layout contained 23 components with zero component overlaps.
- Recovery Console contained 13 agent/control nodes with zero node overlaps; the command rail remained fully inside the viewport.

### Accessibility and browser quality

- Architecture tiers expose named regions and every component retains its type and status in the accessible name.
- Live edge names retain explicit `from` and `to` direction.
- Recovery Console exposes named Diagnosis, Agent execution, Manager command, Work queue, action, and chat controls.
- Keyboard-focus styles remain present in both themes.
- Reduced-motion CSS removes moving pulses while retaining the active route and endpoint outlines.
- Browser console: 0 errors, 0 warnings after mode switching, safe-action execution, chat dispatch, and theme switching.

## Screenshots

- `recovery-console-architecture-light.png` — compact connection-free Architecture.
- `recovery-console-live-signal.png` — full-route Live signal activation and destination acknowledgement.
- `recovery-console-light.png` — developer recovery workspace in light mode.
- `recovery-console-dark.png` — high-contrast pure-black Recovery Console with recorded work items.

## Real versus captured behavior

- **Real local state:** the currently displayed Live topology is projected from the configured local OpenTelemetry Collector files. Service/dependency counts can change as new OTLP records arrive. Evidence records are content-hashed by the existing source projection.
- **Real product runtime:** Manager messages and safe work actions append to the local SQLite append-only ledger and immediately update the ledger-derived SSE/control projection.
- **Captured deterministic evidence:** the Astronomy Shop checkout/payment causal investigation, evaluator rejection, owner-gated rollback, verification, and regression story remain the deterministic judge replay.
- **Optional integration:** the server reports GPT-5.6 live investigation availability when `OPENAI_API_KEY` is configured. This QA run reported live GPT-5.6 availability.
- **Not configured:** Langfuse was not configured in this local run; the UI labels that limitation and keeps the ledger authoritative.
- **Intentionally not external:** PR and Jira controls create cited internal drafts and human review records only. They do not call GitHub or Jira and are labeled `draft only · connector not configured`.


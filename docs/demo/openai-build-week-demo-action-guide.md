# FlowPulse OpenAI Build Week Demo Action Guide

## Purpose

This is the presenter runbook for the OpenAI Build Week submission video. The target runtime is **2 minutes 45 seconds**, leaving fifteen seconds below the official three-minute limit.

The demo must prove one product idea:

> FlowPulse turns an invisible distributed system into a living agentic workspace, where specialized agents detect, investigate, evaluate, repair, and verify incidents autonomously.

The primary scenario is a low-risk, reversible checkout/payment configuration failure. It completes without human intervention. Medium- and high-risk actions remain protected by a human gate outside this primary path.

## Recording preflight

- Start from a healthy system and an empty incident timeline.
- Confirm Architecture, Live, Diagnose, Recovery, and Compare use the accepted visual system.
- Confirm the provider badge reads `LOCAL CODEX`, not `RECORDED/DEMO`.
- Confirm the selected demo case is `checkout-payment-config`.
- Confirm fault injection and repair affect only the isolated local fixture.
- Warm the local server and Codex provider before recording.
- Close unrelated windows, notifications, secrets, raw prompts, and terminal output.
- Record at a resolution where citations, agent names, node status, and recovery metrics remain readable.
- Use English narration and avoid third-party music or unlicensed visual material.

## 2:45 primary run

| Time | Presenter action | Expected screen evidence | Narration |
| --- | --- | --- | --- |
| 0:00–0:12 | Open **Architecture**. Hold briefly on the observed system and the separate FlowPulse Agent Team. | System layers are legible. FlowPulse is visually distinct from the data source. Observer, Orchestrator, Investigator, and Evaluator are visible. | “FlowPulse turns an invisible distributed system into a living agentic workspace, where specialized agents understand both the system and their own responsibilities.” |
| 0:12–0:28 | Select **Live**. Let the architecture transition into the connected runtime graph. | Existing components reorganize smoothly. Healthy nodes and animated data pulses show the baseline flow. | “The static architecture becomes a live operational map. We can see which components are healthy and how data moves through the system in real time.” |
| 0:28–0:40 | Trigger the `checkout-payment-config` fault. Do not navigate away. | Payment becomes unhealthy first. The fault propagates toward checkout and later Kafka-related symptoms without obscuring the initiating node. | “Now we inject a reversible endpoint configuration failure. FlowPulse immediately shows where the problem starts and how its impact spreads downstream.” |
| 0:40–0:58 | Let the Observer stage run automatically. Open the Agent Team panel only after detection appears. | Observer detects the bounded anomaly, creates an incident, cites source evidence, and records the first event without a user diagnosis prompt. | “Observer continuously watches the connected evidence sources. It detects the anomaly and opens a bounded incident automatically—no one has to begin the investigation.” |
| 0:58–1:22 | Follow the Orchestrator handoff into Investigator. Select the active agent messages as they arrive. | Explicit role routing is visible. Orchestrator assigns causal work; Investigator queries bounded evidence and cites exact evidence IDs. | “Orchestrator assigns the right work to the right specialist. Investigator follows logs, metrics, traces, deployment changes, and topology evidence instead of guessing from a single alert.” |
| 1:22–1:42 | Highlight the root-cause conclusion and the downstream Kafka signal. | The endpoint mismatch is marked as the initiating cause. Kafka lag is rejected as a later symptom using timing evidence. | “The evidence shows that checkout selected an unreachable payment endpoint. Kafka lag appeared later, so it is an effect—not the initiating cause.” |
| 1:42–1:58 | Advance to Evaluator. Keep citations and verdict visible. | Evaluator adversarially checks the hypothesis, evidence coverage, causal ordering, and repair boundary. The evaluation passes without changing runtime truth. | “Evaluator independently challenges that diagnosis. Only a cited, causally ordered hypothesis can pass this quality gate.” |
| 1:58–2:18 | Allow the low-risk policy to authorize and execute the bounded repair. | The plan identifies risk, reversibility, action, and verification criteria. The local endpoint repair runs without a human click. | “Because this repair is local, reversible, and policy-approved, FlowPulse executes it autonomously. Higher-risk actions would stop at a human gate.” |
| 2:18–2:34 | Switch focus to the recovering graph and then **Compare**. | Payment and checkout recover, downstream lag converges, pulses return, and independent checks show before/after values. | “FlowPulse does not stop when a command succeeds. It verifies that the root condition disappeared, direct symptoms cleared, and downstream behavior recovered.” |
| 2:34–2:42 | Reveal the completed Agent Timeline and evidence trail. | Ordered stages show detect, route, investigate, evaluate, plan, authorize, repair, verify, and recovered. Each decision is attributable and replayable. | “Every agent action, handoff, citation, decision, repair, and verification remains transparent and replayable.” |
| 2:42–2:45 | Return focus to the recovered Live graph. | Healthy topology and completed status remain visible. | “Not another observability dashboard—an autonomous, evidence-grounded operations team that shows its work.” |

## Required success criteria

Do not use a recording take unless all of these are visible and true:

- The demo starts healthy and the injected failure is visibly distinct.
- Observer detects the fault without being told its root cause.
- Role routing is explicit; no agent silently impersonates another role.
- Investigator cites evidence and separates initiating cause from Kafka lag.
- Evaluator produces a completed verdict from `codex-local`.
- The repair is labeled low-risk, reversible, and local-only.
- Repair execution is followed by independent verification.
- The final state is `recovered`, not merely `repair_executed`.
- The timeline remains ordered and replayable.
- No raw provider payload, secret, chain of thought, or misleading `LIVE` claim appears.

## Optional safety proof

If the primary run finishes early, use no more than eight seconds to show the `insufficient-evidence` case stopping at `needs_human` without a repair event. Remove this beat before shortening the causal investigation or recovery proof.

Narration:

> “When evidence is insufficient or authority is higher, the same loop stops safely and asks for human judgment.”

## Failure recovery during recording

| Failure | Presenter response |
| --- | --- |
| Provider is unavailable | Stop the take. Re-authenticate or restart the local Codex adapter. Never substitute recorded output while claiming a live run. |
| An agent response exceeds the planned timing | Pause recording and restart the take after warming the provider. Do not accelerate the footage enough to make evidence unreadable. |
| The diagnosis cites no evidence | Reject the take and rerun. Evidence-grounding is a core technical claim. |
| The repair runs but verification fails | Keep the failed run as engineering evidence, but do not use it as the primary submission take. Diagnose the failure before recording again. |
| The UI loses the active incident state | Restart from a clean healthy baseline and create a new run. Do not splice incompatible run IDs. |
| A secret or raw prompt appears | Stop immediately and discard the recording. |

## Two-minute fallback cut

If the final edit must be shortened:

- Architecture and healthy baseline: 15 seconds.
- Fault injection and visual propagation: 15 seconds.
- Observer, Orchestrator, and Investigator: 40 seconds.
- Evaluator and autonomous policy decision: 25 seconds.
- Repair, recovery, and Compare: 20 seconds.
- Codex contribution and closing: 5 seconds.

Never remove the evidence-grounded diagnosis, evaluator gate, or verified recovery. Those three moments establish the non-trivial Codex implementation.

## Submission alignment

The video should make the judging criteria observable rather than describe them abstractly:

- **Technological implementation:** real local Codex role calls, bounded tools, evidence citations, evaluator gate, repair and independent verification.
- **Design:** one coherent Architecture-to-Live-to-Recovery experience with smooth state transitions.
- **Potential impact:** a real operations team can understand and resolve a cross-component incident without manually correlating disconnected tools.
- **Quality of the idea:** FlowPulse is an inspectable autonomous operations team, not another alert summary or generic chatbot.

The README and submission text must separately document Codex collaboration, the new work completed during the competition period, installation/testing instructions, and the primary project Session ID.

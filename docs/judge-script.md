# FlowPulse judge script

Target time: 2 minutes 20 seconds.

## Opening (0:00-0:20)

"FlowPulse turns fragmented telemetry into an incident loop that can be challenged, safely repaired, verified, and learned from. The append-only ledger is the runtime authority; every model claim must cite evidence."

Start `npm run judge`. The product opens on the current four-layer Architecture projection; point out that the components come from the selected OTLP source, then open **Diagnose**.

## False diagnosis (0:20-0:50)

Click **Run guided replay**.

The investigator sees checkout errors, consumer delay, and Kafka lag, then blames Kafka. The adversarial evaluator rejects the claim because broker health is normal and payment failures precede lag by 171 seconds.

Point out the red evaluator record and its counter-evidence citations.

## Evidence-driven replan (0:50-1:20)

FlowPulse searches upstream changes instead of retrying the same theory. The evidence inspector shows:

- Checkout deployment `deploy-checkout-442`
- Trace `4f91` calling `payment:9090` and failing before Kafka publish
- Checkout log selecting the fallback endpoint
- Commit `c7e1b9a` renaming the environment key without a deployment change

The evaluator now accepts a complete change, mechanism, timing, and propagation chain.

## Human gate and recovery (1:20-1:50)

The state machine proposes only a checkout rollback. Click **Recover** to open the Manager. Point out the rejected diagnosis, accepted root cause, evidence IDs, and bounded checkout-only action, then use the separate **Approve bounded checkout recovery** control.

Point out that approval is an immutable ledger event and precedes repair execution. FlowPulse switches to **Recovery Console**, where the accepted diagnosis, Manager command, safe work queue, and Owner/Executor/Verification/Evolve/Test roles update from the same event stream. The verification projection then shows payment reachability at 99.98%, checkout errors at 0.8%, and Kafka lag draining to 620 without a Kafka repair.

## Learning and live mode (1:50-2:20)

FlowPulse classifies both the confirmed system bug and the agent false positive. It creates a regression case, runs six deterministic gates, and leaves promotion at an owner-review boundary.

Close with: "The reliable replay is what you just saw. With credentials, the same product runs a fresh GPT-5.6 tool loop and adversarial evaluator, with LLM calls, tools, latency, usage, and scores mirrored to Langfuse."

If time permits, show the **Run fresh GPT-5.6** control and the Langfuse trace link.

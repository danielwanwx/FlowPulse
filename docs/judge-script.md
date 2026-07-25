# FlowPulse judge script

Target time: 2 minutes 20 seconds.

## Opening (0:00-0:20)

"FlowPulse turns fragmented telemetry into an incident loop that can be challenged, safely repaired, verified, and learned from. The append-only ledger is the runtime authority; every model claim must cite evidence."

On macOS or Linux with Node.js 20+ and `sqlite3`, run `npm test && npm run demo`; no Docker, telemetry collector, or OpenAI credential is needed. The product opens on the current Architecture projection. Point out the **deterministic replay** label, then open the persistent **Incident** workspace at **Investigate**.

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

The state machine proposes only a checkout rollback. In the Incident workspace, move from **Investigate** to **Decide**. Point out the rejected diagnosis, accepted root cause, cited evidence, and bounded checkout-only action; then use the backend-recorded owner approval control.

Point out that approval is an immutable ledger event and precedes repair execution. The same Incident workspace advances to **Execute**, where the accepted diagnosis and bounded recovery update from the same event stream, then to **Verify**, where comparison is available only after independent verification. The verification projection shows payment reachability at 99.98%, checkout errors at 0.8%, and Kafka lag draining to 620 without a Kafka repair.

## Learning and live mode (1:50-2:20)

FlowPulse classifies both the confirmed system bug and the agent false positive. It creates a regression case, runs six deterministic gates, and leaves promotion at an owner-review boundary.

Close with: "The reliable replay is what you just saw. With credentials and a fresh local OTLP spool, the same product freezes a bounded, hashed evidence snapshot for the GPT-5.6 tool loop and adversarial evaluator. It never sends an unbounded live stream or silently substitutes the fixture. Langfuse is an optional observation mirror; the ledger remains authority."

Do not show a GPT or Langfuse control unless the presenter has intentionally
configured it. The exact 2:30 recording plan is in
[`docs/submission/video-script.md`](submission/video-script.md).

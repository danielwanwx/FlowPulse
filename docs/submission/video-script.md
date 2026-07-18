# FlowPulse demo video — 2:30

Use the fresh deterministic server started with `npm start`. Do not show an
unconfigured GPT or Langfuse control. The timer below totals approximately
2:32 including transitions.

| Time | Shot / click | Voiceover |
| --- | --- | --- |
| 0:00–0:20 | Open **Architecture** at full canvas. Point to the checkout, payment, Kafka, accounting, and fraud layers. | “Production incidents are not a dashboard problem. They are a trust problem: which signal caused what, which AI claim survives challenge, and who can safely act? FlowPulse turns telemetry into an evidence-grounded recovery loop.” |
| 0:20–0:35 | Click **Diagnose**, then **Run guided replay**. | “This is a captured OpenTelemetry Astronomy Shop incident, replayed from an append-only ledger. A checkout change makes payment unreachable; retries contribute to Kafka lag and downstream work falls behind.” |
| 0:35–0:55 | Pause on **Wrong hypothesis rejected**. Open the evaluator/counter-evidence annotation. | “The investigator first blames Kafka. FlowPulse does not accept a plausible story: its adversarial evaluator rejects the claim because payment failure precedes lag and broker health does not prove root cause.” |
| 0:55–1:18 | Step or play to **Root cause**. Select the checkout or payment evidence drawer. | “The replan joins the versioned checkout change with a failing payment trace, a checkout log, and metrics. Every claim is cited; the right drawer keeps raw detail available without making the canvas a report.” |
| 1:18–1:42 | Advance to **Owner gate**, click **Recover**, then show the bounded proposal and the separate owner approval control. | “The system can propose only one checked-in checkout recovery. The manager can explain and assign safe work, but cannot approve. The repair boundary is explicit: target checkout, one allowlisted command, and one human gate.” |
| 1:42–2:02 | Approve and show **Recovery Console**. | “After the owner event, the recovery console projects the same ledger: execution, fresh verification, Evolve, and Test. No model or observability vendor becomes runtime authority.” |
| 2:02–2:20 | Open **Compare** and drag its before/after split. | “Compare is not just a color change. It shows the causal decision, bounded repair, verified recovery metrics, and the regression record engineers can replay next time.” |
| 2:20–2:32 | Keep Compare visible. | “The judge path is deterministic and credential-free. Separately, FlowPulse completed a real local OTLP proof and one GPT-5.6 frozen-snapshot run that failed closed when evidence was insufficient. That is the point: safe automation earns trust by knowing when to stop.” |

## Capture checklist

1. Start the fresh process with a temporary ledger and confirm the header says
   `Deterministic replay` rather than live telemetry.
2. Record at 1440×900. Keep browser zoom at 100%.
3. Do not show any API key, Docker terminal, local paths, raw telemetry, or
   unconfigured Langfuse link.
4. Follow the exact click order above; the guided replay makes it repeatable.

# FlowPulse submission checklist

| Gate | Status | Owner action |
| --- | --- | --- |
| Repository / release candidate | Ready: [github.com/danielwanwx/FlowPulse](https://github.com/danielwanwx/FlowPulse) on `main` after this metadata pass | None. |
| Deterministic judge path | Verified: `npm ci && npm test && npm start` | `npm run submission:check` has a known false positive on tracked synthetic test data; repair and rerun it before final submission. |
| Runtime-proof record | Ready locally | Keep the linked QA record with submission materials. |
| Hosted URL | Pending external human gate | Deploy the approved Docker image or equivalent behind authentication as appropriate; do not expose local mutation mode. |
| Public video URL | Pending external human gate | Record/upload the 2:30 script and paste the public URL. |
| Required primary `/feedback` Session ID | `019f6eaf-ded3-78e1-a9c3-8ae4fd6811e2` | Already entered in Devpost. This original primary Build Week session contains the majority of core work; record future teammate sessions as secondary provenance unless evidence proves that majority shifted. |
| Devpost fields | Draft ready in `devpost.md` | Paste final title, description, links, screenshot set, and verified claims. |
| Final Devpost submission | Pending external human gate | Review and submit after all links and `/feedback` value are confirmed. |

## Required final commands

```bash
npm ci
npm test
npm start
```

The test suite includes an isolated fresh-port server, verifies `/api/health`,
and drives the full deterministic incident through the owner gate. It requires
no Docker, OpenAI, Langfuse, or telemetry collector. Repair and rerun the
separate `submission:check` wrapper before claiming final release readiness.

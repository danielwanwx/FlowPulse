# FlowPulse submission checklist

| Gate | Status | Owner action |
| --- | --- | --- |
| Repository / release candidate | Ready locally at `85f1d39` baseline plus release-candidate commit | Choose and publish the approved repository URL. |
| Deterministic judge path | Ready: `npm ci && npm run submission:check && npm start` | None. |
| Runtime-proof record | Ready locally | Keep the linked QA record with submission materials. |
| Hosted URL | Pending external human gate | Deploy the approved Docker image or equivalent behind authentication as appropriate; do not expose local mutation mode. |
| Public video URL | Pending external human gate | Record/upload the 2:30 script and paste the public URL. |
| Candidate task Session ID | `019f6eaf-ded3-78e1-a9c3-8ae4fd6811e2` | This is a candidate task ID only. The required `/feedback` value must be generated and confirmed in this task; it must not be invented from this value. |
| Devpost fields | Draft ready in `devpost.md` | Paste final title, description, links, screenshot set, and verified claims. |
| Final Devpost submission | Pending external human gate | Review and submit after all links and `/feedback` value are confirmed. |

## Required final commands

```bash
npm ci
npm run submission:check
npm start
```

The release check starts an isolated temporary server, verifies health, runs
the full deterministic incident through its owner gate, and exits. It requires
no Docker, OpenAI, Langfuse, or telemetry collector.

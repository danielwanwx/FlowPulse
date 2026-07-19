# OpenAI Build Week submission checklist

**Competition:** OpenAI Build Week 2026
**Category:** Developer Tools
**Deadline:** July 21, 2026, 5:00 PM PDT
**Devpost submission:** `1094090`, owner-reported **Draft (3/5)**

Official references: [OpenAI Build Week](https://openai.com/build-week/) and
[OpenAI Build Week on Devpost](https://openai.devpost.com/). Official materials
require a project built with Codex and GPT-5.6, one category, a repository
(public with license, or correctly shared if private), a public
under-three-minute video with audio, and the `/feedback` Session ID for the
session where most core functionality was built.

| Requirement | Status | Evidence / owner action |
| --- | --- | --- |
| Working project | PASS | Deterministic judge path: `npm ci && npm test && npm start`; the suite passed in this audit. |
| Release wrapper `npm run submission:check` | MISSING | It currently flags tracked `OPENAI_API_KEY="synthetic-test-only"` test data as a credential before tests run. Repair and rerun before final submission. |
| One selected category | PASS | Developer Tools. Do not enter multiple categories. |
| Project description | VERIFY | Draft copy is in `docs/submission/devpost.md`; owner verifies Devpost matches it. |
| Public repository and license | PASS | <https://github.com/danielwanwx/FlowPulse>, MIT `LICENSE`. If made private, share with required judging accounts. |
| README setup, sample data, test path | PASS | README names Node 20+, `sqlite3`, captured Astronomy Shop data, judge path, and tests. |
| Codex and GPT-5.6 explanation | PASS | README and Devpost draft distinguish Codex work, bounded GPT-5.6 mode, and deterministic replay. |
| Public under-3-minute narrated YouTube video | MISSING | Owner records/uploads the truthful script in `docs/submission/video-script.md`; narration explains Codex and GPT-5.6. |
| Hosted/review URL | VERIFY | Localhost is not public. Owner supplies a truthful hosted link only if deployed safely. |
| Required primary `/feedback` Session ID | PASS | `019f6eaf-ded3-78e1-a9c3-8ae4fd6811e2` is entered and is the original primary Build Week session. Do not replace it by default. |
| Secondary teammate-session provenance | MISSING | Record each new Shrik implementation-session ID in PR/handoff notes; do not replace the primary field. |
| Team member accepted | VERIFY | Confirm Shrik's Devpost invitation is accepted and contributor credit is correct. |
| Screenshots/demo assets | VERIFY | Review `docs/submission/screenshots/`; only show current truthful product states. |
| Developer Tools install/support instructions | PASS | README documents macOS/Linux, Node 20+, `sqlite3`, credential-free replay, and opt-in local development. |
| Final rules/terms checkbox | OWNER ONLY | Owner reviews rules and checks the final Devpost box. |
| Final Submit | OWNER ONLY / MISSING | Owner submits only after every VERIFY/MISSING item resolves before deadline. |

## Final owner sequence

1. Pull `main`, run `npm ci && npm test`, and start the local judge path once.
   Repair and rerun `npm run submission:check` before final submission.
2. Review README, Devpost copy, screenshots, and video against deterministic
   replay. Remove unsupported claims.
3. Upload/publicly verify the narrated YouTube video and any hosted URL.
4. Confirm Shrik's teammate status and repository visibility/share settings.
5. Keep the primary Session ID above. Record later Codex session IDs separately.
6. Complete the official rules checkbox and press **Submit**. These are
   owner-only actions.

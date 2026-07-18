# Always-available honest Compare

## Goal

Make Compare immediately accessible without implying that an unfinished current run has already recovered.

## Bounded design

- Keep the existing interactive incident-versus-recovery split canvas, slider, presets, metrics, node identities, and deterministic `compareFrames()` projection.
- Remove the frontend gates that block Compare in development mode or before recovery verification.
- When the current ledger contains a passed `verification.completed` event, label the view `Current verified run` and describe it as an authoritative comparison from the current run.
- Otherwise label the view `Captured recovery preview` and state that the verified side comes from the deterministic captured incident bundle.
- The preview never changes runtime state, advances the replay, approves remediation, or writes ledger events.
- A later refresh or replay step automatically changes the provenance label from preview to current verification when the ledger proves recovery.

## State contract

| Current state | Compare availability | Provenance |
| --- | --- | --- |
| Development case before verification | Available | Captured recovery preview |
| Deterministic replay before verification | Available | Captured recovery preview |
| Passed `verification.completed` event | Available | Current verified run |

Only a passed verification event counts as current verified recovery. Stage position, UI cursor, and `state.complete` alone do not.

## Checks

- The Compare mode button always changes the mode when state is loaded.
- Pre-verification and development states expose the preview label and captured-bundle explanation.
- A passed verification event exposes the current-run label.
- The canvas and accessible range label identify preview versus current provenance.
- Existing Compare drag behavior and deterministic frame tests remain green.
- Browser console reports zero errors and warnings in light and dark themes.

## Stop conditions

Stop when Compare can be opened from any run stage, provenance is explicit in visible and accessible copy, automated tests pass, browser QA passes, the latest server remains available on port 4310, and the worktree is committed and clean. Do not add backend state, synthetic telemetry, or automatic remediation side effects.

## QA record

- Full automated suite: 47/47 passing.
- Pre-verification replay: Compare opened at the Propagate stage without advancing or mutating the run.
- Provenance: the visible badge reads `Captured recovery preview`; the caption and canvas accessible name identify the deterministic captured incident bundle.
- Interaction: the `70% verified` preset changed the shared split to 30% incident and 70% verified.
- Themes: light and pure-black Compare views both rendered at 1440x900.
- Browser console: zero errors and zero warnings.
- Screenshots: `docs/qa/always-available-compare-preview-1440x900.jpg` and `docs/qa/always-available-compare-preview-dark-1440x900.jpg`.

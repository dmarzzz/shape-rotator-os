# Shape Rotator OS — v0.3.10-rc.2

Pre-release off `main`. Changes since **v0.3.10-rc.1**.

## Cohort
- **Distilled transcripts read live** from Supabase, with a raw ↔ distilled toggle on the Context page; the reader now matches the engine's real readout shape (#448).
- Calendar **Timeline**: the level pill works on first open and the view fills the canvas (#446); agenda filter controls consolidated (4 rows → 2) with a scope-chip cue (#446 follow-ups).

## Profile / sphere
- Render the **saved custom shader** on the profile, not just in the editor (#449).

## Release / CI
- The cohort-key bake into release builds is wired (carried from v0.3.10-rc.1 prep).
- Release-sync now rides a PR instead of a direct push to `main` (#441).
- Relanded the additive cohort-view deltas onto the v0.3.10 line (#452).

## Release hygiene (this rc)
- Removed 3 stray renderer `console.log`s (membrane mount ×2, boot reconcile) per the no-console.log house rule.
- Excluded test files + scratch harnesses from the packaged asar (`build.files`: `!src/**/*.test.mjs`, `!src/**/*.test.js`, `!src/**/_*-harness.html`).

## Notes
- Cohort DB migrations remain deployed; to ship gated **T2** evidence to every install, provision `SRFG_COHORT_KEY` (repo secret for CI, or `export … && npm run dist:*` locally). Without it the build is T3-only (graceful). See `docs/COHORT_KEY_BUILD_INJECT.md`.

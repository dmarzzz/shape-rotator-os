# Shape Rotator OS — v0.3.8-rc.2

Pre-release off `main`. Highlights since **v0.3.8-rc.1** (2026-06-15).

## Cohort evidence — live & gated
- Session evidence now surfaces in the cohort views: a `↳ sessions` overlay on **say / did / shipped**, a `from sessions` row in the shared **dossier**, and collaboration edges woven into the **relationship map** (#434, #437). Read **live** from Supabase as a runtime overlay — never baked into the committed bundle.
- Gated **T2** cohort evidence reads via a `role=cohort_app` key shipped in the build (#436); the public web stays anon/T3. The key is baked at build time from `SRFG_COHORT_KEY` and is never committed to the repo.
- Fixed the gated read to send the anon key as `apikey` and the cohort token only in `Authorization` (#438) — required by the Supabase API gateway.

## Bubble-map cohort relationship view
- New nested circle-packing relationship map (#423) with per-view zoom (#425), label + polish passes (#420, #422), and a focal-fit **Venn** inspector (#426), plus 7 verified bug fixes (#427).

## Timeline + PMF
- Multi-track **Timeline** view on the calendar page (#424) with a live standing read.
- PMF evidence rework + a directory cards/table toggle (#431).

## Context + foundations
- "Add context" composer on the Context page → a private, anon-`INSERT`-only Supabase inbox for transcripts/notes (#435).
- Around-you topic-tag routing vocabulary migration (#419).
- Research workspace page (#428).

## Membrane + hardening
- Membrane hover-expand calendar-add (#418); share button/redirect fixes (#414, #432, #433).
- Insight + transcript contract hardening (#415, #416); private transcript host normalization (#409); public-article metadata boundary (#399); Supabase CSP fix (#410).

## Release hygiene (this rc)
- Removed stray renderer `console.log`s; excluded test files + scratch harnesses from the packaged asar; documented the reserved evidence-index helpers; wired `SRFG_COHORT_KEY` through the release workflow.

## Deploy notes
- Cohort DB migrations are **deployed** to the cohort project: the gated `cohort_app_transcript_evidence_cards` view + `cohort_app` role, the `context_submissions` inbox, and `public_team_standing_weekly`.
- To ship **T2 evidence to every install**, provision the key when cutting the release — set the `SRFG_COHORT_KEY` repo secret (CI) **or** `export SRFG_COHORT_KEY='<role=cohort_app JWT>' && npm run dist:*` (local). See `docs/COHORT_KEY_BUILD_INJECT.md`. Without it the build is **T3-only** (graceful fallback, no hard-fail).

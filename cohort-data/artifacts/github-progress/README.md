# GitHub progress artifacts

This folder is the review boundary between public GitHub commit metadata and
Shape Rotator OS product timelines.

Raw repo mirrors do not belong here. `scripts/check-github-progress.mjs` reads
public repositories through shallow blobless Git transport and can write small
JSON artifacts into `generated/`:

```bash
npm run audit:github-progress -- --write-artifacts
```

Generated artifacts are evidence candidates. They should be reviewed before
they are promoted into the app timeline.

Reusable flow:

```bash
npm run audit:github-progress -- --write-artifacts
npm run review:github-progress -- --list --recommendation promote_candidate
npm run review:github-progress -- --artifact-id github-progress:dealproof:kkoci-dealproof:2026-06-08 --reviewer operator --note "clear weekly product movement"
npm run build:cohort
```

## Artifact kinds

`github_progress_weekly_summary`

- one team/repo/week
- summarizes commit count, coarse change categories, topic tags, and a few
  example commit subjects
- can become a team timeline item after review

`github_repo_data_quality`

- bad or unverifiable GitHub repo link
- stays operator-facing
- should not become a participant-facing timeline item

## Review status

- `generated`: produced mechanically; inspect before product use
- `reviewed`: acceptable for cohort-internal timeline projection
- `held`: do not surface; keep only as operator evidence

`scripts/build-bundles.js` only projects `github_progress_weekly_summary`
artifacts with `review_status: reviewed` into `team_timeline`.

## Surface recommendation

Generated artifacts also carry a `surface_recommendation` so review starts
from a concrete default:

- `promote_candidate`: likely useful as a weekly team timeline item after a
  quick human check
- `review`: mixed signal; inspect examples and surrounding project context
- `hold`: do not surface unless a reviewer finds a specific reason
- `operator_only`: data-quality or repo-link maintenance, not participant UI

The recommendation is not authority. `review_status` is the gate.

## Consider

Consider promoting a weekly artifact when:

- it is the team's real project repo for the period
- it has non-bot, non-admin human commits
- the summary adds dated execution evidence missing from the team profile,
  transcript anchors, or calendar
- examples point to product/research movement: feature work, meaningful fixes,
  tests, docs, launch/readout work, deployments, integrations, or proof work
- the public commit subjects are safe to show to the cohort

## Do not consider

Do not promote when the signal is mostly:

- bot/dependency churn
- generated artifacts or mirror commits
- profile/calendar/cohort admin changes
- merge/recovery noise
- personal background repos not tied to the current team project
- unavailable/private/renamed repo links
- quiet public repos; those are weak evidence and belong in operator QA

Do not promote person-level claims from these artifacts unless the author match
is high-confidence and separately reviewed.

## Promotion rule

To promote an artifact, use `scripts/promote-github-progress-artifacts.mjs`.
It writes a reviewed copy into `reviewed/` and changes `review_status` to
`reviewed`; it does not edit generated artifacts in place.

Before promotion, check:

- the repo is the team's real project repo, not only a personal background repo
- the summary is not mostly bot/generated churn
- the example commit subjects are public-safe and useful
- a quiet repo is not treated as stalled project progress
- person attribution is not used unless the match is high-confidence

The promotion script refuses `hold`, `operator_only`, non-weekly, non-team, or
already-reviewed source artifacts unless `--force` is supplied. `--force`
should be rare and should include a specific `--note`.

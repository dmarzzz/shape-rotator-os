# Transcript evidence artifacts

This folder is the review boundary between private transcript readouts and
cohort-facing insight surfaces.

Raw transcripts do not belong here. `scripts/build-transcript-evidence.js`
reads `cohort-data/session-insights.json`, which already contains reviewed
session readouts with private-vault provenance, and writes generated artifacts
into `generated/`:

```bash
npm run transcripts:evidence
```

Generated evidence cards are not final weekly insights. They are structured
source cards that can be reviewed, merged, held, or promoted into role-specific
views.

## Artifact kinds

`transcript_evidence_card`

- one reviewed transcript readout
- preserves `vault_id`, consent, confidence, sharing boundary, team/person
  references, themes, Q&A, and public references
- turns readout insights into typed claims such as `product_signal`, `risk`,
  `ask`, `collaboration_edge`, `decision`, and `action_item`
- carries `private-vault:<vault_id>` provenance instead of raw transcript text

`transcript_evidence_role_views`

- generated `views.json`
- compiles cards into weekly, team, and person views
- includes a lightweight typed graph of sessions, claims, teams, people, and
  themes

## Review status

- `generated`: produced mechanically; inspect before product use
- `reviewed`: acceptable for cohort-internal projection
- `held`: do not surface; keep only as operator evidence

The generated artifacts use `review_status: generated`. A later promotion step
should copy reviewed cards into a `reviewed/` folder rather than editing
generated files in place.

## Promotion rule

Weekly insights should be compiled from reviewed evidence cards, not from raw
transcript blobs. Before promotion, check:

- the card claim is supported by the reviewed transcript readout
- team and person references are appropriate for the sharing boundary
- speaker-pending or cohort-internal consent is not treated as public clearance
- high-salience risks, asks, and collaboration edges are retained
- low-value one-off paraphrases are merged or held

Use the check command in CI or before review:

```bash
npm run transcripts:evidence -- --check
```

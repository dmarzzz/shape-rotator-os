# Transcript Distillation Playbook

This playbook defines the public-safe way to turn private transcripts into product knowledge for Shape Rotator OS. The core rule is simple: do not publish raw transcript text unless it has been explicitly cleared. Publish derived knowledge with visible provenance, confidence, consent tier, and uncertainty.

Use this alongside [reviewed-transcript-map.md](reviewed-transcript-map.md), which tracks the current vault policy, calendar anchors, and import status.

## Product Goal

The system should make cohort knowledge more usable without making private room talk more leakable.

Good transcript-derived knowledge answers:

- what changed in the product, market, team, or collaboration graph
- which project, person, or team the signal belongs to
- whether the statement is grounded, inferred, or speculative
- which private vault source it came from, without exposing the source
- what attribution or consent limits apply

Bad transcript-derived knowledge republishes:

- raw dialogue
- personal boundaries
- private customer or company examples
- fundraising, investor, pricing, or GTM details not already public
- team-specific critique that was given in a private setting
- uncertain speaker labels as if they were verified quotes

## Artifact Tiers

| tier | artifact | where it can live | use when |
|---|---|---|---|
| 0 | raw transcript | private vault only | Source capture. Never bundle in the public app or repo. |
| 1 | anchor | public repo | A calendar/session source exists, but the content itself should stay private. |
| 2 | redacted excerpt | public repo only after review | The session context itself matters, and excerpted dialogue can be safely shown. |
| 3 | distilled readout | cohort/internal product surface | The transcript should improve search, profiles, team pages, and relation graphs. |
| 4 | public article/recap | public surface after editorial review | The output is a standalone story or analysis with external facts verified. |

Default to tier 1 or tier 3. Tier 2 should be rare. Tier 4 requires stricter review because prose feels authoritative even when it was reconstructed from messy capture.

## Required Provenance Fields

Every distilled object should carry these fields:

```yaml
vault_id: kebab-case-private-source-id
source: private-vault:kebab-case-private-source-id
source_kind: transcript
source_access: private-vault
source_transform: paraphrased-distillation
evidence_level: grounded | inferred | speculative
confidence: high | medium | low
consent: cohort-internal | speaker-pending | public-cleared
attribution: direct-speaker | project-level | room-level | unattributed-theme
verbatim: false
review_status: drafted | reviewed-safe | held
```

The important field is `source_transform`. The UI and downstream prompts should be able to say "inferred from transcript" without implying the system is showing the transcript itself.

## Distillation Format

For each transcript, produce one session readout and zero or more small product cues.

Session readout:

```yaml
vault_id: example-session-2026-06-11
date: 2026-06-11
title: "Short descriptive title"
kind: workshop | lecture | salon | standup | intros | hangout
consent: cohort-internal
teams: [shape-rotator-os]
people: [person-id]
source: private-vault:example-session-2026-06-11
source_transform: paraphrased-distillation
verbatim: false
```

```md
# Short descriptive title

One sentence on what this session changed or clarified.

## themes

- theme one
- theme two

## insights

- Product-level insight, phrased as a claim the OS can route on.
- Market or GTM signal, with uncertainty called out if needed.
- Collaboration or dependency signal, tied to teams/people.

## q&a

**Q: What question would future users ask?**

Answer in paraphrase. Do not quote unless public-cleared.

## provenance

Distilled from `private-vault:example-session-2026-06-11`. Paraphrased and condensed from an automatic transcript. Speaker attribution is reconstructed unless explicitly marked direct. No verbatim quotes.
```

Product cue:

```json
{
  "teams": ["shape-rotator-os"],
  "label": "transcript-derived knowledge boundary",
  "source": "private-vault:example-session-2026-06-11",
  "source_transform": "paraphrased-distillation",
  "evidence_level": "inferred",
  "excerpt": "Raw transcripts stay private; public product knowledge should expose only derived signals, provenance, and confidence."
}
```

## Inference Labels

Use these labels consistently:

- `grounded`: directly supported by a clear segment of the transcript or an external public source.
- `inferred`: reconstructed from messy transcript context, roster matching, repeated topic mentions, or surrounding product data.
- `speculative`: plausible product implication, not a claim about what someone said or decided.

Do not hide the difference in prose. Use wording like:

- "Transcript-derived signal"
- "Inferred from the May 27 private-vault transcript"
- "Speaker attribution reconstructed at project level"
- "Thematic, unattributed distillation pending speaker consent"
- "External fact verified separately"

Avoid:

- "X said" unless speaker attribution is strong and consent allows it.
- quotation marks around cleaned-up paraphrases.
- exact timestamps from private transcripts in public artifacts.
- "the transcript proves" for anything reconstructed.

## Redaction Boundary

Strip or generalize these categories before anything leaves the vault:

- personal data, personal boundaries, medical/family/travel/private life details
- customer names, prospect names, private company examples, unreleased partnerships
- fundraising, investor, pricing, cap table, runway, revenue, or deal terms
- private GTM strategy, cold outreach targets, and sales scripts unless already public
- private product critique, team conflict, hiring/firing, interpersonal dynamics
- credentials, tokens, URLs with secrets, local paths, screenshots, account IDs
- exact room dialogue when paraphrase preserves the useful product meaning

Replace with category-level descriptions:

- "a privacy-sensitive customer example"
- "team-specific PMF critique"
- "private event-planning detail"
- "unreleased GTM detail"
- "personal boundary discussion"

## Editorial Standard From The Example

The `what-we-shipped` example is the right granularity because it does five things:

1. It turns the transcript into product movement, not dialogue.
2. It separates public baseline data from in-room reconstructed updates.
3. It marks attribution risk explicitly: most in-room voices were collapsed by a single capture device.
4. It demotes uncertain attribution to project-level reconstruction.
5. It states that quotations are faithful reconstructions, not verbatim records.

Use that pattern for cohort-wide recaps:

```md
## provenance

Reconstructed from an automatic transcript of [session name], held [date]. Baselines are from public/self-reported cohort data. Transcript-derived updates are paraphrased and condensed; speaker meaning is preserved, wording is cleaned. Quotations are faithful reconstructions, not verbatim records. Attributions are project-level unless otherwise noted.
```

## Noveltokens Scan

Public search found one relevant public prompt by `noveltokens`: [SoC2pdgTT on SnackPrompt](https://snackprompt.com/e/prompt/soc2pdgtt-stream-of-consciousness-to-pretty-dang-good-tweet-thread-tpv0IDh16), described as a tool for turning English transcripts or stream-of-consciousness notes into a coherent tweet thread while preserving intent and voice. Public GitHub profile search surfaced the [`noveltokens` GitHub profile](https://github.com/noveltokens) and visible repositories such as `Everclaw_engine`, `Clawstorage`, `RippleLedger`, `IotaTangle`, `StellarAnchor`, and `martian-connect`, but a shallow scan of those reachable repositories did not find a transcript redaction or transcript privacy implementation.

Lessons worth copying:

- Treat transcript processing as transformation, not cleanup. The output is a new artifact with its own label and purpose.
- Preserve intent and useful structure, not raw wording.
- Make the audience explicit before writing. A tweet thread, cohort readout, product cue, and public article need different detail levels.
- Do not rely on a single "redact this" pass. Use at least two passes: one to extract useful knowledge, one to audit what should not leave the vault.

## Recommended Workflow

1. Inventory the source.
   Check the calendar first, then record `vault_id`, confirmed date, calendar match, session type, project/topic basis, attendees if known, consent tier, and whether external speakers appear.

2. Classify sensitivity before summarizing.
   Mark sections as public-safe, cohort-internal, speaker-pending, or hold. If the source contains dense private critique, skip excerpting and produce only a readout.

3. Extract product knowledge.
   Pull out product movement, market signal, user/ICP evidence, collaboration edges, dependencies, asks, blockers, and follow-ups. Do not preserve conversation order unless the order matters.

4. Reconstruct attribution conservatively.
   Use direct speaker attribution only when diarization is strong. Otherwise attribute to project, team, room, or "thematic readout."

5. Write the readout.
   Use paraphrased bullets, not transcript prose. Every insight should be useful to product surfaces or search.

6. Audit for leakage and over-redaction.
   Check both sides: did private material survive, and did the distillation erase the useful product signal?

7. Ingest only the distilled artifact.
   Use `scripts/ingest-session-readouts.mjs` for structured readouts. Raw transcripts should never pass through the ingest script.

## Vault Naming And Drive Routes

Drive is the raw/source vault for recordings, transcripts, and routing evidence.
Supabase is the canonical distillation layer: `source_artifacts`,
`processing_jobs`, `derived_artifacts`, reviews, approval gates, and app-safe
views/bundles live there. The Drive `operator_review_exports` folder is only an
optional operator export or review mirror, not the system of record for
distillation. Drive folder names should be plain semantic names. Do not use
numeric lifecycle prefixes in folder names; lifecycle order belongs in the
policy and index.

Always match the transcript to a calendar event before assigning the final type,
project/topic slug, date, route, or processing queue. A confident calendar match
can confirm the file; a conflict or missing match sends the file to
`needs_calendar_match` for human review.

All transcript source files should use this preferred naming convention:

```text
type_project-name_YYYY-MM-DD.ext
```

This is the operational form of `type_project_name_date`. Use underscores
between the main components; use hyphens inside the `project-name` component.
The date must be the confirmed calendar/session date. Preserve the source
extension unless conversion is deliberate. The type prefix must be one of:

- `weekly_standup`
- `office_hours`
- `private_1on1`
- `salon`
- `rd_jam`
- `demo_presentation`
- `user_interview`
- `planning_strategy`
- `leadership_meeting`

The primary cohort event types are:

| type | event basis |
|---|---|
| `weekly_standup` | individual based |
| `office_hours` | project core team or product based |
| `salon` | topic based |
| `rd_jam` | product or technical idea based |
| `demo_presentation` | project or product based |

Restricted/special types still exist because they appear in real source
handling: `private_1on1`, `user_interview`, `planning_strategy`, and
`leadership_meeting`. `leadership_meeting` is the tightest-held route: candid
leadership/steering talk among the principals (Andrew, Tina, Dmarz, core admins)
about Shape Rotator's own direction. It is distinct from `planning_strategy`,
which is shared governance/ops work product; the leadership route is the
unfiltered principals' conversation and never leaves the locked folder.

Use these manual checks when the transcript title and calendar title are messy:

| if the calendar/transcript shows | classify as | not as |
|---|---|---|
| recurring WDYDLW, status update, individual progress, or coordinator check-in by person | `weekly_standup` | `office_hours` |
| project support, product feedback, roadmap critique, milestone review, or core-team implementation help | `office_hours` | `rd_jam` |
| open-ended whiteboarding, architecture exploration, product/technical hypothesis testing, or idea-stage workshop | `rd_jam` | `office_hours` |
| topic-led discussion, speaker-led room, or salon-style session not centered on one team's operating work | `salon` | `office_hours` |
| prepared project/product demo, presentation, intro, showcase, or presenter-owned material | `demo_presentation` | `salon` |
| external customer/user/ICP subject whose participation is research evidence | `user_interview` | `office_hours` |
| leadership/steering conversation among the principals (Andrew, Tina, Dmarz, core admins) about Shape Rotator's own direction, roadmap, people, or partner decisions | `leadership_meeting` | `planning_strategy` |
| governance, fundraising, internal planning, access policy, or coordinator strategy | `planning_strategy` | `office_hours` |

If two categories seem plausible, use the calendar event as the first anchor.
If the calendar is ambiguous, choose the more restrictive route and put the file
in `needs_calendar_match`.

Examples:

- `weekly_standup_shaw_2026-06-08.txt`
- `office_hours_conclave_2026-06-10.md`
- `private_1on1_tina-positioning_2026-05-27.txt`
- `salon_info-markets-design_2026-06-09.txt`
- `demo_presentation_elocute_2026-05-26.txt`
- `leadership_meeting_andrew-tina-direction_2026-05-30.txt`

Bad/good pairs:

| bad | good |
|---|---|
| `Conclave office hours final.txt` | `office_hours_conclave_2026-06-10.txt` |
| `Copy of Product Whiteboarding Jam Jun 9.txt` | `rd_jam_product-whiteboarding_2026-06-09.txt` |
| `WDYDLW Shaw notes latest.md` | `weekly_standup_shaw_2026-06-08.md` |
| `Project intros & workflow.txt` | `demo_presentation_project-intros-workflow_2026-05-19.txt` |

The Drive vault should route raw source files by type after the calendar check:

| type | raw Drive route | cohort rule | public rule |
|---|---|---|---|
| `weekly_standup` | `raw_transcripts/weekly_standup` | individual detail stays room/core; only aggregate signal reaches cohort | never public |
| `office_hours` | `raw_transcripts/office_hours` | project/core team by default; reviewed cohort readout allowed | not public by default |
| `salon` | `raw_transcripts/salon` | reviewed cohort readout allowed | public candidate only after editorial, speaker, and named-person passes |
| `rd_jam` | `raw_transcripts/rd_jam` | cohort only after team call and hard distillation | never public by default |
| `demo_presentation` | `raw_transcripts/demo_presentation` | reviewed cohort readout allowed | public candidate requires presenter approval plus editorial and named-person passes |
| `private_1on1` | `do_not_publish/private_1on1` | no cohort artifact | never public |
| `user_interview` | `raw_transcripts/user_interview` | only aggregate insights may travel | interview itself never widens |
| `planning_strategy` | `do_not_publish/planning_strategy` | coordinator/core only | never public |
| `leadership_meeting` | `do_not_publish/leadership_meeting` | leadership/admins only; never distilled | never public |

Drive admins/managers for the transcript vault are Tina, Andrew, Dmarz, Michael,
Fred, and Albi. Their email targets are supplied through private operator env,
not committed defaults.

## Current Cloud Command Path

The production path must not depend on Michael's laptop. Local commands are
debug harnesses; the durable path is Google Drive as the private source vault,
Supabase as the distillation system of record, and a deployed Supabase Edge
Function as the worker.

The current operator sequence is:

```bash
npm run transcripts:vault:prepare -- --files cohort-data/.private/transcript-vault/vault-files.json --shared-drive-id 0AGxjupTyJVrKUk9PVA --raw-folder-id 1Osmza5ttUwT5xFW0_zS8sDPDA3aLCqzb
npm run transcripts:drive:plan
npm run transcripts:sessions:map -- --env-file .env.calendar.local
npm run transcripts:supabase:plan -- --env-file .env.calendar.local --session-map cohort-data/.private/transcript-vault/transcript-session-map.json
npm run calendar:supabase:upsert -- --input cohort-data/.private/transcript-vault/transcript-supabase-plan.json --apply
supabase functions deploy process-transcript-jobs --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt --use-api
supabase functions deploy review-transcript-artifact --project-ref "$SUPABASE_PROJECT_REF"
supabase db push
npm run transcripts:worker:vault-sql -- --env-file .env.calendar.local
npm run transcripts:evidence
npm run build:cohort
```

The deployed worker is invoked by a server-side caller with
`TRANSCRIPT_WORKER_TOKEN` or by a coordinator/admin JWT:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/process-transcript-jobs" \
  -H "Authorization: Bearer $TRANSCRIPT_WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"org_id":"'"$ORG_ID"'","limit":5,"apply":true}'
```

For the no-local-PC end state, apply the transcript worker schedule migrations,
then seed Supabase Vault with the private SQL generated by
`transcripts:worker:vault-sql`. The schedule uses `pg_cron` plus `pg_net` to call
`/functions/v1/process-transcript-jobs` at minute `0` and `30` each hour. The
migrations store only Vault secret names and do not enable the cron job until the
Vault secrets exist; the generated SQL with secret values is written under
`cohort-data/.private/`, enables the schedule after seeding, and must not be
committed.

The local-only commands below remain useful for testing and emergency replay,
but they are not the end-state runtime:

```bash
npm run transcripts:drive:fetch -- --env-file .env.calendar.local
npm run artifacts:distill -- --transcript transcript.txt --session session.json --source-artifact source-artifact.json --processing-job processing-job.json
npm run artifacts:worker -- --input worker-batch.json --transcript-root ./private-transcripts --out worker-output.json
npm run artifacts:worker -- --supabase-url "$SUPABASE_URL" --service-role-key "$SUPABASE_SERVICE_ROLE_KEY" --org-id "$ORG_ID" --transcript-root ./private-transcripts --apply
```

The vault command turns the private Drive inventory into external T0 refs,
preferred filenames, policy routes, and a manual-review queue. The Drive plan is
a dry run for folder ensures, manager grants, renames, and moves; it is not the
distillation state machine. The Supabase bridge plan is also dry run: it emits
apply-ready `sourceArtifacts`,
`ingestionEvents`, and `processingJobs` only when a matched transcript has a
resolved high-confidence `session_id`; otherwise it places the transcript in a
session-link or manual-review queue. The session-map step reads Supabase
session rows and only auto-links same-day transcript refs when title tokens
agree; coarse day-bucket sessions stay in review. It does not read raw
transcript text. The Supabase upsert creates `ingestion_events`,
`source_artifacts`, and queued `processing_jobs` rows; the Edge Function then
fetches the private Google Drive source in memory, writes `needs_review`
derived artifacts, creates public approval gates when policy allows T3, and
marks the job/session state. The function response returns counts, IDs, hashes,
sizes, and MIME types only, never raw transcript text or draft prose.

The cohort lane should move quickly: a gated T2 readout is the fast lane and
should normally ship within roughly 48 hours of the session when the policy
allows it. T3 publication is a separate later step requiring the relevant
consent, editorial, speaker/presenter, and named-person gates.

After the worker writes `derived_artifacts`, export only reviewed app-safe rows
by default:

```bash
npm run transcripts:distillations:export -- --env-file .env.calendar.local
```

For operator review, write the broader manifest under `.private/` so
`needs_review` public candidates do not become the default app bundle:

```bash
npm run transcripts:distillations:export -- --env-file .env.calendar.local --out cohort-data/.private/transcript-vault/transcript-distillations-review-manifest.json --include-needs-review
```

Review decisions should go through the guarded review command or the
`review-transcript-artifact` Edge Function used by the operator queue. T2
approval marks an artifact cohort-visible; T3 publication requires
`--publish-public` / `publish_public=true` and all approval gates to be
`approved` or `not_required`. The server-side path writes `artifact_reviews`
and `audit_log` rows; browser clients should not patch `derived_artifacts`
directly for review state.

Supabase app clients should not read `source_artifacts`, `processing_jobs`, or
raw `derived_artifacts` directly. Those tables are coordinator/operator
surfaces. Cohort members should read the reviewed, column-limited
`app_transcript_distillations` view or the generated app bundles only. That view
omits source artifact IDs, processing job IDs, storage refs, source hashes, and
raw availability fields; it exposes T2 reviewed/published distillations and T3
published artifacts only when the caller is an org member.

T3 is not a license to publish named transcript recap material. Public articles
should be generalized insight pieces, matching the existing journal style:
no named participants, no named cohort teams/projects as the source of a claim,
no vault IDs, no raw quotes, and no "X said Y" framing. The app may retain
internal provenance, but the public article candidate should carry
`article_mode: generalized_no_named_insights` and `named_entities_allowed: false`.

```bash
npm run transcripts:distillations:review -- --env-file .env.calendar.local --artifact-id DERIVED_ARTIFACT_ID --tier T2 --decision approve --note "reviewed for cohort" --apply
npm run transcripts:distillations:review -- --env-file .env.calendar.local --artifact-id PUBLIC_CANDIDATE_ID --tier T3 --decision approve --note "approved for public" --publish-public --apply
```

The evidence step compiles already-reviewed `session-insights.json` into typed
evidence cards and weekly/team/person views. `build:cohort` carries the compact
`transcript_evidence` view bundle into `apps/os/src/cohort-surface.json`, so app
surfaces can use it without fetching raw transcripts or private vault plans.

The one-off distillation command reads a single transcript locally and emits
Supabase-ready `derivedArtifacts`, optional completed `processingJobs`, and
public `approvalGates` when the session policy allows T3. The local worker
processes queued jobs from a fixture batch or live Supabase queue, reads only
files under `--transcript-root`, writes derived rows/gates, and patches
job/session status. Neither local command includes the raw transcript text in
the output. Treat every generated output as a draft that still requires human
review before cohort or public publication.

## Distillation Prompt

Use this prompt for a first pass, then manually audit the output.

```text
You are turning a private transcript into a Shape Rotator OS knowledge artifact.

Do not quote the transcript. Do not preserve raw dialogue. Do not expose personal, customer, investor, pricing, fundraising, private GTM, team-critique, credential, local-path, or private-boundary details.

Produce a paraphrased, product-useful distillation with:
- vault_id
- date
- title
- kind
- consent tier
- teams and people ids if known
- themes
- insights
- Q&A pairs users might search for later
- product cues for team/person/project pages
- evidence_level per claim: grounded, inferred, speculative
- attribution level per claim: direct-speaker, project-level, room-level, unattributed-theme
- provenance note saying this is distilled from a private-vault transcript, not a verbatim transcript

If speaker diarization is messy, say attribution is reconstructed. If an external or featured speaker appears, keep the readout thematic and unattributed unless consent is public-cleared. If uncertain, mark confidence medium or low and explain the uncertainty without exposing the raw text.
```

## Review Checklist

Before committing a transcript-derived artifact:

- raw transcript is not present in the repo or app bundle
- artifact has `private-vault:<vault_id>` provenance
- artifact says whether it is paraphrased, reconstructed, or inferred
- no cleaned-up paraphrase is placed in quotation marks
- no private customer/company/fundraising/pricing/GTM material survived
- no personal boundaries or private participant details survived
- speaker attribution is conservative
- external facts are verified separately or marked unverified
- consent tier is present
- public article/recap has a provenance footer
- generated data was rebuilt only from distilled artifacts

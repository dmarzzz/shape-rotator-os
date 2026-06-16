# Shape Rotator OS Information Rules

Status: draft operating policy
Last reviewed: 2026-06-14
Applies to: this repository, the Shape Rotator Google Drive vault, generated app bundles, and operator working files

Related: [docs hub](README.md), [visual rules page](INFORMATION_RULES.html), [calendar coverage index](transcript-calendar-coverage-index.md)

## Core Rule

Store information by authority, not convenience.

The question is not "where did this file arrive?" The question is "what is the most authoritative safe version of this information, and who is allowed to see it?"

Use this order:

1. Raw private source stays in the Drive vault or `cohort-data/.private/`.
2. Transcript distillation state lives in Supabase, not in Drive.
3. Canonical cohort facts live in `cohort-data/`.
4. Durable operating docs live in `docs/`.
5. Product code lives in `apps/`, `packages/`, and `scripts/`.
6. Generated outputs live under an explicit `generated/`, build output, app bundle, or `tmp/`.
7. One-off scratch files do not become policy, source data, or product state until promoted deliberately.

## Authority Levels

| level | meaning | canonical home | may be committed |
|---|---|---|---|
| Raw private source | Original transcript, recording, private note, unredacted upload, privileged export | Google Drive vault, `cohort-data/.private/` | No |
| Source anchor | Metadata proving a source exists without exposing content | `cohort-data/events/`, Supabase source metadata, reviewed manifests | Yes, if content-safe |
| Canonical cohort record | Stable object the OS renders or routes on | `cohort-data/<record-type>/` | Yes |
| Derived reviewed artifact | Human-reviewed synthesis from private or noisy source | Supabase `derived_artifacts`, reviewed app views/bundles, or `cohort-data/artifacts/<artifact-kind>/reviewed/` when deliberately exported | Yes, if policy allows |
| Durable operating doc | Rule, playbook, audit, launch checklist, architecture note | `docs/` | Yes |
| Generated artifact | Mechanical output that can be rebuilt | `generated/`, app bundles, `tmp/`, build directories | Sometimes, only when the repo already tracks it |
| Scratch/import residue | Local test output, worktree copy, downloaded pile, screenshot during debugging | `tmp/` or ignored local path | No by default |

## Folder Map

| path | purpose | rule |
|---|---|---|
| `cohort-data/` | Canonical cohort knowledge and app-rendered markdown/data | Treat as the source of truth for people, teams, events, program material, clusters, dependencies, asks, articles, and reviewed artifacts. |
| `cohort-data/.private/` | Local private operator material | Never commit. Use for vault plans, private exports, generated SQL with secrets, and local-only review manifests. |
| `cohort-data/people/` | Person records | One person per lowercase kebab-case slug. Filename should match `record_id`. |
| `cohort-data/teams/` | Team/project records | One team/project per lowercase kebab-case slug. Filename should match `record_id`. |
| `cohort-data/events/` | Calendar/event anchors | Use `YYYY-MM-DD-short-event-name.md` for single-day events. Use start date for multi-day events. |
| `cohort-data/session-readouts/` | Reviewed session-level readouts | Use `topic-or-session-name-YYYY-MM-DD.md` unless a local script requires another pattern. No raw transcript text. |
| `cohort-data/articles/` | Canonical article source records | Use article slug. Public web copies can be generated elsewhere. |
| `cohort-data/artifacts/` | Reviewed export copies of derivative artifacts | Use subfolders by artifact family. Generated outputs go in `generated/`; reviewed copies go in `reviewed/` when deliberately promoted from Supabase/app review. |
| `cohort-data/policies/` | Machine-readable policy | JSON/YAML policies that scripts enforce. Human explanation belongs in `docs/` and links back here. |
| `docs/` | Durable human-readable operating docs | Playbooks, audits, launch checklists, architecture notes, and this rules document. |
| `apps/` | Application code and app-local generated bundles | Do not store canonical cohort facts here unless they are generated from `cohort-data/`. |
| `packages/` | Shared package code | No drive documents or cohort records. |
| `scripts/` | Automation, build, import, audit, and migration scripts | Scripts may read/write private plans, but private output belongs under `cohort-data/.private/` or `tmp/`. |
| `supabase/` | Database and Edge Function source | No raw transcripts or private exports. |
| `tmp/` | Disposable local work | Anything here may be deleted. Do not link durable docs to `tmp/`. |
| repository root | Project metadata and entry points | Keep clean: `README.md`, package files, license, config, top-level env examples. New durable docs should go in `docs/`. |

## Drive / Supabase Boundary

The transcript Drive is the raw/source vault. It stores recordings, raw transcripts, source file names, and operator-only routing evidence. It is not the canonical distillation layer.

Supabase is the canonical distillation system of record. `source_artifacts`, `processing_jobs`, `derived_artifacts`, `artifact_reviews`, approval gates, and app-safe views/bundles belong there. The Drive folder `operator_review_exports` is only an optional operator export/review mirror; it must not become the authoritative place where distillations are judged complete.

Drive folder names should be plain semantic names, not numbered lifecycle labels. Ordering belongs in this rules document and in the routing policy, not in the folder name itself.

For transcripts, check the calendar before routing. The calendar match confirms or challenges the event date, session type, project/topic basis, and audience boundary. A file that cannot be matched confidently goes to `needs_calendar_match` until a human resolves it.

Every transcript source record and generated evidence/distillation card must carry explicit confidence percentages where applicable:

- `type_confidence_pct`: confidence that the transcript/session type is correct.
- `group_confidence_pct`: confidence that the Drive route, Supabase grouping, or review bucket is correct.
- `understanding_confidence_pct`: confidence that the system's date/topic/session understanding is correct enough for the next processing step.
- `confidence_pct` on evidence/distillation cards: confidence that the card's extracted claim or readout is supported by its reviewed/distilled source.

Keep old confidence labels only for compatibility. The percentage is the reviewable value. Anything below 70% is a review queue signal, not an automatic promotion signal.

Bot rule: whenever a bot reviews transcript labeling, grouping, date/order, or manual-review queues, it should run the transcript label audit against the current private plan:

```bash
node scripts/audit-transcript-labels.mjs --env-file .env.calendar.local --fetch
```

If credentials are unavailable, run it without `--fetch` and report any `content_not_available` or `fetch_failed` gaps. The audit output belongs under `cohort-data/.private/transcript-vault/` and must not include raw transcript text in committed docs.

Bot rule: whenever a bot checks, classifies, reviews, processes, or changes transcript source inventory, keep the review output in the private audit/plan files under `cohort-data/.private/transcript-vault/`. If the underlying private import plan changed, regenerate it with `node scripts/prepare-transcript-vault-import.mjs --files cohort-data/.private/transcript-vault/vault-files.json`.

## Drive Vault Routes

The transcript vault uses semantic folder names. These folders organize source/admin material in Drive; Supabase owns distillation state and review status.

| route | purpose |
|---|---|
| `inbox` | New arrivals before classification. |
| `raw_transcripts` | Raw room-level transcripts after type classification. |
| `calendar_matched` | Sources matched to calendar/session anchors. |
| `needs_calendar_match` | Sources that need manual date/session/type review. |
| `operator_review_exports` | Optional exported review copies; Supabase remains canonical. |
| `do_not_publish` | Private, sensitive, or core-only material that should not produce cohort/public artifacts. |

Transcript source types route as follows:

| type | event basis | raw route | review/export mirror | default boundary |
|---|---|---|---|---|
| `weekly_standup` | individual based | `raw_transcripts/weekly_standup` | `operator_review_exports/weekly_standup` | T0/T1 by default; only aggregate signal can reach cohort; never public. |
| `office_hours` | project core team or product based | `raw_transcripts/office_hours` | `operator_review_exports/office_hours` | Project/core by default; reviewed cohort readout allowed; not public by default. |
| `salon` | topic based | `raw_transcripts/salon` | `operator_review_exports/salon` | Cohort readout allowed; public candidate only after editorial, speaker, and named-person passes. |
| `rd_jam` | product or technical idea based | `raw_transcripts/rd_jam` | `operator_review_exports/rd_jam` | Cohort only after team call and hard distillation; never public by default. |
| `demo_presentation` | project or product based | `raw_transcripts/demo_presentation` | `operator_review_exports/demo_presentation` | Presenter owns material; public needs presenter approval plus editorial and named-person passes. |
| `private_1on1` | private/coaching based | `do_not_publish/private_1on1` | `do_not_publish/private_1on1` | Core/private only. No cohort or public artifact. |
| `user_interview` | external-subject based | `raw_transcripts/user_interview` | `operator_review_exports/user_interview` | Raw stays core; aggregate insights may travel; interview itself never widens. |
| `planning_strategy` | coordinator/governance based | `do_not_publish/planning_strategy` | `do_not_publish/planning_strategy` | Coordinator/core only; not cohort, not public. |
| `unknown` | unconfirmed | `needs_calendar_match` | `needs_calendar_match` | Hold until calendar/type/audience are reviewed. |

Manual classification checks:

| if the calendar/transcript shows | classify as | not as |
|---|---|---|
| recurring WDYDLW, status update, individual progress, or coordinator check-in by person | `weekly_standup` | `office_hours` |
| project support, product feedback, roadmap critique, milestone review, or core-team implementation help | `office_hours` | `rd_jam` |
| open-ended whiteboarding, architecture exploration, product/technical hypothesis testing, or idea-stage workshop | `rd_jam` | `office_hours` |
| topic-led discussion, speaker-led room, or salon-style session not centered on one team's operating work | `salon` | `office_hours` |
| prepared project/product demo, presentation, intro, showcase, or presenter-owned material | `demo_presentation` | `salon` |
| external customer/user/ICP subject whose participation is research evidence | `user_interview` | `office_hours` |
| governance, fundraising, internal planning, access policy, or coordinator strategy | `planning_strategy` | `office_hours` |

If a transcript fits two rows, use the calendar event as the first anchor. If the calendar is ambiguous, prefer the more restrictive type and route to `needs_calendar_match` for review.

Machine-readable source of truth: [`cohort-data/policies/transcript-routing-policy.json`](../cohort-data/policies/transcript-routing-policy.json). Human process reference: [`docs/transcript-distillation-playbook.md`](transcript-distillation-playbook.md).

## Transcript Coverage Index

Current calendar/transcript coverage lives in [`docs/transcript-calendar-coverage-index.md`](transcript-calendar-coverage-index.md). It expands every block in `cohort-data/calendar.json`, marks whether transcript coverage is covered, readout-only, candidate-needs-review, missing, not expected, or future, and includes the current title audit.

Regenerate it with:

```bash
node scripts/audit-transcript-calendar-coverage.mjs
```

This metadata coverage index, plus `node scripts/audit-transcript-labels.mjs`, is the supported transcript catalog/audit workflow. Do not recreate the old transcript HTML index for source inventory review; update these metadata outputs instead when transcript source inventory changes.

The public doc lists calendar blocks and safe metadata only. The full transcript naming/original-title queue is written to `cohort-data/.private/transcript-vault/transcript-calendar-coverage-audit.md` and `cohort-data/.private/transcript-vault/transcript-calendar-coverage-audit.json`; those private files can include sensitive source titles and must not be committed.

## Naming Rules

Use names that remain useful after search results lose folder context.

General rules:

- Use ASCII filenames.
- Use lowercase kebab-case for repo-native markdown/data files.
- Use ISO dates: `YYYY-MM-DD`.
- Use stable nouns, not temporary states: `calendar-ingress-quality-audit.md`, not `notes-final-v3.md`.
- Avoid spaces in repo-native filenames. Preserve upstream filenames only inside raw imports or private vault inventory.
- Avoid `final`, `latest`, `copy`, `new`, `old`, `v2`, and initials-only names unless the version is a real release identifier.
- A filename should not contain sensitive names or private subject matter if the file will be public or cohort-visible.

Canonical markdown record names:

| record type | pattern | example |
|---|---|---|
| Person | `<person-record-id>.md` | `andrew-miller.md` |
| Team/project | `<team-record-id>.md` | `shape-rotator-os.md` |
| Event | `YYYY-MM-DD-<event-slug>.md` | `2026-06-14-shape-rotator-demo-night.md` |
| Session readout | `<session-topic>-YYYY-MM-DD.md` | `shape-rotator-project-map-guests-2026-05-22.md` |
| Dependency | `<source-record-id>-<target-record-id>.md` | `tinycloud-teesql.md` |
| Cluster | `<cluster-slug>.md` | `confidential-ai-ops.md` |
| Program page | `<tab-slug>.md` | `overview.md` |
| Policy | `<policy-key>.json` | `transcript-routing-policy.json` |
| Durable doc | `<topic>-<doc-kind>.md` when helpful | `calendar-ingress-launch-checklist.md` |

Transcript vault file names:

```text
type_project-name_YYYY-MM-DD.ext
```

This is the preferred naming convention for all transcript source files and the
operational form of `type_project_name_date`. Check the matching calendar event
first, then set:

- `type`: one of the allowed transcript type prefixes.
- `project-name`: project, product, person, topic, or technical idea slug, using hyphens inside the component.
- `YYYY-MM-DD`: the confirmed calendar/session date.
- `ext`: the source extension unless conversion is deliberate.

Allowed type prefixes:

- `weekly_standup`
- `office_hours`
- `private_1on1`
- `salon`
- `rd_jam`
- `demo_presentation`
- `user_interview`
- `planning_strategy`

Examples:

- `weekly_standup_shaw_2026-06-08.txt`
- `office_hours_conclave_2026-06-10.md`
- `private_1on1_career-coaching_2026-01-15.txt`
- `salon_info-markets-design_2026-06-09.txt`
- `demo_presentation_elocute_2026-05-26.txt`

Bad/good pairs:

| bad | good |
|---|---|
| `Conclave office hours final.txt` | `office_hours_conclave_2026-06-10.txt` |
| `Copy of Product Whiteboarding Jam Jun 9.txt` | `rd_jam_product-whiteboarding_2026-06-09.txt` |
| `WDYDLW Shaw notes latest.md` | `weekly_standup_shaw_2026-06-08.md` |
| `Project intros & workflow.txt` | `demo_presentation_project-intros-workflow_2026-05-19.txt` |

Images and screenshots:

- Durable images belong beside the doc or article that uses them, or under a topic-specific docs asset folder.
- Debug screenshots belong in `tmp/`.
- Do not add new root-level screenshots.
- Generated public article media should live under the article's own folder if the web app expects that structure.

## Sorting Rules

Default sort order:

1. By object type first: people, teams, events, artifacts, policies, scripts.
2. By lifecycle second: inbox, raw, matched, derived, reviewed, published, held.
3. By date third when chronology is the primary retrieval path.
4. Alphabetically by stable slug otherwise.

Specific rules:

- `people/`, `teams/`, `clusters/`, and `dependencies/` sort alphabetically by slug.
- `events/` sorts chronologically because date is the first token.
- `session-readouts/` may sort by topic or date; include the date either way.
- Drive vault folders do not use numeric prefixes. Use semantic names and rely on this rules document/policy for lifecycle order.
- Do not add numeric prefixes to ordinary repo folders.
- Generated artifacts should be sorted by generation manifest, not manually rearranged.

## Frontmatter Rules

For app-rendered cohort records, frontmatter should carry stable identity and type.

Required or strongly preferred fields:

- `record_id`: stable slug, matching filename where possible.
- `record_type`: one of the schema-backed types.
- Dates in `YYYY-MM-DD`.
- Links grouped under `links`.
- Source/provenance fields when the claim came from a private, generated, or external source.
- Confidence and review status for derived material.

Do not put steward-only notes into public surface fields. The public/surface boundary is controlled by [`cohort-data/schema.yml`](../cohort-data/schema.yml). If a field might expose private coaching, unreleased GTM, private customer details, or interpersonal dynamics, it belongs in depth/private material, not a public surface field.

## Privacy And Publication Tiers

Use these tiers for transcript-derived and private-source material:

| tier | label | audience | raw content allowed |
|---|---|---|---|
| T0 | room | People who were there | Yes, in vault only |
| T1 | core | Core team/coordinators/project owners | Only by request and approval |
| T2 | cohort | Gated cohort surfaces | No |
| T3 | public | Public site/search/social | No |

Rules:

- Raw transcripts never go in the public repo or app bundle.
- Public artifacts must be generalized or explicitly cleared.
- Cohort-visible distillations must carry provenance, confidence, consent tier, and review status.
- No cleaned-up paraphrase should be styled as a verbatim quote unless explicitly cleared as a quote.
- If attribution is reconstructed, say so.
- If the source contains private customer, investor, pricing, fundraising, GTM, interpersonal, credential, or personal-boundary material, strip or generalize it before it leaves the vault.

## Promotion Lifecycle

Use this workflow when turning incoming information into durable OS knowledge:

1. Inbox
   - Put unclassified arrivals in `inbox`, `tmp/`, or `cohort-data/.private/`.
   - Do not commit raw private material.

2. Classify
   - Match the calendar event first.
   - Identify object type, source, date, audience, and sensitivity.
   - Store type, group, and understanding confidence percentages.
   - For transcript label/order review, run `node scripts/audit-transcript-labels.mjs --env-file .env.calendar.local --fetch` against the current private plan.
   - Decide whether it is raw source, canonical record, durable doc, generated artifact, or scratch.

3. Anchor
   - Create or update safe metadata in `cohort-data/events/`, Supabase source metadata, or a manifest.
   - Keep content out if the content is not cleared.

4. Distill
   - Turn raw/noisy/private source into product-useful claims, not dialogue.
   - Store the canonical distillation state in Supabase.
   - Ship the gated cohort readout quickly, ideally within roughly 48 hours; public publication is a separate later consent/review step.
   - Preserve provenance and confidence.

5. Review
   - Mark generated outputs as generated.
   - Treat confidence below 70% as review-held unless a human explicitly overrides it.
   - Promote only reviewed material into cohort or public surfaces.

6. Publish
   - Update the canonical markdown/data record.
   - Refresh the private audit/plan outputs under `cohort-data/.private/transcript-vault/` after transcript source inventory changes.
   - Rebuild generated app bundles from canonical sources.

7. Archive or hold
   - Move private or blocked material to the correct private/held location.
   - Do not leave sensitive material in inboxes, root folders, or ad hoc working directories.

## Dedupe Rules

Before creating a new file:

1. Search for the person/team/event/session slug.
2. Search by date if the object is time-based.
3. Search by source ID or Drive file ID if it came from Drive.
4. Check whether a generated artifact already has a reviewed version.
5. If this is a decision/history note, search Router before inventing a new policy.

If a duplicate exists:

- Update the canonical file instead of creating a sibling.
- If the duplicate is raw source, keep only the private vault copy and use a source anchor.
- If both files contain useful reviewed synthesis, merge into the canonical record and leave a short note in the superseded review artifact only if needed.

## Placement Decision Tree

Ask these questions in order:

1. Does it contain raw private content?
   - Yes: Drive vault or `cohort-data/.private/`.
   - No: continue.

2. Is it a stable fact about a cohort object?
   - Yes: `cohort-data/<record-type>/`.
   - No: continue.

3. Is it a rule, plan, audit, architecture note, or process guide?
   - Yes: `docs/`.
   - No: continue.

4. Is it code or automation?
   - App code: `apps/`.
   - Shared package: `packages/`.
   - Automation/script: `scripts/`.
   - Database/function: `supabase/`.

5. Is it rebuildable output or local scratch?
   - Yes: `generated/`, app bundle output, ignored build output, or `tmp/`.

6. Is it a durable public article or recap?
   - Canonical source: `cohort-data/articles/`.
   - Rendered web copy: the web app's expected article folder.

## What Not To Do

- Do not use the repository root as a dumping ground.
- Do not store raw transcripts in `cohort-data/session-readouts/`, `docs/`, `apps/`, or public web folders.
- Do not hand-edit generated files unless the file explicitly says it is hand-maintained.
- Do not create parallel person/team files because the name changed; update the canonical slug only with a deliberate migration.
- Do not encode access control only in prose. If scripts need the rule, put it in `cohort-data/policies/` or schema.
- Do not create docs that contradict machine-readable policy without updating the policy.
- Do not publish "transcript says" claims when the artifact is actually a paraphrased reconstruction.

## Review Checklist

Before committing or promoting information:

- The file is in the right authority layer.
- The filename follows the correct pattern.
- Dates are `YYYY-MM-DD`.
- Transcript date/type/project were checked against the calendar before routing.
- Transcript label/order review ran `scripts/audit-transcript-labels.mjs` or the remaining content gaps are explicitly reported.
- Transcript/source records include type, group, and understanding confidence percentages.
- The canonical slug matches `record_id` where possible.
- Public/cohort-visible material contains no raw private transcript text.
- Derived material has provenance, confidence, consent/review status, and audience boundary.
- The private audit/plan outputs under `cohort-data/.private/transcript-vault/` were refreshed after any transcript source, route, or review queue change.
- Generated material is either ignored, clearly generated, or intentionally tracked.
- Links point to canonical records, not `tmp/` or local private files.
- The change does not duplicate an existing person, team, event, session, article, or policy.
- Any script-enforced rule is represented in schema or policy, not only in this doc.

## Known Cleanup Debt

The current drive/repo contains legacy root screenshots, temp worktrees, and older one-off planning files. Treat them as cleanup candidates, not precedents. New durable information should follow this rules document from 2026-06-14 onward.

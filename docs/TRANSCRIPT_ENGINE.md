# The Transcript Engine

> The one page that explains how a meeting becomes an insight. If you only read one
> doc about transcripts, read this. Everything else (`transcript-distillation-playbook.md`,
> `calendar-transcript-system-map.html`, `INFORMATION_RULES.md`, `PRIVACY_TIERS.html`) is a
> deeper dive on one stage named here.

---

## TL;DR

A cohort session (office hours, salon, standup) produces a raw transcript. The transcript
engine turns that — plus public GitHub activity and declared team profiles — into small,
attributable **insight cards** that the OS app renders, while a privacy gate decides who may
see each card. Three stages, in order:

```
   RECEIVE                INTERPRET                 PRESENT
   ───────                ─────────                 ───────
 raw transcript   →   distilled + scored    →    cards on a surface
 (Drive/Meet)         (cards + evidence)         (app tabs, map, dossier)
        ▲                    ▲                          ▲
   private vault      two engines (!)            5+ scattered surfaces
   9-step relay       no shared contract         no unified "sessions" view
```

The parenthetical warnings are the work. This doc states the system as it **is** (honest),
then the system as it **should be** (the modular target).

---

## The honest reality: four subsystems, one name

"The transcript engine" is not one module. It is four loosely-coupled subsystems that share a
noun. Naming them is the first step to making it explainable.

| # | Subsystem | Lives in | Transcript content inside? |
|---|-----------|----------|----------------------------|
| 1 | **Ingest relay** | `scripts/*transcript*` (~20 `transcripts:*` npm scripts), `cohort-data/.private/transcript-vault/` | Yes — raw, vault-only |
| 2 | **Deterministic cohort-insight engine** | `scripts/lib/cohort-insight-engine.cjs` | **No** — GitHub + declared profile only |
| 3 | **Runtime transcript-evidence overlay** | `apps/os/src/renderer/cohort-evidence-index.mjs` + `supabase-evidence.mjs` + `supabase-distillations.mjs` | Yes — distilled, gated |
| 4 | **Presentation surfaces** | `apps/os/src/renderer/alchemy.js` (+ `cohort-source.js`, `cohort-relations.js`) | Rendered, mixed tiers |

**The fracture that causes "scattered":** subsystem 2 (committed, deterministic, runs at build
time) and subsystem 3 (live, gated, runs in the app) **both emit "cards"** and both feed the
same surfaces — but they are written separately, shaped slightly differently, and gated
differently. There is no single card contract and no shared glossary. A reader who learns one
does not understand the other.

---

## Stage 1 — RECEIVE (ingest)

Turns a file in Google Drive into a privacy-classified, session-linked, distilled artifact in
Supabase. It is a **plan→apply relay**: every step writes a JSON manifest into the private
vault; the next step reads it. No single command runs the chain end to end.

```
Drive ─▶ vault:prepare ─▶ drive:fetch ─▶ sessions:map ─▶ supabase:plan ─▶ (apply) ─▶ worker distill ─▶ review gate
        import-plan.json   fetch+hash    calendar link   apply-rows        source_artifacts   derived_artifacts   published/blocked
```

| npm script | Does | Key output |
|------------|------|-----------|
| `transcripts:vault:prepare` | Inventory Drive, classify type/date/tier, score calendar match | `transcript-vault-import-plan.json` |
| `transcripts:drive:fetch` | Download + sha256 raw text into the vault | `transcript-drive-fetch-manifest.json` |
| `transcripts:sessions:map` | Token-overlap match transcript → calendar session | `transcript-session-map.json` (safe vs review queues) |
| `transcripts:supabase:plan` | Build `source_artifacts` / `ingestion_events` / `processing_jobs` rows | `transcript-supabase-plan.json` |
| (worker, cron) | Distill raw → `{summary, action_items, open_questions}` | `derived_artifacts` rows |
| `transcripts:distillations:review` | Approve/block with leak detection, set review/approval state | review + audit rows |
| `transcripts:public-articles` | T3-published distillations → name-sanitized articles | `public-transcript-articles/` |

**The distiller is rule-based, not an LLM.** The contract is `prompt_version: "local-distill-v1"`,
`model_name: "deterministic-distiller"` — sentence extraction with PII masking, not model
reasoning. This is the single biggest lever on *interpretation quality* (see the audit).

**Session matching is heuristic.** Same-day + ≥2 shared title tokens (after a 23-word stopword
list) ⇒ "safe"; otherwise it lands in a manual-review queue with no automated resolution path.

---

## Stage 2 — INTERPRET (the two engines)

### 2a. Deterministic cohort-insight engine — `scripts/lib/cohort-insight-engine.cjs`

Pure, reproducible, committed to git. Reads **public** inputs only and emits a bundle of cards.
Runs via `npm run build:cohort-insights` → `cohort-data/artifacts/cohort-insights/generated/manifest.json`.

**Inputs** (`loadCohortInsightInputs`): `teams/*.md`, `clusters/*.md`, `dependencies/*.md`,
`artifacts/github-progress/**`, `artifacts/github-releases/**`, `awards.yml`. **No transcripts.**

**The card contract** (`makeInsightCard`, the thing every card must satisfy):

```js
{
  schema_version, id, kind, subject_type, subject_ids[],
  title, claim_text, summary,
  evidence_level,        // observed_public_metadata | inferred_public_metadata | declared_only
  confidence,            // high | medium | low-medium | low
  surface_tier,          // cohort (T2) | public (T3)
  source_boundary,       // public_bundle  (never raw transcript)
  review_status,         // generated | reviewed | published
  approval_state,        // not_reviewed | pending | approved
  raw_allowed: false,
  source_refs[], content_json{}, generated_by
}
```

**The kinds it can emit:**

| kind | One per | Trigger | Evidence level |
|------|---------|---------|----------------|
| `say_did_shipped` | team | always | observed (GitHub) or declared |
| `latent_overlap` | team-pair | score ≥ 35, not same-cluster, not declared dep | inferred |
| `collaboration_edge` | team-pair | cross-team commit authorship (GitHub) | observed |
| `award` (nomination + editorial slot) | category | always (scaffold only; winners are gated) | observed / pending |
| `rotation` | — | **never here** (gated stub; requires reviewed model judgment) | — |

### 2b. Runtime transcript-evidence overlay — `apps/os/src/renderer/cohort-evidence-index.mjs`

This is where *actual transcript content* becomes insight, at runtime, in the app. It reads
gated Supabase views and indexes them:

- `fetchPublicEvidenceCards()` → `public_transcript_evidence_cards` (T3, anonymized) — **live today**
- `fetchCohortEvidenceCards()` → `cohort_app_transcript_evidence_cards` (T2, named) — **dormant** (`COHORT_APP_READER_ENABLED = false` until the migration ships)
- `fetchCohortDistillations()` → `cohort_app_transcript_distillations` (T2, paraphrased) — **dormant**

`indexCohortEvidence()` buckets cards by team / week / claim-lane (`DID`, `PMF`, `ASK`, `RISK`,
`EDGE`). `teamTimeline()`, `recentClaims()`, `evidenceDependencyRecords()` derive views from that
index. This index is the real "what did the cohort say in sessions" brain — and it is a
*different* contract from 2a's cards.

> **In-flight (uncommitted on `refactor/privacy-tier-consolidation`):**
> `insightCollaborationDependencyRecords()` bridges 2a's `collaboration_edge` cards into the
> same dependency-record shape the map renders, so committed GitHub edges and live transcript
> edges share one render path. This is the first thread stitching 2a and 2b together — the
> direction this doc argues for.

---

## Stage 3 — PRESENT (surfaces)

Transcript-derived information currently appears in **five+ disconnected places**, with no
single "sessions" view:

| Surface | Render fn (`alchemy.js`) | Data | Tier |
|---------|--------------------------|------|------|
| Evidence tab (cards) | `renderContextEvidence` / `contextEvidenceCardHtml` | evidence overlay | T3 live / T2 dormant |
| Evidence tab (distilled) | `contextSessionSummaryHtml` | distillation overlay | T2 dormant |
| Say/Did/Shipped "did" cell | `sdsEvidenceDidHtml` | `recentClaims(...,'did')` | T3 |
| Team dossier timeline | `renderWorkstreamTimeline` | `teamTimeline()` | T3 |
| Ecosystem / relationship map edges | `constellationDependencyEdges` (+ `cohort-relations.js`) | evidence + insight deps | T0/T3 |
| Calendar session matches | `CALENDAR_TRANSCRIPT_MATCHES` (hardcoded) | static JS | private ref |

**The scatter:** a "did" claim in say/did/shipped cannot link to the full distilled session;
the calendar (hardcoded matches) and the evidence cards (live) don't know about each other; the
same session's signals are split across tabs by lane, never shown together.

---

## Vocabulary (the one glossary)

| Axis | Values | Meaning | Source of truth |
|------|--------|---------|-----------------|
| **Access tier** | `T0 room` · `T1 core` · `T2 cohort` · `T3 public` | Who may see it | `scripts/lib/tiers.cjs` ← `transcript-routing-policy.json` |
| **max_surface** | `cohort` · `public_candidate` · `public` | How far it may travel | `tiers.cjs` (`SURFACE`) |
| **evidence_level** | `observed_public_metadata` · `inferred_public_metadata` · `declared_only` | How we know | engine card |
| **confidence** | `high` · `medium` · `low-medium` · `low` | How sure | engine card |
| **review_status** | `generated` · `reviewed` · `published` | Lifecycle | engine card |
| **approval_state** | `not_reviewed` · `pending` · `approved` | Gate state | engine card |
| **kind** | `say_did_shipped` · `latent_overlap` · `collaboration_edge` · `award` · `rotation` | What the card asserts | engine |
| **dep status** | `declared` · `session_observed` · `github_observed` | Edge provenance | `cohort-relations.js` |

Rule of thumb: a card reaches **public web** only if `surface_tier=public` **and**
`review_status=published` **and** `approval_state=approved`. Everything the deterministic engine
emits today is `cohort` + `generated`, so it is cohort-app-only by construction.

---

## Are we drawing the right insights? (honest audit)

Ordered by leverage. Each is a real "interpretation" weakness, not a style nit.

**P1 — The distiller is sentence-extraction, not understanding.** `deterministic-distiller` /
`local-distill-v1` produces `{summary, action_items, open_questions}` by rule, so the richest raw
input (the actual conversation) is interpreted shallowly. The whole evidence layer inherits that
ceiling. *Fix:* define a model-backed distillation contract (Claude) with provenance + review,
versioned as `distill-v2`, gated exactly like today. This is the highest-value change to
"how we interpret information."

**P2 — `latent_overlap` scoring is hand-tuned and frequency-blind.** Weights are magic numbers
(`skills×22 + domain×18 + deps×16 + tokens×3`, cap 100), and a **hardcoded 23-word stopword
list** is the only defense against cohort-ubiquitous terms. "agent", "tee", "data" appear
everywhere, so they either pollute overlap or must be hand-stopworded forever. *Fix:* weight
tokens by **inverse document frequency** across the cohort — common terms auto-decay, rare shared
terms (the real signal) rise — and delete the stopword list. Isolated, unit-testable, no effect
on other kinds.

**P3 — `collaboration_edge` confidence is binary-pessimistic.** `some(c => c==='medium') ? 'medium' : 'low'`
ignores volume: 40 commits across 3 people scores the same as 1 commit. *Fix:* fold commit count
and contributor count into the confidence ladder.

**P4 — `matched_cohort_people` is computed then dropped.** The GitHub audit attaches it to every
artifact; the engine never reads it. Latent signal lost. *Fix:* surface it (self-contribution /
attribution) or document why it's intentionally unused.

**P5 — Two card systems, one job.** 2a and 2b should share one card contract and one index so a
session, a GitHub edge, and a declared dependency are the same shape with different
`evidence_level`/`status`. The uncommitted `insightCollaborationDependencyRecords` is the first
step; finish the convergence.

---

## The modular target ("comprehensive, simple, modular")

What "great engineering overall" looks like here:

1. **One ingest command.** `transcripts:run` orchestrates prepare→fetch→map→plan→apply with a
   single state file and resumability, instead of nine hand-sequenced manifests.

2. **One engine, split by kind.** Decompose the 946-line `cohort-insight-engine.cjs` into a small
   package against the shared card contract:
   ```
   scripts/lib/cohort-insight/
     contract.cjs        # makeInsightCard + vocabulary (the one contract)
     inputs.cjs          # loaders
     text.cjs            # grammar helpers
     kinds/say-did-shipped.cjs · latent-overlap.cjs · collaboration-edge.cjs · award.cjs
     index.cjs           # buildCohortInsightBundle orchestrator
   ```
   A new contributor reads `kinds/latent-overlap.cjs` and understands exactly what insight it
   draws and why — in one file.

3. **One evidence contract.** 2a cards and 2b transcript evidence reduce to the same record so the
   map / dossier / say-did-shipped read one shape, distinguished only by `evidence_level` + `status`.

4. **One "Sessions" surface.** A single view keyed by session date that shows: who was there →
   the distilled readout → the cards/edges/claims it produced → links into team dossiers. Replaces
   the five scattered taps with one coherent story per session.

5. **One spine doc.** This file. Keep it current; let the deep-dives stay deep.

---

---

## The trace contract (delivered)

Every engine card now carries a uniform, recomputable reasoning record in
`content_json.trace` so a claim explains itself and can be re-derived from source:

```jsonc
"trace": {
  "method": "latent_overlap_idf", "version": 3,
  "basis": "inferred",                 // observed | declared | inferred | observed_with_inferred_identity
  "confidence": "low-medium",
  "confidence_basis": "structural similarity 62/100 — never declared, not human-confirmed",
  "signals": [                          // each weighted reasoning step, citing its own source_refs
    { "name": "shared_skill_areas", "value": ["attestation","tee"], "contribution": 44, "of": 100,
      "source_refs": [{ "kind": "team_record", "record_id": "alpha", "path": "cohort-data/teams/alpha.md" }] }
  ],
  "inputs": [ /* == source_refs */ ],
  "recompute": "buildLatentOverlapCards over committed cohort-data teams/clusters/dependencies"
}
```

`basis` (how we know) is deliberately distinct from `review_status` (whether a human
confirmed it) — an inference is never dressed as an observed fact. The trace rides in
`content_json`, which `app_cohort_insight_cards` exposes to members and the anon public view
strips — so richer provenance never over-exposes. **Zero new DB columns.**

Honesty rules now enforced (the "don't over-extend the truth" requirement):
- declared capabilities read "aims to provide / plans to build", never present-tense fact;
- a team's own `stage`/`confidence`/`evidence_notes` travel as a `stage_qualifier`;
- observed *activity* ≠ observed *capability* — `what_it_does` is always declared-basis;
- founder pedigree routes to `team_background`, never the "did" slot;
- `latent_overlap` scores are self-explaining (`score_breakdown` sums to the score; each term
  carries its cohort `doc_freq` + `idf_weight`); cohort-ubiquitous filler is dropped from display;
- collaboration confidence is signal-weighted; only a github-noreply email match *names* a person.

Presentation: `apps/os/src/renderer/cohort-trace-view.mjs` (one reusable renderer, +
`cohort-trace-view.css`) shows the trace as a compact basis+confidence chip that expands to the
full reasoning; wired into the team inspector's "how this reads" section.

Status of the earlier audit: **P2 (IDF), P3 (signal-weighted collab confidence), P4
(matched_cohort_people recovered), P5 (collaboration edges bridged to the map)** are delivered;
the whole was adversarially verified (5 lenses, 11 findings, all fixed). **P1 (model-backed
distiller)** remains the open lever — the transcript distiller is still rule-based.

---

### Deeper dives
- Ingest + privacy mechanics: `docs/INFORMATION_RULES.md`, `docs/PRIVACY_TIERS.html`
- Distillation flow: `docs/transcript-distillation-playbook.md`
- Calendar ↔ transcript linking: `docs/calendar-transcript-system-map.html`, `docs/reviewed-transcript-map.md`, `docs/transcript-calendar-coverage-index.md`
- Tier source of truth: `scripts/lib/tiers.cjs`

# Cohort legibility — integration map + runbook

How the new read-side legibility work fits together, what to apply/operate, and
what's still to wire. Covers PRs: connection engine + chat (#497), card
attribution (#498), feed diversity (#499), Timeline view (#500).

Last reviewed: 2026-06-25.

## The shared model — what feeds what

Everything hangs off the live cohort surface (`cohort-source.js` overlays) and a
small set of canonical structures. The goal: one substrate, surfaced many ways.

```
                          cohort-data/*.md (teams: seeking/offering/skills/journey)
                                   │
              ┌────────────────────┼─────────────────────────────┐
              ▼                    ▼                              ▼
   build-cohort-connections   build-bundles → cohort-surface   live Supabase overlays
   (LOCAL AI, daily)          (whats_new, team_timeline, …)    (evidence cards, releases,
              │                    │                            spheres, connections)
              ▼                    ▼                              │
   public_cohort_connections   committed offline baseline        │
   (Supabase, anon-read)            │                            │
              └──────────┬──────────┴───────────────┬────────────┘
                         ▼                           ▼
                applyConnectionsOverlay      applyEvidenceOverlay
                (record.connections)         (+ attributeInsightCards → card.content_json.teams)
                         │                           │
        ┌────────────────┼───────────────┐          ├──────────────┬───────────────┐
        ▼                ▼               ▼           ▼              ▼               ▼
  per-team "who to    cohort chat    (future)    per-team     Timeline view    say/did/shipped,
  talk to" inspector  grounding      asks wall   dossier      insights lane     PMF, dossier
```

Key idea: **the app never calls an LLM at runtime.** The local-AI work
(connections, chat) is either a daily routine that publishes precomputed rows, or
the member's own CLI. The renderer only ever reads.

## The two canonical timelines (don't duplicate them)

There are two complementary timeline concepts; new work should plug into these,
not add a third:

1. **Canonical snapshot/rewind** — `cohort-timeline.json` → `cohort-timeline.js`,
   driving the "As of [Total ▾]" selector on every cohort view. Git-history
   snapshots of the whole surface; it answers "what did the cohort look like at
   week N." The Timeline view (#500) reads `activeConstellationCohort()` so this
   rewind scopes it automatically.
2. **Continuous lane axis** — `cohort-timeline-tracks.mjs` `buildDefaultTimeline`
   (activity / insights / standing / presence on a program-time axis), rendered
   by the Timeline view (#500). It answers "what's happening across the program,
   over time."

`teamTimeline()` (per-team dossier, `cohort-evidence-index.mjs`) is the third,
record-scoped view — and it's what `attributeInsightCards` (#498) lights up.

## Runbook — apply + operate

### A. Apply the connections migration (one-time)
`public_cohort_connections` follows the same hand-applied pattern as
`public_releases_feed` / `public_calendar_grid`.

1. Open the Supabase project (`txjntzwksiluvqcpccpc`) → **SQL editor**.
2. Paste + run [`supabase/migrations/20260624000000_public_cohort_connections.sql`](../supabase/migrations/20260624000000_public_cohort_connections.sql).
   (Or, with the Supabase CLI linked: `supabase db push`.)
3. Verify the boundary — an anon read returns the (empty) row shape, writes are denied:
   ```bash
   curl -s "$SUPABASE_URL/rest/v1/public_cohort_connections?select=id&id=eq.current" \
     -H "apikey: $ANON_KEY" -H "authorization: Bearer $ANON_KEY"
   # → [] (no row yet) or [{"id":"current"}] after the first publish; never a 404
   ```

### B. Run the daily connection routine
The LLM step runs OFF CI (no key in CI), using your own local AI CLI.

```bash
# 1. compute edges with your local AI (auto-detects claude / codex / ollama,
#    or set COHORT_LLM_CMD="claude -p"); writes the artifact + can publish:
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run build:connections:publish

# or split: build locally, commit the artifact, let CI publish it:
npm run build:connections      # → cohort-data/artifacts/connections/generated/connections.json
git add cohort-data/artifacts/connections && git commit && git push
#   → .github/workflows/cohort-connections-sync.yml re-publishes the committed
#     artifact to Supabase hourly (cron "41 * * * *", no LLM in CI)
```

Two cadences by design: the **local-AI build** (edge computation) runs **daily**;
the **CI publish** of the already-committed artifact runs **hourly** so a missed
Supabase write self-heals without re-running the model.

The CI workflow (`cohort-connections-sync.yml`) is held back from the feature
commit because pushing `.github/workflows/` needs a `workflow`-scoped token
(`gh auth refresh -h github.com -s workflow`, then push, or add via the GitHub
UI). It is **not on `origin`** — the file currently lives only on a local
`feat/cohort-connections-workflow` branch, so recreate it from there (or via the
Actions UI) once the token allows.

### C. Schedule it
- **Local** (matches "your own AI"): a daily OS task / cron running
  `npm run build:connections:publish` with `SUPABASE_*` in the environment.
- **Cloud routine**: a scheduled Claude Code agent that runs the same command
  daily (uses the cloud `claude` CLI, which the build script auto-detects).

## What's still to wire (and why it needs you)
- **Inferred-attribution marker in views** — partly done: #498 already renders the
  `~ inferred` chip on the say/did/shipped evidence rows, and #500's timeline draws
  inferred dots hollow. Remaining surfaces (directory / PMF) could follow the same
  `content_json.teams_basis:"inferred"` flag. Pure UI; needs a visual pass.
- **Connections on the relationship map** — connection edges are a current graph
  (no time axis), so they belong on the ecosystem map / collab board, not the
  Timeline. Could be folded in like the evidence dependency edges.
- **Real standing-weekly** — the standing lane reads `state.standingWeekly`,
  which is a one-time seed; making it live needs the team-standing Supabase feed.
- **Capture coverage + the distillation engine** — live in your private repo +
  Edge Functions; the read side is all that's here.

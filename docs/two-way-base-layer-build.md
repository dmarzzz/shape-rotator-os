# Two-way contribution layer — build + go-live

**Status:** built on `feat/two-way-base-layer` (stacked on `feat/your-mirror-v0` / #504). Backend + logic tested headless; renderer UI bundle-checked. Nothing applied to the live DB or pushed yet — see "Go-live" below. · **Date:** 2026-06-25

The design + rationale live in [`two-way-contribution-layer.md`](two-way-contribution-layer.md) (#505). This is the build companion: what shipped, the one deliberate v0 deviation, how it was verified, and the owner-only go-live steps.

## What's built

**The spine (one append-only log, several doors).**
- `supabase/migrations/20260625120000_cohort_events.sql` — `cohort_events` (anon write-only, RLS INSERT-only, modeled byte-for-byte on `os_profile_updates`) + the `app_cohort_feed` security-barrier view (recent 60d/500-row slice, claim hash stripped, superseded events collapsed via `NOT EXISTS`). **`supersedes` is service_role-only** (anon can't author a revert) — the feed exposes event ids, so an anon-writable supersedes would let anyone collapse anyone's feed line; member self-revert returns with claim-token enforcement.
- `apps/os/src/renderer/supabase-cohort-events.mjs` — `appendCohortEvent` (write) + `fetchCohortFeed` (read) + `defaultWeightFor` (the noise line).
- `apps/os/src/renderer/cohort-source.js` — `applyCohortEventsOverlay` folds the feed onto the surface each refresh tick (mirrors `applyProfileUpdateOverlay`); added to the refresh chain + the change signature.

**The doors (emit sites)** — `apps/os/src/renderer/cohort-emit.mjs` centralizes actor/claim-hash/app-context/emit-policy resolution so call sites are one-liners:
- `profile_edit` — on a direct sync save (`alchemy.js` `submitEditAsLocalSync`). Field NAMES only, not values (see deviation below).
- `self_report` — when an AI self-report is applied (`self-report.js`).
- `contest` — when a say/did/shipped claim is contested (`alchemy.js` `wireMirrorPanel`); the durable rebuttal still lands in `public_card_contests`.
- `transcript` — when a transcript is uploaded (`alchemy.js` `submitContextCompose`); `with_whom` seeds the connection graph.

**Soft identity** — `apps/os/src/renderer/claim-token.mjs` mints a device-local opaque token on claim (wired into `identity.js` `setIdentity`/`clearIdentity`); writes carry `sha-256(token)` as `claim_token_hash`. Not hard auth; enforcement deferred (see deviation).

**The activity feed (visible surface)** — `apps/os/src/renderer/activity-feed.mjs` (pure view-model: filter → rank → roll-up + labels) + `feed-rank.mjs` (on-device "for you" re-rank — affinity / recency / weight / unseen, no viewer signal leaves the device). Mounted as a new `activity` alchemy mode (`alchemy.js` `renderActivityMode`/`wireActivityMode`, `tabs.js` label+icon, `styles.css` rules). "Everyone" (raw recency) vs "for you" toggle.

**The agent-override seam** — `apps/os/src/renderer/cohort-prefs.mjs` exposes the knobs (`muted_authors`, `muted_event_types`, `interest_tags`, `emit_policy`, `feed_mode`), the `prefs ?? default` resolver, `filterByPrefs`, and `shouldEmit` (emit_policy actually suppresses broadcasts at v0). Each change can echo a `prefs` event. Chat-agent wiring is deferred (the cohort-chat branch).

**Safety net** — `scripts/publish-cohort-events-snapshot.mjs` (service_role read → `cohort-data/snapshots/YYYY-MM-DD.json`, claim hash stripped) + `.github/workflows/cohort-events-snapshot.yml` (daily, automation-branch+PR, like `calendar-sync`).

**Consolidation** — `apps/os/src/renderer/supabase-anon-write.mjs` extracts the shared `postAnonRow` + `clampField` + `getAnonRows`; `supabase-feedback`, `supabase-contest`, and `supabase-self-report` were refactored onto it (no 4th copy of the boilerplate). The roadmap's residual #9.

**Engine Phase-1 (attribution decision log)** — branch `feat/attribution-decision-log` in the Engine repo: `attribution_decisions` (append-only, operator-tier) + a `SECURITY DEFINER` trigger on `cohort_insight_cards` that logs one immutable row per `approval_state` change, plus the `model_proposed` stamp in `publish-cohort-insights-supabase.mjs`. The doc's "cheapest first step" (instrument the override). Phase 2 (calibration strip) and Phase 3 (rebuttals) are explicitly later.

## The one deliberate v0 deviation

The spec says "a profile field's live value = the latest non-superseded event." **We do NOT overlay live profile field VALUES from `cohort_events` at v0.** The spine powers the **feed + timeline + provenance**; field values keep flowing through the existing reversible/operator-gated paths (swf-node/PR direct edit; `os_profile_updates` approved overlay for AI drafts). A `profile_edit` event is a feed/provenance signal of a change the member made through the normal save path — the changed field NAMES, not the values.

**Why:** the `os_profile_updates` migration deliberately chose an approval gate because "anon-mutable would be anyone-overwrites-anyone." The spec's answer is the claim-token — but claim-token *enforcement* is deferred (feed-side scoring, no server gate). Letting raw `cohort_events` overwrite identity fields live, with no enforcement, would reintroduce exactly that hole. This is the spec's eventual model minus the part that isn't safe until enforcement lands. When claim-token enforcement ships (an edge function or RLS predicate), the value-overlay can be turned on.

## Verification

- **~50 new node tests** + the refactored modules' tests pass: `supabase-anon-write`, `supabase-cohort-events`, `claim-token`, `feed-rank`, `cohort-prefs`, `activity-feed`, `cohort-events-snapshot`. Full suite: 669/671 (the 2 failures are a pre-existing missing `apps/web/cohort-surface.json` artifact, unrelated).
- **Bundle check passes** (`npm --workspace @shape-rotator/os run bundle:check`) — the whole renderer graph incl. the `alchemy.js`/`tabs.js` edits resolves (104 modules).
- **Engine:** 11 tests pass; migration + trigger validated offline against PGlite.
- **Not yet done:** a full Electron run (the UI is bundle-checked only, same ceiling as #504) and any live-DB write.

## Go-live (owner-only — irreversible / needs creds)

1. **Apply migrations to live Supabase `txjntzwksiluvqcpccpc`** via the Engine migration path (Engine is the sole schema owner): `20260625120000_cohort_events.sql` (OS) and `20260625000000_attribution_decisions.sql` (Engine). Idempotent (`create … if not exists`).
2. **Push the branches + open PRs.** `feat/two-way-base-layer` depends on #504 landing first. The snapshot workflow (`cohort-events-snapshot.yml`) is a `.github/workflows/` change → needs a **workflow-scoped token** to push (the known gotcha) — push it separately or add it via the GitHub UI.
3. **Full Electron run + screenshot** — claim an identity, edit a field (sync save), upload a transcript, contest a claim, open the `activity` tab; confirm the feed renders and "for you"/"everyone" toggles.
4. **Schema-drift note (Engine doc §3):** `cohort_events` and `attribution_decisions` are both NEW, independent tables — neither deepens the existing `cohort_insight_cards` co-ownership drift. The broader os-slim reconciliation remains a separate, recommended cleanup (out of scope here).

## Deferred tail (designed, not built — with reasons)

- **Claim-token server enforcement** (edge function / RLS / feed scoring) — the spec's own deferred item; once it lands, turn on the live profile-value overlay.
- **Calibration strip (Engine Phase 2)** — false-acts vs false-defers per engine version; needs Phase-1 data to accumulate first.
- **Attribution rebuttals (Engine Phase 3)** — member-write contest that travels with the claim; follows Phase 1.
- **Transcript private-bucket upload + richer `with_whom`/`where_shared` capture** — the spec's "nicer door later"; v0 reuses the context-submission flow + emits the event.
- **Agent-chat wiring of the prefs seam** — needs the `feat/cohort-chat-and-connections` branch in one tree; the knobs + resolver are ready.
- **Realtime feed push** — the ~30s read-back tick is enough for v0.

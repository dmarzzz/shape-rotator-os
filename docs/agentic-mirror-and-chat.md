# Agentic Your Mirror + cohort chatbot — build spec

**Status:** in progress. P0–P2 + P1b + P4 infra landed (unit-tested; needs an in-app run to verify). P3 = timeline strip done; per-person cards + freshness deferred (need the offline engine + rebuild). · **Date:** 2026-06-26 · Builds on [`two-way-contribution-layer.md`](two-way-contribution-layer.md) and [`your-mirror-receive-and-chat.md`](your-mirror-receive-and-chat.md).

## Goal

Turn the **one-shot** self-report (scan sessions + GitHub → local LLM → whitelisted profile delta) into a **multi-step, multi-tool, self-questioning agent** that runs on the member's own LLM and can keep the whole app current — profiles, GitHub identity fields, timelines — for the member **and (as proposals) for others**, with everything checkable and reversible.

Decisions locked with the user (2026-06-26):

| # | Decision | Consequence |
|---|----------|-------------|
| GitHub fields | **All three**: `geo` + `links.github` + `links.repo` | whitelist + overlay must carry them |
| Write path | **Supabase overlay, operator-approved** (no PR) | needs the os_profile_updates whitelist + grant extension (done) |
| Others | **Edit others too**, as proposals | every proposal carries proposer provenance; `is_self=false` is the "check this" flag |
| Build | **All of it**, with provenance + version history | append-only inbox = inherent history; proposer columns = self-vs-other |

## Approval model (launch phase)

Migration `20260626130000_os_profile_updates_autoapprove_self.sql` (**applied + verified on production 2026-06-26**) auto-approves a **self-edit** (`proposer == subject`, `is_self=true`) at insert via a `BEFORE INSERT` trigger — it applies on the next refresh, no operator step. A proposal about **someone else** (`is_self=false`) still lands `status='pending'` for the **daily recompute / Engine review**. The client still can't choose `status` (ungranted column); the trigger decides from the row's own ids; the delta whitelist CHECK still guarantees a row "fits in the spots" before it can auto-approve. Verified end-to-end as the anon role (rolled back): self → `approved`, other → `pending`.

Why it's safe enough now: claim-token isn't server-enforced yet, so pre-approval was never a real security boundary here — the real guards are **whitelist** (can't write junk fields) + **feed visibility** (every applied self-edit emits a `self_report` cohort_event) + **daily recompute**. To revert to review-everything, drop the trigger.

## The non-negotiable invariant (third-party)

The agent **proposes**; humans/the daily job **promote** anything about someone else. This is what makes "anyone may propose about anyone" safe at 20–50-member scale — transparency + reversibility, not a new trust model. Concretely:

- Third-party profile **values** land in `os_profile_updates` as `status='pending'` and only overlay after approval. They get the closest look (dedicated `is_self=false` index).
- The **privacy gate** is per-step: public grounding may reach a remote model (claude/codex); anything session/transcript-derived stays on a **local** model (ollama) or is scrubbed first. Raw session bodies never leave the box (the daybook redactor). A self-questioning loop must **re-gate per step** — today the gate only fires once at spawn, and `main.js` doesn't even forward `dataMode` (bug to fix).

## Data model

### Provenance + versioning (migration `20260626120000_os_profile_updates_provenance.sql` — landed)

Extends the existing `os_profile_updates` inbox:

- `proposer_record_id`, `proposer_claim_hash` — WHO proposed (claim hash = trust signal, recorded now / enforced later, never exposed by a view).
- `is_self` — **generated** `(proposer_record_id = record_id)`; tamper-evident (client gives ids, not the flag). `false` = third-party proposal to triage.
- `delta` whitelist widened to add **`geo`** + **`links`** (object scoped to `github`/`repo` only). The 7 self-declared fields still pass.
- Views: `app_profile_updates` (approved overlay, now exposes proposer + is_self) and **`app_profile_update_history`** (approved+applied prior states, newest-first — the version history; pending never exposed).

Version history is **inherent**: the inbox is append-only, "current" = newest approved row per `record_id`, a prior state is an older row. No separate history table.

> ✅ **APPLIED to production** (project `txjntzwksiluvqcpccpc`) on 2026-06-26 via the Supabase dashboard SQL editor — columns, views, grant, and the extended whitelist all verified present. It was applied **directly** (not via the Engine migration path), so the Engine repo's migration history may be drifted — reconcile the same SQL there. Profile-value proposals (incl. geo/links + edit-others provenance) now succeed server-side as `status='pending'`.

### The action contract (`apps/os/src/renderer/cohort-chat-actions.mjs` — landed, 18 tests)

The security boundary. The model emits JSON action blocks; this whitelists/sanitizes/stamps them. Verbs:

| verb | → channel | provenance |
|------|-----------|------------|
| `propose_profile_update` | `os_profile_updates` (pending) | stamped (`is_self`) |
| `propose_connection` | `cohort_events` type=`connection` (already allowed) | stamped |
| `file_contest` | `public_card_contests` + contest event | stamped |
| `request_scan` | local sessions / public github tool (consent) | — |
| `request_transcript` | `emitTranscript` door (consent) | always self |
| `ask` | clarifying question surfaced to member (self-questioning) | — |
| `note` | terminal display text | — |

`parseChatActions(stdout, ctx)` scans noisy CLI stdout string-awarely (mirrors `self-report-synth.mjs`), keeps the last action batch, drops unknown verbs / malformed args / proposals about unknown records (the model can't invent people), caps at `MAX_ACTIONS_PER_TURN`, and stamps `origin` from the **caller's** identity — never the model's.

## Build phases

**P0 — foundation (done):** provenance migration · `cohort-chat-actions.mjs` + tests.

**P1 — the agent loop (done; unit-tested, needs in-app verify):**
- ✅ `main.js` `fg:cohort-chat:start` now threads `dataMode` to the gate (was hardcoded public).
- ✅ `cohort-chat-context.mjs`: `ACTION_CONTRACT` appended in `buildChatPrompt({agent:true})` ("propose, never claim done"); `toolResults` slot for loop iterations.
- ✅ `cohort-chat.js`: agent mode on; capture-then-parse at `finishRun` (`parseChatActions`), strips the json block from the bubble, renders per-action HITL review cards (approve/dismiss), routes approvals to the doors. `/mirror` intercept + first-run offer wired.
- ✅ `cohort-chat-mirror.mjs` + tests — the chat↔mirror opt-in (`your-mirror-receive-and-chat.md` §B.5).
- ⬜ **Deferred to P1b:** the autonomous multi-spawn tool loop (model emits `request_scan` → app scans → re-prompt with `toolResults` → continue). Today `request_scan` hands directly to the consent modal; `ask` surfaces one question. The `toolResults` prompt slot is in place for the re-spawn.

**P2 — write doors + execution:**
- ✅ `supabase-self-report.mjs`: `saveProfileProposal(subject, delta, {proposerRecordId, proposerClaimHash, rationale})` — provenance + extended whitelist (`sanitizeProfileFields`). *Migration-gated: fails server-side until the provenance migration is applied.*
- ✅ `cohort-emit.mjs`: `emitConnection({fromId,toId,reason})` — works today (type already granted; actor=proposer ⇒ self-vs-other).
- ✅ `file_contest` routes to `submitContest` + `emitContest` — works today.
- ⬜ `cohort-source.js` `applyProfileUpdateOverlay`: deep-merge `links` (today shallow) + overlay `geo`; surface proposer/is_self. **Needed before approved geo/links proposals render.**

**P3 — Mirror made whole:**
- ✅ **Timeline strip** in `mirrorPanelHtml` (`mirrorTimelineHtml`) — the team's public dated activity (feed + releases) on a self-scaled axis. Additive (returns "" when <2 points); inline design-token styles.
- ⬜ Per-person cards (`cohort-insight-engine.cjs` emit `subjectType:'person'`; person→card lookup in `alchemy.js cohortInsightSubjectMap`; per-person resolution in `mirror-view.mjs`). **Needs the offline engine + a bundle rebuild + app to verify** — deferred rather than edited blind.
- ⬜ Runtime freshness overlay (parallel to `sdsShippedReleasesHtml`) so an approved self/agent update shows on the card immediately. Tied to per-person resolution (the card is team-keyed today).
- ⬜ "Proposed by X · pending/approved" + version-history affordance from `app_profile_update_history`.

**P4 — sessions → timelines:**
- ✅ `self-report-node.js` `listLocalSessions` — **metadata-only** per-session records (no body read); IPC `fg:sessions:list` + preload `listLocalSessions` (verified live: found 32 real sessions).
- ✅ `cohort-timeline-tracks.mjs` `buildSessionsLane` (tier:`local`) + opt-in `localSessions` input to `buildDefaultTimeline` (+tests).
- ⬜ Mount the sessions lane in a member-private timeline surface (alchemy `renderCohortTimeline` fetches `listLocalSessions`) — kept off the SHARED cohort timeline by design (privacy).

**P1b — autonomous loop:** ✅ bounded one-round public-tool follow-up: a github-only `request_scan` runs `scanGithubActivity` inline and re-asks with `toolResults` (`runTurn`/`runGithubFollowup`, capped by `MAX_TOOL_ROUNDS`). Private sessions scan stays on the consent modal.

## The daily recompute (Engine — the reconciliation net)

With self-edits auto-approving, the daily job is the safety/durability layer. It should:
1. **Promote** — read `status in ('pending','approved')` (service_role), re-whitelist vs `schema.yml`, merge non-destructively, open ONE PR folding approved deltas into `cohort-data/people/*.md` (incl. `geo`/`links`), then flip merged rows `status='applied'` so the overlay drops them.
2. **Review third-party** — surface `is_self=false` pending rows (the `os_profile_updates_thirdparty_idx`) for human approve/reject; nothing third-party renders until approved.
3. **Reconcile** — recompute the cohort surface + say/did/shipped insights from the merged truth; this is also where a bad auto-approved self-edit gets corrected (visible in the feed in the meantime).

## What still needs the Engine repo

- Extend `scripts/promote-profile-updates.mjs` for `geo`/`links` + the third-party review queue (step 1–2 above).
- (Future) claim-token server enforcement (edge fn / RLS) — turns `is_self` from a trigger hint into a real gate, closing the spoof window the launch phase accepts.
- Reconcile the two applied migrations into the Engine repo's migration history (they were applied directly to the DB).

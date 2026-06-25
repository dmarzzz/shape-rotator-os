# Your Mirror — receive→update loop + chat opt-in (build status & handoff)

**Status:** receive loop built + tested + committed on `feat/your-mirror-v0`; backend validated live on a real machine. Two parts need other resources — the chat opt-in (the cohort-chat branch) and the promote function (Engine). · **Date:** 2026-06-25

## What's built and validated

The full member-facing loop is on `feat/your-mirror-v0`:

```
mirror "✨ update from my recent work"
  → consent (per-source) → scan local AI sessions + github
  → the member's OWN local AI (claude -p / codex) drafts a whitelisted delta + asks a question
  → review diff (+ optional refine on the answer)
  → APPLY:  (a) prefill the profile editor → member saves (canonical: putLocalRecord/PR)   [existing]
            (b) RECEIVE: saveSelfReportUpdate → Supabase os_profile_updates (pending)        [new]
  → operator approves (pending→approved)
  → app reads app_profile_updates (approved) → applyProfileUpdateOverlay merges onto the profile (no PR)
  → (durability) Engine promote-profile-updates.mjs folds approved deltas into cohort-data/people/*.md
```

**Validated headless on a real PC (2026-06-25):** scan read 40 files / 7 projects of real `~/.claude`+`~/.codex`
sessions into a scrubbed digest; `codex exec` (gpt-5.5) returned an accurate, correctly-shaped delta + question
in ~43s through `runSynthesis`; parse/sanitize/merge produced 6 changed fields. Ollama was dropped as a focus
(small models ignore the field schema; ~90% of members have Claude Code / Codex, which follow it natively).

## Receive side (committed)

- `supabase/migrations/20260625000000_os_profile_updates.sql` — anon **write-only** inbox (`status` defaults
  `pending`, ungranted; DB CHECK whitelists the 7 fields) + an **approved-only** `app_profile_updates` view for read-back.
- `apps/os/src/renderer/supabase-self-report.mjs` — `saveSelfReportUpdate` (append) + `fetchApprovedProfileUpdates` (read).
- `self-report.js` fires the receive on apply (additive); `cohort-source.js` `applyProfileUpdateOverlay` overlays approved rows.

### To go live (needs Supabase access — Engine owns the schema)
1. Apply the migration to `txjntzwksiluvqcpccpc` (via the Engine migration path, like `os_feedback`/`os_spheres`).
2. Approve a row: flip `status` `pending→approved` (Supabase dashboard, or the promote script below). The overlay then shows it cohort-wide on the next refresh — no PR.

## Promote function (Engine repo — `scripts/promote-profile-updates.mjs`)

Belongs in Engine (it needs `service_role` to read the inbox + write a PR into the public OS repo):
1. `service_role`: `select * from os_profile_updates where status in ('pending','approved') order by created_at`.
2. Per `record_id`: load `cohort-data/people/<id>.md`, parse frontmatter (same parse as `build-bundles.js`).
3. **Re-whitelist** against `schema.yml people.surface_fields` (don't trust stored keys) + merge non-destructively (mirror `mergeDelta`).
4. Open ONE PR per batch into `dmarzzz/shape-rotator-os` main, labeled `self-report promotion`.
5. On merge: `update os_profile_updates set status='applied', reviewed_at=now()` so the overlay drops it (markdown now carries it).

## Chat opt-in flow (needs the cohort-chat branch — design + seam ready)

The seam is in place: `self-report.js` now exposes `window.__srwkOpenSelfReport` (graceful no-op until merged).
At merge, add a small module + ~3 hooks; **do not** rebuild the per-source consent — route into the existing modal.

**Trigger (hybrid):** a one-time dismissible first-run bot offer **+** a `/mirror` slash-command. The button opens
the existing consent modal (the real gate). No free-text intent parsing for consent.

**Offer turn (copy):**
> **Mirror** — Want me to refresh your profile from your own recent work? I can read what you've been building and
> draft an update — you review and approve every line before anything saves.
> **What I'd read** (only what you tick — nothing is read until you pick): • your **local AI sessions** (Claude
> Code / Codex logs *on this machine*, summarized; raw chats never leave your computer) • your **public GitHub
> activity** (one call to github.com; nothing private, no token).
> **What I'd do:** draft a change to a few fields (now · weekly intention · skills · seeking · offering · prior
> work) → show you the diff → you tweak and save.   `[ Choose what to share → ]`  `[ Not now ]`

Also: a no-CLI turn (gate on `getCohortChatConfig().ready`) and a no-identity turn (claim profile first).

**New module** `apps/os/src/renderer/cohort-chat-mirror.mjs` (`maybeOfferMirror`, `runMirrorOffer`, `handToSelfReport` →
`window.__srwkOpenSelfReport?.({ person: myPerson, githubDigest:"" })`). **Hooks in `cohort-chat.js`:** call
`maybeOfferMirror()` in `open()`; intercept a leading `/mirror` in `send()` (don't send to the CLI). **Consent record:**
local nag-state only (`srwk:mirror_offer_state_v1`, per `record_id`, mirroring `identity_onboarding_skipped_v1`); the
real per-source read consent stays **per-run / uncached** by design, so each scan re-asks.

**Merge dependency:** `feat/your-mirror-v0` (mirror + receive) and `feat/cohort-chat-and-connections` (chat) are
disjoint trees. Merge order: mirror is the dependency → merge it into the chat branch (or an integration branch).
Filenames don't collide; reconcile only the shared `chatCmd` local-CLI readiness contract so a member's configured
CLI is the same one both use.

## Next steps (priority order)

Branch `feat/your-mirror-v0` is at this point self-contained, 15 commits, 36 tests green, validated headless on a
real machine (codex/gpt-5.5). Robustness review done (commit 7680bc2). What remains, grouped:

### A. Go live (needs Supabase / Engine access — can't be done from the OS repo alone)
1. **Apply migrations** to Supabase `txjntzwksiluvqcpccpc` via the Engine path: `20260624120000_public_card_contests.sql`
   and `20260625000000_os_profile_updates.sql` (like `os_feedback`/`os_spheres`).
2. **Operator approve UI/step.** Flip `os_profile_updates.status` `pending→approved` (dashboard, or a tiny CLI). The
   read-back overlay then surfaces it cohort-wide on the next refresh — no PR.
3. **Engine `scripts/promote-profile-updates.mjs`** (Part 4): service_role read of approved rows → re-whitelist vs
   `schema.yml` → merge into `cohort-data/people/*.md` → one PR → flip `status='applied'`.

### B. Chat opt-in (needs the branches in one tree)
4. **Merge** mirror → chat branch (or an integration branch). At merge, dedupe the CLI resolver (the deliberate
   decouple in `self-report-node.js` vs `cohort-chat-node.js`) and reconcile the shared `main.js` IPC region.
5. **Wire the chat hooks**: new `cohort-chat-mirror.mjs` (offer copy + `/mirror` + gating) calling the existing
   `window.__srwkOpenSelfReport` seam; record nag-state in `identity.js`. Reuse the modal's per-source consent.

### C. Verify in-app
6. **Full Electron run + screenshot** (backend is validated headless; the UI is bundle-checked only). Needs a local
   CLI on PATH (or a configured `chatCmd`) + a claimed identity.

### D. Residual robustness / consolidation (from the review — lower severity)
7. **Thread `allowedSkillAreas` vocab** into the prod `sanitizeDelta`/`saveSelfReportUpdate` calls (skill_areas is
   currently accepted unfiltered) — or drop the unused param. Also pass the refine `answer` to the inbox row.
8. `readCapped` should cut on a line boundary (not a raw byte tail); bound the approved-read query
   (`distinct on (record_id)` or transition promoted rows out of `approved`); `mergeDelta` compare set-fields as sets.
9. **Consolidation P2–P4**: extract the shared anon-write POST boilerplate (`postAnonRow`), unify `clampField`, and a
   `getSelfReportAppContext()` (also fills the inbox `app_version`/`platform`) across `supabase-self-report` /
   `supabase-contest` / `supabase-feedback`. Safe but touches sibling modules — do as one dedicated pass.
   **Do NOT** dedupe the CLI resolver until B.4 (deliberate cross-branch decouple).

### E. Cleanup
10. `git worktree remove C:/Users/micha/shape-os-mirror-wt` once the branch is merged.

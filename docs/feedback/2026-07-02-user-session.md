# User session feedback — 2026-07-02 (2 users, ~1h)

Source: live walkthrough with two cohort members (recorded, transcribed). This doc is
the working checklist; the PR body mirrors it. Items get checked off as commits land
on `feedback/user-session-2026-07-02` (or follow-up branches referenced inline).

Legend: **P1** = clear bug or top-of-mind confusion raised repeatedly · **P2** = solid
UX improvement · **P3** = nice-to-have / bigger design question.

## Bot / assistant ("the ball")

- [x] **P1 — Render bot responses as markdown. (`ad72344c`)** Responses currently show raw `*stars*`
  and `#` instead of bold/headings. ("process the readme in a Markdown manner…
  the stars instead of bold, or hero text")
- [x] **P1 — Transcript lookup uses source data, not distilled. (`127a6e75`)** Asking the bot "what
  transcripts are relevant for Conclave" returns "none are available" — it should
  search the distilled/processed versions.
- [x] **P1 — Purpose outline. (`6dcd14d1`)** First-open state should say what the bot is for and
  what it can do ("I click this button, what does it mean? What does it do?").
- [x] **P2 — Page-context presets. (`6be35f29`)** When opened on a page (e.g. collabboard with a
  project selected), offer preset prompts about that page and pass page context into
  the conversation. Assume the current page first, don't over-stuff context.
- [x] **P2 — Full-page expansion. (`96a0efad`)** Users want to expand the bot to the whole page,
  not just the small add-on panel.
- [x] **P2 — Clipping bug. (`d9924334`)** The bot panel clips/overlaps other UI when it interacts
  with the page (calendar area especially).
- [x] **P2 — Surface the rewrite feature. (`543a2bf8`)** "Rewrite this article/context with your
  own LLM" exists but is undiscoverable — make the entry point clear on the item.
- [ ] **P3 — "Send it to me" digest.** One-click "email me this transcript/digest"
  from a meeting; admin approve/disapprove flow; watch prompt-injection risk.

## Transcripts & upload

- [x] **P1 — Explain the route on upload. (`b6032c10`)** When adding a transcript, say what happens:
  where it goes (Supabase), that nothing is auto-published, what processing follows.
  ("Am I just yoloing this or is this going to be processed?" — needs a privacy note.)
- [x] **P2 — Grouping by type + confidence. (`97ba9234`)** Transcript page should group by type and
  confidence ("I'm confident / I'm not sure"), and best-guess items need reviewers.

## Sync / Mirror

- [x] **P1 — Make send/consent obvious. (`21d10fb0`)** State clearly that nothing is sent until you
  hit Send, and that the result is only visible inside the cohort-gated app (not
  posted anywhere public).
- [x] **P1 — Progress indicators. (`21d10fb0`)** While syncing, show what it's doing ("going through
  this, going through that") instead of a silent wait.
- [x] **P1 — "Refine with my answer" feels dead. (`21d10fb0`)** No loading state, no confirmation
  that the refinement was accepted/applied. Add loading + success feedback.
- [x] **P2 — Question at the top. (`21d10fb0`)** Results should lead with the open statement about
  how it understands you + the refine question, then the detail below.
- [x] **P2 — Per-field update checkboxes. (`e8274215`)** Let users tick which data fields get
  updated on sync instead of all-or-nothing ("does it wipe everything?").
- [x] **P2 — Per-card editing. (`a6ac4809`)** Allow editing/asking to change a specific card rather
  than regenerating everything.
- [x] **P2 — Show/adjust the prompt before sync. (`e8274215`)** A box where the user can guide the
  model before it runs (e.g. "we pivoted from NDI to transcriptions") to cut
  iteration count.
- [x] **P2 — Edit button & settings discoverability. (`a6ac4809`)** Users couldn't find where to
  edit before sending; make the edit affordance obvious.
- [x] **P3 — Multi-project session noise. (`fc38cdae`)** Sessions from unrelated projects are read;
  it's directed to focus on what's relevant — verify and reassure in the UI.

## Membrane (landing) & calendar

- [x] **P1 — Notification timeframe bug. (`7d3ee9cd`)** Showed "Final Demo Day today" for a July 22
  event. Fix the date labeling.
- [x] **P2 — Calendar clipping. (`d9924334`)** Right-side calendar clips (time-wise) with other
  elements / the bot panel.
- [x] **P2 — "What's next" focus. (`d9924334`)** Right side should prioritize the immediate next
  events and anything big upcoming, not a full snapshot.
- [ ] **P3 — Simplify membrane overall.** Users don't get what the page is for;
  consolidate for low cognitive load.

## Context page

- [x] **P2 — Consolidate the button clutter. (`2ae6e377`)** Per-item buttons are "everywhere, not
  in separate rows" — group into fewer controls / one overflow menu.
- [x] **P2 — Bold, clear headings. (`543a2bf8`)** Headings merge with body text in overview; fix
  hierarchy and the body-text formatting of articles/transcripts.
- [x] **P2 — Clarify "Draft". (`543a2bf8`)** Nobody (including the operator) knew what the Draft
  label means. Define it or remove it.
- [ ] **P3 — One team-context document.** A single canonical doc per team (about,
  positioning, connected to member context), instead of a mess of event/signal
  cards; fix cross-team data leakage (Conclave notes appearing elsewhere) and stale
  positioning (NDI → transcriptions pivot not reflected).

## Collabboard

- [x] **P1 — Remove the extra info beneath the board. (`4503eb8f`)** "All that extra information is
  useless. Remove it, even if it's linked in the back."
- [ ] **P2 — Empty-team handling.** Teams with little data (e.g. a member who just
  joined) open to nothing — show a useful empty state.
- [x] **P2 — View-switch bugs. (`97ba9234`)** Timeline flash when switching views; switching
  between teams sometimes makes everything unclickable.
- [ ] **P3 — Overlap representation.** Circle map doesn't show partial overlaps;
  consider a Venn-ish view as an alternative.

## Matrix chat

- [x] **P1 — Verification flow. (`7836ccaf`)** After login most messages are undecryptable until the
  session is verified, and the app offers no working path. Surface a verification
  link/flow usable from Element. Landed: locked states name the exact
  Element path + session id; in-app interactive SAS verification still open.
- [x] **P2 — Channel list filtering. (`7836ccaf`)** List is unorganized and shows undecryptable/
  private rooms; default to channels you can actually read, add a filter.
- [ ] **P3 — Apps expand-button direction.** Chevron direction is wrong/confusing for
  the expand/close state.

## Navigation

- [x] **P2 — Pin the left menu open. (`c77fe88c`)** A lock/pin so the menu stays expanded, like
  browser sidebars.
- [x] **P2 — Color-line overlap bug. (`c77fe88c`)** The accent lines on the far left overlap the
  actual app content when the menu is closed.

## Asks / Activity

- [x] **P2 — Post-it-board simplification. (`fc38cdae`)** Keep asks dead simple — anything, official
  or unofficial; lead with asks. Consider merging activity into membrane.

## Profile / claim page

- [ ] **P2 — Simplify the claim-profile page.** "The claim page profile is terrible.
  It could be simplified a lot."
- [ ] **P3 — Windows org-ID entry.** A user had to enter the org ID manually on
  Windows GitHub setup — should be prefilled/automated.

## Positives (keep)

- Scroll segments on context articles.
- Circle map as a "where is everyone, quickly" view (preferred over the table).
- Sync asking clarifying questions ("has focus fully shifted to speaker diarization?")
  landed well with both users.
- Running on the user's own Claude CLI/usage was called out as the interesting part.

# Two-way contribution layer — base-layer spec (v0)

**Status:** design, agreed. Build target for the next phase. · Scope: 20–50 members, ~4-week horizon.

## Why

The app today is mostly read-only: people open it to *look someone up*. To make it a place
members return to, contributions need to (a) be low-friction, (b) show up in *what everyone else
sees* quickly, and (c) be visible as "what's happening." This spec defines the **base layer** that
makes member contribution safe, cheap, and fast — designed so a member's own AI agent can customize
their slice of it later without a rewrite.

## Keystone: one event spine

Every contribution — a profile edit, an uploaded transcript, a contest, an AI self-report — is the
same shape: *a member added something*. They all append to one log:

```
cohort_events  (append-only)
  id · record_id · actor · event_type · field · value(jsonb)
  weight · claim_token_hash · app_version · platform · created_at · supersedes
```

That single table simultaneously is the **canonical timeline**, the **audit trail**, the **revert
mechanism**, the **source the shared surface reads from**, and the **activity feed**. We build one
spine and several doors into it, not several features.

- **Current state is derived:** a profile field's live value = the latest non-superseded event for
  `(record_id, field)`. The renderer overlays this the same way it already overlays approved updates
  and spheres (read-back, no PR).
- **Event types (v0):** `profile_edit`, `transcript`, `contest`, `self_report` (a batch of edits),
  `connection`, `prefs` (see the override seam).

## Direct self-edit + safety net

Members edit their own profile directly; writes append events that go live on the next refresh.
Because there are no member logins, this is made safe by **transparency + reversibility**, not a
pre-approval gate:

- **Append-only:** never `UPDATE`/`DELETE` a field. A correction is a *new* event that supersedes the
  old one — so the full history survives and any change reverts with one append.
- **Snapshots:** a daily job commits `cohort_events` to the repo as `cohort-data/snapshots/YYYY-MM-DD.json`,
  on top of the database's own automatic daily backups. Two independent recovery paths, both cheap.
- **Visibility as deterrent:** because edits land in a public feed, a bad edit is seen immediately by
  the whole cohort — at this scale, that is its own safeguard and makes cleanup trivial.

## Soft identity: claim-token

To make "edit your own profile" meaningful — and the feed's "X updated…" attributions *trustworthy*
rather than spoofable — claiming a profile mints a **local claim-token**. Writes carry it; the base
layer treats token-matched writes as trusted "self."

- Not hard auth. It turns "anyone can edit anyone" into "you'd have to deliberately work around it,"
  which at this scale is plenty.
- It also gives a member's future agent a **credential to act as them**, instead of being
  indistinguishable from anonymous traffic.
- Enforcement options (decide at build): a small edge function that checks the token hash, an RLS
  predicate, or feed-side scoring that simply marks unverified writes. Start with the lightest that
  ships.

## The activity feed

- **Backend = one global stream.** A recent slice of `cohort_events` exposed through an
  anon-readable view (`app_cohort_feed`), mirroring the existing approved-only view pattern.
- **Frontend = personalized "for you", on-device.** The viewer's app re-ranks the global stream using
  *its own* profile — none of those signals leave the device:
  - **affinity** — author shares your skill-areas / team / a connection → boosted
  - **recency** — newer wins, with decay so the feed doesn't ossify
  - **weight** — a "shipped" or transcript outranks a one-word tweak (below)
  - **unseen** — anything since your last visit gets a "new" mark (last-seen is a local timestamp)
  - your *own* events peel into a separate "your activity" rail
- **Ship global first.** The raw global feed is useful to everyone on day one; "for you" is an
  additive read-layer enhancement with no schema change.

## Default event weights (the noise line)

Opinionated defaults, overridable per member:

| weight | events |
| --- | --- |
| **loud** | `shipped`, a changed focus / weekly intention, `transcript`, `contest` |
| **medium** | `skills` / `seeking` / `offering` changes, `connection` |
| **quiet / rolled-up** | cosmetic + typo tweaks — no own feed line; collapsed as "tidied profile" |

A feed people trust to be signal is one they keep opening.

## The agent-override seam (design now, fill later)

Every default is overridable, and the override surface is the member's own AI agent. The trick:

> the agent's customizations are **more events on the same spine.** "Mute typo edits," "show me more
> of topic X," "don't broadcast my skill tweaks" → each is a `prefs` event appended to
> `cohort_events`. The read functions resolve `prefs ?? default`.

So "the agent changes it later" needs **no new system**, and every customization is itself timelined
and revertible. The base layer must expose the knobs even though nothing fills them yet:

- `muted_authors`, `muted_event_types`, `interest_tags` (boost), `emit_policy` (what I broadcast),
  `feed_mode` (`global` | `for_you`).

## Transcripts as provenance-stamped contributions

An upload is not a file drop — it's a contribution with context:

- File → a private storage bucket (`transcripts`).
- A `transcript` event captures: `title`, `where_shared`, `with_whom`, `takeaway`, `links`.
  `with_whom` quietly builds the connection/contribution graph.
- Entry point: the chatbot drives the context capture now; a `+` button is the same flow with a
  nicer door later.

## What this reuses (already in the codebase)

- The overlay / read-back pattern (`cohort-source.js` `apply*Overlay`).
- The anon write-only table + approved-only view pattern (`os_profile_updates`, `public_card_contests`).
- The self-report modal and the member's-own-AI seam (`window.__srwkOpenSelfReport`).
- The identity / profile-claim concept (`identity.js`).

## Build order

1. **Spine + safety net** — `cohort_events` table, the `app_cohort_feed` view, the daily snapshot job.
2. **Direct self-edit** — write events from the profile editor; mint + carry the claim-token.
3. **Global feed surface** — render the raw recent stream.
4. **"For you" ranking** — the on-device re-rank (additive).
5. **Transcripts** — upload + context capture.
6. **Agent-override seam** — wire `prefs` events to the member's chat agent.

## Deferred

- Exact claim-token enforcement mechanism (edge function vs RLS vs feed scoring).
- Realtime push (Supabase Realtime) for instant feed updates — the ~30s read-back is enough for v0.
- Migration ownership: like the existing tables, the new schema is `create … if not exists`
  idempotent so it can be applied directly or reconciled into the canonical migration path later.

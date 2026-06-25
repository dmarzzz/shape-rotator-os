-- cohort_events — the append-only "two-way contribution layer" spine.
-- Written LIVE from the renderer (apps/os/src/renderer/supabase-cohort-events.mjs)
-- using the public anon key. Sibling of os_profile_updates / public_card_contests /
-- os_feedback: anon WRITE-ONLY (column-scoped INSERT grant + INSERT-only policy,
-- RLS on, no anon SELECT on the base table). Read-back is through the
-- `app_cohort_feed` security-barrier view (a recent slice, claim hash stripped).
--
-- Keystone (docs/two-way-contribution-layer.md): every member contribution — a
-- profile edit, an uploaded transcript, a contest, an AI self-report — is the same
-- shape, "a member added something," and appends here. This one table is the
-- canonical timeline, the audit trail, the revert mechanism (via `supersedes`),
-- the activity-feed source, and the agent-override seam (the `prefs` event type).
--
-- v0 SCOPE NOTE (deliberate, see the design doc): this spine powers the FEED +
-- timeline + provenance. It does NOT overlay live profile FIELD VALUES. Field
-- values keep flowing through the existing reversible/operator-gated paths
-- (swf-node/PR self-edit; os_profile_updates approved overlay for AI drafts),
-- because claim-token ENFORCEMENT is deferred (feed-side scoring, not a server
-- gate) — and an unguarded anon row must not be able to overwrite anyone's
-- identity fields cohort-wide. A `profile_edit` event is a feed/provenance signal
-- of a change a member made through the normal save path, not the value itself.
-- `claim_token_hash` is recorded now so feed attributions are trustworthy and a
-- member's future agent has a credential; the read view never exposes it.
create extension if not exists pgcrypto;

create table if not exists public.cohort_events (
  id               uuid primary key default gen_random_uuid(),
  -- The subject this event is about (whose timeline it lands on). For a
  -- profile_edit / self_report this is the member's own record_id.
  record_id        text not null check (char_length(record_id) between 1 and 128),
  -- Who performed it (the claimer's record_id; usually == record_id). Nullable:
  -- an unclaimed/anonymous contribution carries no actor.
  actor            text check (actor is null or char_length(actor) <= 128),
  event_type       text not null
                     check (event_type in ('profile_edit', 'transcript', 'contest',
                                           'self_report', 'connection', 'prefs')),
  -- Optional: which field a profile_edit touched (now / weekly_intention / ...).
  field            text check (field is null or char_length(field) <= 128),
  -- The event payload (changed-field summary, transcript metadata, prefs map, …).
  value            jsonb not null default '{}'::jsonb,
  -- The noise line: loud / medium / quiet (default medium). Quiet events are
  -- rolled up in the feed ("tidied profile") rather than given their own line.
  weight           text not null default 'medium'
                     check (weight in ('loud', 'medium', 'quiet')),
  -- Soft identity: sha-256 of a device-local claim-token. Recorded for feed
  -- trust + the future agent credential; NEVER exposed by the read view.
  claim_token_hash text check (claim_token_hash is null or char_length(claim_token_hash) <= 128),
  app_version      text check (app_version is null or char_length(app_version) <= 64),
  platform         text check (platform    is null or char_length(platform)    <= 64),
  -- The event this one revises/reverts. Append-only correction: never UPDATE a
  -- row — a superseding row hides the old one from the feed (NOT EXISTS in the view
  -- below). v0: supersedes is NOT in the anon grant and the anon policy forces it
  -- NULL — only service_role (operators / the Engine) may author a revert. Reason:
  -- the feed exposes event ids, so an anon-writable supersedes would let anyone
  -- collapse anyone's feed line (the same anyone-overwrites-anyone hole the field
  -- values avoid). Member self-revert returns once claim-token enforcement lands.
  supersedes       uuid,
  created_at       timestamptz not null default now(),
  constraint cohort_events_value_is_object check (jsonb_typeof(value) = 'object'),
  constraint cohort_events_value_size      check (pg_column_size(value) <= 8000)
);

-- Feed reads: recent slice newest-first, by subject, and by actor (for the
-- viewer's own "your activity" rail). Partial-free b-tree indexes keep the
-- read view cheap as the log grows.
create index if not exists cohort_events_recent_idx
  on public.cohort_events (created_at desc);
create index if not exists cohort_events_record_idx
  on public.cohort_events (record_id, created_at desc);
create index if not exists cohort_events_actor_idx
  on public.cohort_events (actor, created_at desc)
  where actor is not null;

alter table public.cohort_events enable row level security;

-- Start from zero; hand anon exactly the writable columns (id / created_at are
-- server-assigned and ungranted, so a client cannot spoof them). Operators + the
-- daily snapshot job read/maintain via service_role (bypasses RLS).
revoke all on public.cohort_events from anon, authenticated;
-- NOTE: supersedes is intentionally NOT granted to anon (revert is operator-only;
-- see the column comment). Operators + the daily snapshot job use service_role.
grant insert (record_id, actor, event_type, field, value, weight,
              claim_token_hash, app_version, platform)
  on public.cohort_events to anon;
grant select, insert, update on public.cohort_events to service_role;

-- The only anon policy: INSERT (write-only). No USING / no SELECT policy ⇒ anon
-- cannot read any row from the base table. WITH CHECK re-asserts the bounds at the
-- row level so the policy is self-contained.
drop policy if exists "anon append cohort event" on public.cohort_events;
create policy "anon append cohort event"
  on public.cohort_events
  for insert
  to anon
  with check (
    char_length(record_id) between 1 and 128
    and event_type in ('profile_edit', 'transcript', 'contest', 'self_report', 'connection', 'prefs')
    and weight in ('loud', 'medium', 'quiet')
    and jsonb_typeof(value) = 'object'
    and pg_column_size(value) <= 8000
    and (actor is null or char_length(actor) <= 128)
    and (field is null or char_length(field) <= 128)
    and (claim_token_hash is null or char_length(claim_token_hash) <= 128)
    and (app_version is null or char_length(app_version) <= 64)
    and (platform    is null or char_length(platform)    <= 64)
    -- Revert is operator-only: anon may never author a supersede (it isn't in the
    -- column grant either; this re-asserts it at the row level for self-documentation).
    and supersedes is null
  );

-- READ-BACK: the activity feed reads this view. A security-barrier view exposes a
-- recent slice (60 days, 500 rows) with the claim hash STRIPPED, and collapses
-- superseded events (a correction/revert hides the row it supersedes). The view
-- runs with its owner's privileges, so anon may select it without any SELECT on
-- the base table. The on-device "for you" re-rank happens in the renderer.
drop view if exists public.app_cohort_feed;
create view public.app_cohort_feed
  with (security_barrier = true) as
  select e.id, e.record_id, e.actor, e.event_type, e.field, e.value, e.weight,
         e.supersedes, e.created_at
  from public.cohort_events e
  where e.created_at > now() - interval '60 days'
    and not exists (
      select 1 from public.cohort_events s where s.supersedes = e.id
    )
  order by e.created_at desc
  limit 500;
grant select on public.app_cohort_feed to anon, authenticated;

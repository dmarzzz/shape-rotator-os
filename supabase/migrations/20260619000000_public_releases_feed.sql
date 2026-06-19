-- public_releases_feed — the single PUBLIC row carrying the membrane "what's
-- new" release feed.
--
-- The github-releases-sync workflow (scripts/check-github-releases.mjs +
-- scripts/publish-releases-to-supabase.mjs) upserts the feed here via the
-- service role; the OS + web apps read this one row anonymously for the LIVE
-- feed, falling back to the committed apps/os/src/cohort-surface.json bundle
-- when offline. This is the SAME live-source / offline-bundle split the calendar
-- uses (public_calendar_grid) — it removes the dependency on a git PR merging
-- into protected main for the feed to advance.
--
-- This repo is PUBLIC and ships the anon key, so RLS + grants are the ENTIRE
-- security boundary. Content is non-sensitive by construction: the payload is
-- built from public GitHub Releases + the same cohort markdown already served
-- publicly, so an anon read here exposes nothing the feed didn't already show.
-- The boundary, matching public_calendar_grid:
--   * anon / authenticated  -> SELECT only, scoped to id = 'current'
--   * anon                  -> NO insert/update/delete (no write policy)
--   * service_role          -> select/insert/update (writes bypass RLS)

create table if not exists public.public_releases_feed (
  id          text primary key default 'current',
  payload     jsonb not null,
  source      text,
  updated_at  timestamptz not null default now()
);

alter table public.public_releases_feed enable row level security;

-- Explicit grants: start from zero, then hand anon/authenticated read only and
-- the service role the verbs the upsert needs. No anon write grant exists.
revoke all on public.public_releases_feed from anon, authenticated;
grant select on public.public_releases_feed to anon, authenticated;
grant select, insert, update on public.public_releases_feed to service_role;

-- Read policy scoped to the single published row (defense in depth: even if more
-- rows were ever added, anon only ever sees 'current').
drop policy if exists "public read releases feed" on public.public_releases_feed;
create policy "public read releases feed"
  on public.public_releases_feed
  for select
  to anon, authenticated
  using (id = 'current');

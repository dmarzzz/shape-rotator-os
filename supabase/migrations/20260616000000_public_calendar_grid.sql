-- public_calendar_grid — the single PUBLIC, sanitized cohort calendar row.
--
-- The calendar-sync workflow (scripts/build-calendar-from-google.js +
-- scripts/publish-calendar-grid-to-supabase.mjs) upserts the verified grid here
-- via the service role; the OS + web apps read this one row anonymously for the
-- LIVE calendar, falling back to the committed bundle when offline.
--
-- This repo is PUBLIC and ships the anon key, so RLS + grants are the ENTIRE
-- security boundary. This file is the checked-in, reviewable source of that
-- boundary (the live project txjntzwksiluvqcpccpc was migrated to match). The
-- boundary, verified live:
--   * anon / authenticated  -> SELECT only, scoped to id = 'current'
--   * anon                  -> NO insert/update/delete (no write policy)
--   * service_role          -> select/insert/update (writes bypass RLS)
-- Content safety is enforced upstream: the producer drops private/confidential
-- events and a fail-closed leak-scan refuses to publish a grid containing
-- emails / video-call links / private routing markers.

create table if not exists public.public_calendar_grid (
  id            text primary key default 'current',
  grid          jsonb not null,
  source        text,
  last_refresh  timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.public_calendar_grid enable row level security;

-- Explicit grants: start from zero, then hand anon/authenticated read only and
-- the service role the verbs the upsert needs. No anon write grant exists.
revoke all on public.public_calendar_grid from anon, authenticated;
grant select on public.public_calendar_grid to anon, authenticated;
grant select, insert, update on public.public_calendar_grid to service_role;

-- Read policy scoped to the single published row (defense in depth: even if more
-- rows were ever added, anon only ever sees 'current').
drop policy if exists "public read calendar grid" on public.public_calendar_grid;
create policy "public read calendar grid"
  on public.public_calendar_grid
  for select
  to anon, authenticated
  using (id = 'current');

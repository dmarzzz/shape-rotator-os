-- public_cohort_connections — the single PUBLIC row carrying the precomputed
-- cohort connection graph (the "who should talk to whom" edges).
--
-- A daily routine (scripts/build-cohort-connections.mjs, run by an organizer
-- with their LOCAL AI CLI — no API key in the app) computes ranked, reasoned
-- connection edges from the cohort markdown (seeking/offering, skill_areas,
-- clusters, declared dependencies, recent GitHub activity, distilled insights)
-- and scripts/publish-connections-to-supabase.mjs upserts the payload here via
-- the service role. The OS + web apps read this one row ANONYMOUSLY and surface
-- the edges per team ("who to talk to") and as grounding inside cohort chat —
-- so the APP never calls an LLM at runtime; it only reads precomputed edges.
--
-- This mirrors public_releases_feed / public_calendar_grid exactly: a curated
-- PUBLIC projection, never a gated base table. This repo is PUBLIC and ships the
-- anon key, so RLS + grants are the ENTIRE security boundary. The payload is
-- built only from cohort markdown already served publicly + public GitHub
-- activity, so an anon read here exposes nothing not already public. The
-- boundary:
--   * anon / authenticated  -> SELECT only, scoped to id = 'current'
--   * anon                  -> NO insert/update/delete (no write policy)
--   * service_role          -> select/insert/update (writes bypass RLS)

create table if not exists public.public_cohort_connections (
  id          text primary key default 'current',
  payload     jsonb not null,
  source      text,
  updated_at  timestamptz not null default now()
);

alter table public.public_cohort_connections enable row level security;

-- Explicit grants: start from zero, then hand anon/authenticated read only and
-- the service role the verbs the upsert needs. No anon write grant exists.
revoke all on public.public_cohort_connections from anon, authenticated;
grant select on public.public_cohort_connections to anon, authenticated;
grant select, insert, update on public.public_cohort_connections to service_role;

-- Read policy scoped to the single published row (defense in depth: even if more
-- rows were ever added, anon only ever sees 'current').
drop policy if exists "public read cohort connections" on public.public_cohort_connections;
create policy "public read cohort connections"
  on public.public_cohort_connections
  for select
  to anon, authenticated
  using (id = 'current');

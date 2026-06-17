-- public_team_standing_weekly — the PUBLIC, anon-readable projection of per-week
-- team standing. The OS standing + Timeline views read this LIVE
-- (apps/os/src/renderer/standing-supabase.mjs), falling back to the committed
-- cohort-standing-weekly.json when offline or before this migration is deployed.
--
-- WHY A VIEW (not an anon grant on the base table): anon's intended read surface is
-- the public_* projections only, never base tables (see
-- 20260616010000_revoke_stray_anon_grants.sql). The base public.team_standing_weekly
-- has a public-read RLS policy but deliberately NO anon GRANT, so it stays
-- unreadable over the API. This curated view is the single anon-exposed surface and
-- projects ONLY the public columns — not evidence_card_ids, as_of, source, or
-- internal ids.
--
-- This repo is PUBLIC and ships the anon key, so this GRANT is the entire security
-- boundary. The view runs with the owner's rights (so anon need not be granted on
-- the base table); all rows are public-tier (team id, program week, PMF stage 0-8,
-- confidence, declared target + provenance), so exposing every row is intended —
-- the same posture as public_calendar_grid. NOTE: Supabase advisors will flag this
-- as a "security definer view"; that is intentional for a curated public projection.
--
-- PENDING: security review + live deploy to project txjntzwksiluvqcpccpc. This file
-- is the checked-in, reviewable source of the boundary (mirrors the
-- public_calendar_grid migration convention); the live project must be migrated to
-- match. Until then the live read 404s and the app uses the committed mirror.

create or replace view public.public_team_standing_weekly as
  select record_id, program_week, stage, confidence, target_stage, target_source
  from public.team_standing_weekly;

revoke all on public.public_team_standing_weekly from anon, authenticated;
grant select on public.public_team_standing_weekly to anon, authenticated;

comment on view public.public_team_standing_weekly is
  'Public anon-readable projection of team_standing_weekly (per-week PMF stage/confidence/target) for the OS standing + Timeline live reads. Owner-rights view; all rows are public-tier.';

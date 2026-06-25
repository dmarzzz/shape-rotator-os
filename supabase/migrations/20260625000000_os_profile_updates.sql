-- os_profile_updates — RECEIVE inbox for member-approved self-report deltas
-- ("Your Mirror"). Written LIVE from the renderer
-- (apps/os/src/renderer/supabase-self-report.mjs) using the public anon key.
--
-- WRITE-ONLY for anon, exactly like public.public_card_contests /
-- public.context_submissions: a column-scoped INSERT grant + an INSERT-only
-- policy (RLS on; no SELECT/UPDATE/DELETE policy for anon) lets the shipped anon
-- key append ONE *pending* delta and nothing else. We deliberately do NOT use the
-- os_spheres anon read-write-any-record model: spheres are cosmetic dials, but
-- profile fields are identity claims and there's no member auth to scope "own" to,
-- so anon-mutable would be anyone-overwrites-anyone. Instead the delta is received
-- as a pending row that an operator / the Engine approves + promotes.
--
-- `status` is NOT in the anon grant, so anon rows always default to 'pending' and
-- can't preset 'approved'. id / created_at / reviewed_at are server-assigned and
-- ungranted, so a client can't spoof them. The whitelist CHECK mirrors
-- SELF_REPORT_FIELDS in self-report-synth.mjs and holds for every role.
create extension if not exists pgcrypto;

create table if not exists public.os_profile_updates (
  id           uuid primary key default gen_random_uuid(),
  record_id    text not null check (char_length(record_id) between 1 and 128),
  delta        jsonb not null,
  question     text check (question is null or char_length(question) <= 400),
  answer       text check (answer   is null or char_length(answer)   <= 2000),
  source_kinds text[] not null default '{}'::text[],
  app_version  text check (app_version is null or char_length(app_version) <= 64),
  platform     text check (platform    is null or char_length(platform)    <= 64),
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'applied', 'rejected')),
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz,
  constraint os_profile_updates_delta_is_object check (jsonb_typeof(delta) = 'object'),
  constraint os_profile_updates_delta_size      check (pg_column_size(delta) <= 8000),
  -- Hard whitelist: delta may carry ONLY the seven self-declared surface fields.
  constraint os_profile_updates_delta_whitelist check (
    not exists (
      select 1 from jsonb_object_keys(delta) k
      where k not in ('now', 'weekly_intention', 'skills', 'skill_areas', 'seeking', 'offering', 'prior_work')
    )
  )
);

create index if not exists os_profile_updates_pending_idx
  on public.os_profile_updates (record_id, created_at desc)
  where status = 'pending';
create index if not exists os_profile_updates_approved_idx
  on public.os_profile_updates (record_id, created_at desc)
  where status = 'approved';

alter table public.os_profile_updates enable row level security;

-- Start from zero; hand anon exactly the writable columns (status excluded ⇒
-- pending only). Operators read + promote via service_role (bypasses RLS).
revoke all on public.os_profile_updates from anon, authenticated;
grant insert (record_id, delta, question, answer, source_kinds, app_version, platform)
  on public.os_profile_updates to anon;
grant select, insert, update on public.os_profile_updates to service_role;

drop policy if exists "anon submit profile update" on public.os_profile_updates;
create policy "anon submit profile update"
  on public.os_profile_updates
  for insert
  to anon
  with check (
    char_length(record_id) between 1 and 128
    and jsonb_typeof(delta) = 'object'
    and pg_column_size(delta) <= 8000
    and status = 'pending'
  );

-- READ-BACK: the app overlays APPROVED deltas onto the rendered profile (no PR).
-- A security-barrier view exposes ONLY approved rows (never the raw pending inbox,
-- which carries member-claimed text before review). The view runs with its owner's
-- privileges, so anon may select it without any SELECT on the base table.
drop view if exists public.app_profile_updates;
create view public.app_profile_updates
  with (security_barrier = true) as
  select record_id, delta, created_at, reviewed_at
  from public.os_profile_updates
  where status = 'approved';
grant select on public.app_profile_updates to anon, authenticated;

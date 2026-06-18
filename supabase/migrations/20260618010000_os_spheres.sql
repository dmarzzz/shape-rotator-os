-- Per-person sphere customization. Written LIVE from the renderer
-- (apps/os/src/renderer/supabase-sphere.mjs) using the public anon key — the
-- app's second client-side write to Supabase (after os_feedback).
--
-- Unlike os_feedback (anonymous, append-only), this row is MUTABLE and keyed
-- by the person's cohort record_id, so anon gets SELECT + INSERT + UPDATE (the
-- two writes back an upsert via PostgREST `Prefer: resolution=merge-duplicates`).
--
-- SECURITY NOTE (accepted trade-off): the app has no real per-user auth —
-- identity is local-only (localStorage) and the anon key ships in the client —
-- so this grant technically lets any client overwrite ANY record_id's sphere.
-- The editor only ever saves the user's own claimed record_id, the column
-- CHECKs bound every value to [0,1], record_id length is bounded, and there is
-- no DELETE grant. Real protection waits on member auth (Matrix OAuth already
-- in the repo); until then this is cosmetic, low-stakes, fully revertible data.

create table if not exists public.os_spheres (
  record_id  text primary key
    check (char_length(record_id) between 1 and 128),
  hue        real not null check (hue        between 0 and 1),
  hue2       real not null check (hue2       between 0 and 1),
  phase      real not null check (phase      between 0 and 1),
  intensity  real not null check (intensity  between 0 and 1),
  complexity real not null check (complexity between 0 and 1),
  updated_at timestamptz not null default now()
);

-- Server-stamp updated_at on every insert/update so a client can neither set
-- nor spoof it (updated_at is also kept out of the anon column grants below).
create or replace function public.os_spheres_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists os_spheres_set_updated_at on public.os_spheres;
create trigger os_spheres_set_updated_at
  before insert or update on public.os_spheres
  for each row execute function public.os_spheres_touch_updated_at();

alter table public.os_spheres enable row level security;

-- Start from zero so no default-privilege grant leaves the surface wider than
-- intended, then grant exactly: read all rows, write the six user-owned columns.
-- updated_at is intentionally excluded from the write grants (trigger owns it).
revoke all on public.os_spheres from anon, authenticated;
grant select on public.os_spheres to anon;
grant insert (record_id, hue, hue2, phase, intensity, complexity) on public.os_spheres to anon;
grant update (record_id, hue, hue2, phase, intensity, complexity) on public.os_spheres to anon;

-- Anyone can read every sphere (this is public, shared cosmetic data — that's
-- the whole point: "others can see it").
drop policy if exists "anon can read spheres" on public.os_spheres;
create policy "anon can read spheres"
  on public.os_spheres
  for select
  to anon
  using (true);

-- INSERT + UPDATE policies re-assert the [0,1] bounds at the row level so the
-- policy is self-contained; together they back the upsert. record_id bound is
-- enforced by the column CHECK.
drop policy if exists "anon can insert spheres" on public.os_spheres;
create policy "anon can insert spheres"
  on public.os_spheres
  for insert
  to anon
  with check (
    hue        between 0 and 1
    and hue2       between 0 and 1
    and phase      between 0 and 1
    and intensity  between 0 and 1
    and complexity between 0 and 1
  );

drop policy if exists "anon can update spheres" on public.os_spheres;
create policy "anon can update spheres"
  on public.os_spheres
  for update
  to anon
  using (true)
  with check (
    hue        between 0 and 1
    and hue2       between 0 and 1
    and phase      between 0 and 1
    and intensity  between 0 and 1
    and complexity between 0 and 1
  );

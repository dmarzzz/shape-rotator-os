-- Anonymous OS feedback + idea box. Written LIVE from the renderer
-- (apps/os/src/renderer/supabase-feedback.mjs) using the public anon key — the
-- app's first client-side write to Supabase.
--
-- The table is WRITE-ONLY for anon: a column-scoped INSERT grant + an
-- INSERT-only policy let the shipped anon key append a row, and the absence of
-- any SELECT/UPDATE/DELETE policy (with RLS enabled) means anon can neither read
-- the feedback back nor alter it. Operators read it via the dashboard /
-- service_role, which bypasses RLS — so no SELECT policy is needed.
--
-- No identity is stored: only the message and coarse, non-identifying app
-- context (version + platform). id and created_at are server-assigned and are
-- NOT in the anon column grant, so a client cannot spoof them.

create table if not exists public.os_feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null
    check (char_length(message) between 5 and 2000),
  app_version text
    check (app_version is null or char_length(app_version) <= 64),
  platform text
    check (platform is null or char_length(platform) <= 64),
  created_at timestamptz not null default now()
);

create index if not exists os_feedback_created_at_idx
  on public.os_feedback (created_at desc);

alter table public.os_feedback enable row level security;

-- Lock the grant surface to exactly "anon may INSERT these three columns".
-- Start from zero so no default-privilege grant leaves it wider than intended.
revoke all on public.os_feedback from anon, authenticated;
grant insert (message, app_version, platform) on public.os_feedback to anon;

-- The only policy on the table: anon may INSERT (write-only). No USING / no
-- SELECT policy → anon cannot read any row. WITH CHECK re-asserts the bounds at
-- the row level so the policy is self-contained.
drop policy if exists "anon can submit os feedback" on public.os_feedback;
create policy "anon can submit os feedback"
  on public.os_feedback
  for insert
  to anon
  with check (
    char_length(message) between 5 and 2000
    and (app_version is null or char_length(app_version) <= 64)
    and (platform is null or char_length(platform) <= 64)
  );

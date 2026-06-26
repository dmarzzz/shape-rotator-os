-- Member contests of a PUBLIC insight card ("Your Mirror" / say-did-shipped).
-- Written LIVE from the renderer (apps/os/src/renderer/supabase-contest.mjs)
-- using the public anon key — a sibling of the os_feedback / context_submissions
-- anon-write boxes.
--
-- The mechanic (coordination-OS framework move 5, "contest as core surface"):
-- when a member sees a public claim about themselves / their team they disagree
-- with — a stale declaration, work that's off-GitHub, a namesake mis-attribution,
-- or missing context — they file a rebuttal that travels with the claim. The app
-- renders the rebuttal back optimistically from local state in the SAME session;
-- this table is the durable, operator-readable record behind that.
--
-- WRITE-ONLY for anon, exactly like public.os_feedback: a column-scoped INSERT
-- grant + an INSERT-only policy (no SELECT/UPDATE/DELETE policy, RLS enabled) let
-- the shipped anon key append one contest row and nothing else — it cannot read
-- contests back, alter them, or touch any other table. Operators read via the
-- dashboard / service_role, which bypasses RLS, so no SELECT policy is needed.
--
-- No auth identity is stored: subject_id (the record the claim is about) plus the
-- member's own note carry everything an operator needs to fold an accepted
-- correction back into the cohort markdown. id and created_at are server-assigned
-- and are NOT in the anon grant, so a client cannot spoof them.

create table if not exists public.public_card_contests (
  id uuid primary key default gen_random_uuid(),
  subject_id text not null
    check (char_length(subject_id) between 1 and 128),
  card_kind text
    check (card_kind is null or char_length(card_kind) <= 64),
  card_id text
    check (card_id is null or char_length(card_id) <= 128),
  contest_kind text not null
    check (contest_kind in ('stale_declaration', 'off_github_work', 'wrong_attribution', 'context_missing')),
  member_note text
    check (member_note is null or char_length(member_note) <= 2000),
  declared_correction text
    check (declared_correction is null or char_length(declared_correction) <= 2000),
  app_version text
    check (app_version is null or char_length(app_version) <= 64),
  platform text
    check (platform is null or char_length(platform) <= 64),
  created_at timestamptz not null default now()
);

create index if not exists public_card_contests_subject_idx
  on public.public_card_contests (subject_id, created_at desc);

alter table public.public_card_contests enable row level security;

-- Lock the grant surface to exactly the columns a member may write. Start from
-- zero so no default-privilege grant leaves it wider than intended.
revoke all on public.public_card_contests from anon, authenticated;
grant insert (subject_id, card_kind, card_id, contest_kind, member_note, declared_correction, app_version, platform)
  on public.public_card_contests to anon;

-- The only policy on the table: anon may INSERT (write-only). No USING / no SELECT
-- policy → anon cannot read any row. WITH CHECK re-asserts the bounds at the row
-- level so the policy is self-contained.
drop policy if exists "anon can submit card contest" on public.public_card_contests;
create policy "anon can submit card contest"
  on public.public_card_contests
  for insert
  to anon
  with check (
    char_length(subject_id) between 1 and 128
    and contest_kind in ('stale_declaration', 'off_github_work', 'wrong_attribution', 'context_missing')
    and (card_kind is null or char_length(card_kind) <= 64)
    and (card_id is null or char_length(card_id) <= 128)
    and (member_note is null or char_length(member_note) <= 2000)
    and (declared_correction is null or char_length(declared_correction) <= 2000)
    and (app_version is null or char_length(app_version) <= 64)
    and (platform is null or char_length(platform) <= 64)
  );

-- team_standing_weekly — per-program-week PMF stage / confidence per team, the
-- source of truth behind the OS cohort "standing" + "targets" goal views (the
-- "as of [week]" timeline reads each team's stage per week from here, which is
-- what unlocks momentum and the week-over-week trajectory).
--
-- Canonical idempotent definition: the table was first created via the Supabase
-- API in an earlier session and not recorded as a migration; this file backfills
-- that and adds the target provenance column + invariant in one place so the
-- schema is reproducible from the repo. Public-read only (RLS); writes go through
-- the service role. Data (the weekly reads) lives in Supabase + the committed
-- build artifact apps/os/src/cohort-standing-weekly.json (regenerate with
-- scripts/build-standing-weekly.mjs), not in this migration.

create table if not exists public.team_standing_weekly (
  id uuid primary key default gen_random_uuid(),
  record_id text not null,
  program_week integer not null check (program_week >= 0 and program_week <= 12),
  stage integer not null check (stage >= 0 and stage <= 8),
  confidence text check (confidence in ('Low', 'Medium', 'High')),
  -- target_stage: a team's declared aim on the 0-8 PMF scale. NULL = no target
  -- declared yet → the OS renderer supplies a derived placeholder estimate.
  target_stage integer check (target_stage >= 0 and target_stage <= 8),
  -- target_source: provenance for the targets view. 'declared' = a real team-set
  -- aim (renders authoritative); 'derived' = no target set, target_stage is NULL
  -- and the consumer derives the estimate (renders tentative, "est"). The OS keys
  -- "is this real?" off Number.isFinite(target_stage), so the invariant below
  -- keeps that check and this column from ever disagreeing.
  target_source text check (target_source in ('declared', 'derived')),
  evidence_card_ids uuid[] not null default '{}'::uuid[],
  source text not null default 'seed',
  as_of timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_id, program_week),
  constraint team_standing_weekly_target_provenance check (
    (target_source = 'declared' and target_stage is not null) or
    (target_source = 'derived'  and target_stage is null) or
    (target_source is null)
  )
);

-- Idempotent column/constraint adds for environments where the table predates
-- this file (the API-created instance).
alter table public.team_standing_weekly
  add column if not exists target_source text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_standing_weekly_target_source_check'
      and conrelid = 'public.team_standing_weekly'::regclass
  ) then
    alter table public.team_standing_weekly
      add constraint team_standing_weekly_target_source_check
      check (target_source in ('declared', 'derived'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'team_standing_weekly_target_provenance'
      and conrelid = 'public.team_standing_weekly'::regclass
  ) then
    alter table public.team_standing_weekly
      add constraint team_standing_weekly_target_provenance check (
        (target_source = 'declared' and target_stage is not null) or
        (target_source = 'derived'  and target_stage is null) or
        (target_source is null)
      );
  end if;
end $$;

create index if not exists team_standing_weekly_record_idx
  on public.team_standing_weekly using btree (record_id, program_week);

alter table public.team_standing_weekly enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policy where polname = 'team_standing_weekly public read'
      and polrelid = 'public.team_standing_weekly'::regclass
  ) then
    create policy "team_standing_weekly public read"
      on public.team_standing_weekly for select using (true);
  end if;
end $$;

comment on table public.team_standing_weekly is
  'Per-program-week PMF stage/confidence per team. Public-read source for the OS standing + targets goal views.';
comment on column public.team_standing_weekly.target_source is
  'declared = team-set real target_stage (authoritative); derived = target_stage is NULL and the consumer derives a placeholder aim.';

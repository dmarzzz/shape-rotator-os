-- os_profile_updates -- team/project subject support.
--
-- Builds on:
--   20260625010000_os_profile_updates.sql
--   20260626120000_os_profile_updates_provenance.sql
--   20260626130000_os_profile_updates_autoapprove_self.sql
--
-- Person/profile updates already work live through the anon write-only inbox.
-- This migration adds the missing project lane the app already knows how to
-- propose: record_type='team' rows whose delta carries only award/evidence fields.
--
-- Important safety split:
--   - person self-edits may auto-approve when proposer_record_id = record_id
--   - team/project edits always remain pending for operator/Engine review

alter table public.os_profile_updates
  add column if not exists record_type text not null default 'person';

alter table public.os_profile_updates
  drop constraint if exists os_profile_updates_record_type_check;
alter table public.os_profile_updates
  add constraint os_profile_updates_record_type_check
    check (record_type in ('person', 'team'));

create index if not exists os_profile_updates_record_type_status_idx
  on public.os_profile_updates (record_type, status, created_at desc);

-- Replace the top-level whitelist with a subject-aware one:
--   person: self-declared profile fields + geo + links{github,repo}
--   team: award/evidence fields used by cohort-chat-actions.mjs
alter table public.os_profile_updates
  drop constraint if exists os_profile_updates_delta_whitelist;
alter table public.os_profile_updates
  add constraint os_profile_updates_delta_whitelist check (
    (
      record_type = 'person'
      and (delta - array[
        'now', 'weekly_intention', 'skills', 'skill_areas', 'seeking', 'offering',
        'prior_work', 'geo', 'links'
      ]::text[]) = '{}'::jsonb
    )
    or (
      record_type = 'team'
      and (delta - array[
        'journey', 'traction', 'prior_shipping', 'success_dimensions'
      ]::text[]) = '{}'::jsonb
    )
  );

-- Keep the person links sub-scope from the provenance migration.
alter table public.os_profile_updates
  drop constraint if exists os_profile_updates_delta_links_scope;
alter table public.os_profile_updates
  add constraint os_profile_updates_delta_links_scope check (
    not (delta ? 'links')
    or (
      record_type = 'person'
      and jsonb_typeof(delta -> 'links') = 'object'
      and ((delta -> 'links') - array['github', 'repo']::text[]) = '{}'::jsonb
    )
  );

-- Scope journey to the team award/evidence sub-schema. Numeric ranges and enums
-- are still enforced in the app sanitizer; this DB check prevents stray keys.
alter table public.os_profile_updates
  drop constraint if exists os_profile_updates_delta_journey_scope;
alter table public.os_profile_updates
  add constraint os_profile_updates_delta_journey_scope check (
    not (delta ? 'journey')
    or (
      record_type = 'team'
      and jsonb_typeof(delta -> 'journey') = 'object'
      and ((delta -> 'journey') - array[
        'stage', 'evidence_quality', 'market_upside', 'primary_bottleneck',
        'company_type', 'confidence', 'icp', 'problem', 'solution',
        'evidence_notes', 'next_milestone'
      ]::text[]) = '{}'::jsonb
    )
  );

-- Widen the anon column grant to include record_type. status remains ungranted.
grant insert (
  record_type, record_id, delta, question, answer, source_kinds, app_version,
  platform, proposer_record_id, proposer_claim_hash
) on public.os_profile_updates to anon;

-- Recreate the auto-approve function so only person self-edits auto-approve.
create or replace function public.os_profile_updates_autoapprove()
returns trigger language plpgsql as $fn$
begin
  if coalesce(new.record_type, 'person') = 'person'
     and new.proposer_record_id is not null
     and new.proposer_record_id = new.record_id then
    new.status := 'approved';
    new.reviewed_at := now();
  end if;
  return new;
end
$fn$;

drop policy if exists "anon submit profile update" on public.os_profile_updates;
create policy "anon submit profile update"
  on public.os_profile_updates
  for insert
  to anon
  with check (
    record_type in ('person', 'team')
    and char_length(record_id) between 1 and 128
    and jsonb_typeof(delta) = 'object'
    and pg_column_size(delta) <= 8000
    and status in ('pending', 'approved')
  );

drop view if exists public.app_profile_updates;
create view public.app_profile_updates
  with (security_barrier = true) as
  select record_type, record_id, delta, proposer_record_id, is_self, created_at, reviewed_at
  from public.os_profile_updates
  where status = 'approved';
grant select on public.app_profile_updates to anon, authenticated;

drop view if exists public.app_profile_update_history;
create view public.app_profile_update_history
  with (security_barrier = true) as
  select record_type, record_id, delta, proposer_record_id, is_self, status, created_at, reviewed_at
  from public.os_profile_updates
  where status in ('approved', 'applied')
  order by record_type, record_id, created_at desc;
grant select on public.app_profile_update_history to anon, authenticated;

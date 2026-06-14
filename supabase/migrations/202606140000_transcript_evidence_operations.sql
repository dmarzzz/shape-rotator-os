-- Make transcript distillation operational instead of only documented.
--
-- Adds:
-- - reviewed evidence cards as first-class rows
-- - private invite contacts for admin calendar selection
-- - app-safe evidence-card view
-- - T3 no-name/public guard metadata
-- - Supabase cron wrapper for Drive artifact discovery

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.evidence_cards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  derived_artifact_id uuid references public.derived_artifacts(id) on delete set null,
  source_artifact_id uuid references public.source_artifacts(id) on delete set null,
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  claim_type text not null default 'claim',
  title text not null,
  claim_text text not null,
  summary text,
  evidence_level text not null default 'inferred'
    check (evidence_level in ('observed', 'inferred', 'aggregate', 'reviewed')),
  confidence numeric,
  attribution_scope text not null default 'room'
    check (attribution_scope in ('room', 'team', 'person', 'aggregate', 'anonymous_public')),
  surface_tier text not null default 'T2' check (surface_tier in ('T1', 'T2', 'T3')),
  source_boundary text not null default 'private_vault'
    check (source_boundary in ('private_vault', 'derived_only', 'public_approved')),
  review_status text not null default 'needs_review'
    check (review_status in ('generated', 'needs_review', 'reviewed', 'blocked', 'published')),
  approval_state text not null default 'not_required'
    check (approval_state in ('not_required', 'pending', 'approved', 'blocked')),
  public_anonymous boolean not null default false,
  public_article_mode text,
  content_json jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not (content_json ? 'source_artifact_id')),
  check (not (content_json ? 'processing_job_id')),
  check (not (content_json ? 'derived_artifact_id')),
  check (not (content_json ? 'storage_ref')),
  check (surface_tier <> 'T3' or public_anonymous = true),
  check (surface_tier <> 'T3' or public_article_mode = 'generalized_no_named_insights')
);

create unique index if not exists evidence_cards_derived_claim_idx
on public.evidence_cards (derived_artifact_id, claim_type, md5(claim_text));

create index if not exists evidence_cards_org_review_idx
on public.evidence_cards (org_id, review_status, surface_tier, created_at);

alter table public.evidence_cards enable row level security;

create policy "coordinators read evidence cards"
on public.evidence_cards for select
using (public.is_org_coordinator(org_id));

create policy "coordinators manage evidence cards"
on public.evidence_cards for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

drop view if exists public.app_transcript_evidence_cards;

create view public.app_transcript_evidence_cards
with (security_barrier = true)
as
select
  id,
  org_id,
  session_id,
  claim_type,
  title,
  claim_text,
  summary,
  evidence_level,
  confidence,
  attribution_scope,
  surface_tier,
  review_status,
  approval_state,
  public_anonymous,
  public_article_mode,
  content_json,
  created_at,
  reviewed_at
from public.evidence_cards
where public.is_org_member(org_id)
  and (
    (
      surface_tier = 'T2'
      and review_status in ('reviewed', 'published')
    )
    or (
      surface_tier = 'T3'
      and review_status = 'published'
      and approval_state = 'approved'
      and public_anonymous = true
      and public_article_mode = 'generalized_no_named_insights'
    )
  );

revoke all on public.app_transcript_evidence_cards from public, anon, authenticated;
grant select on public.app_transcript_evidence_cards to authenticated, service_role;

create table if not exists public.private_invite_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  person_record_id text,
  display_name text not null,
  email text not null,
  team_record_id text,
  role_class text,
  source text not null default 'private_admin_directory',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, email)
);

alter table public.private_invite_contacts enable row level security;

create policy "coordinators read private invite contacts"
on public.private_invite_contacts for select
using (public.is_org_coordinator(org_id));

create policy "admins manage private invite contacts"
on public.private_invite_contacts for all
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create or replace function private.transcript_public_text_has_private_markers(value text)
returns boolean
language sql
immutable
as $$
  select coalesce(value, '') ~* '([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|private-vault:|drive://|"source_artifact_id"\s*:|"storage_ref"\s*:|[A-Z]:\\Users\\|/Users/)'
$$;

revoke all on function private.transcript_public_text_has_private_markers(text) from public, anon, authenticated;

create or replace function public.enforce_t3_evidence_card_boundary()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if new.surface_tier = 'T3'
    and (
      new.review_status = 'published'
      or new.approval_state = 'approved'
    ) then
    if new.public_anonymous is not true then
      raise exception 'T3 evidence cards must be anonymous public insights';
    end if;

    if new.public_article_mode <> 'generalized_no_named_insights' then
      raise exception 'T3 evidence cards require generalized_no_named_insights mode';
    end if;

    if private.transcript_public_text_has_private_markers(
      coalesce(new.title, '') || ' ' ||
      coalesce(new.claim_text, '') || ' ' ||
      coalesce(new.summary, '') || ' ' ||
      coalesce(new.content_json::text, '')
    ) then
      raise exception 'T3 evidence card contains private-source or direct-contact markers';
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists enforce_t3_evidence_card_boundary on public.evidence_cards;
create trigger enforce_t3_evidence_card_boundary
before insert or update of review_status, approval_state, surface_tier, public_anonymous, public_article_mode, title, claim_text, summary, content_json
on public.evidence_cards
for each row
execute function public.enforce_t3_evidence_card_boundary();

revoke all on function public.enforce_t3_evidence_card_boundary() from public, anon, authenticated;

create or replace function public.enforce_t3_publication_gates()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if new.tier = 'T3'
    and (
      new.review_status = 'published'
      or new.approval_state = 'approved'
    ) then
    if new.artifact_kind <> 'public_candidate' then
      raise exception 'T3 approval/publication requires a public_candidate artifact';
    end if;

    if new.approval_state <> 'approved' then
      raise exception 'T3 publication requires approval_state=approved';
    end if;

    if not exists (
      select 1
      from public.approval_gates gate
      where gate.derived_artifact_id = new.id
        and gate.org_id = new.org_id
    ) then
      raise exception 'T3 approval/publication requires approval gates';
    end if;

    if exists (
      select 1
      from public.approval_gates gate
      where gate.derived_artifact_id = new.id
        and gate.org_id = new.org_id
        and gate.gate_status not in ('approved', 'not_required')
    ) then
      raise exception 'T3 approval/publication requires all gates approved or not_required';
    end if;

    if private.transcript_public_text_has_private_markers(
      coalesce(new.content_md, '') || ' ' || coalesce(new.content_json::text, '')
    ) then
      raise exception 'T3 publication blocked by private-source or direct-contact markers';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_t3_publication_gates() from public, anon, authenticated;

create or replace function private.invoke_poll_drive_artifacts()
returns bigint
language plpgsql
security definer
set search_path = private, extensions, public
as $drive_poll_schedule$
declare
  project_url text := private.transcript_worker_secret('shape_transcript_worker_project_url');
  worker_token text := private.transcript_worker_secret('shape_transcript_worker_token');
  org_id text := private.transcript_worker_secret('shape_transcript_worker_org_id');
  folder_id text := private.transcript_worker_secret('shape_drive_artifact_folder_id');
  drive_id text := private.transcript_worker_secret('shape_drive_id');
  lookback_hours integer := coalesce(nullif(private.transcript_worker_secret('shape_drive_poll_lookback_hours'), '')::integer, 168);
begin
  if project_url is null or project_url = '' then
    raise exception 'missing Vault secret: shape_transcript_worker_project_url';
  end if;
  if worker_token is null or worker_token = '' then
    raise exception 'missing Vault secret: shape_transcript_worker_token';
  end if;
  if org_id is null or org_id = '' then
    raise exception 'missing Vault secret: shape_transcript_worker_org_id';
  end if;
  if folder_id is null or folder_id = '' then
    raise exception 'missing Vault secret: shape_drive_artifact_folder_id';
  end if;

  return net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/poll-drive-artifacts',
    body := jsonb_strip_nulls(jsonb_build_object(
      'org_id', org_id,
      'drive_folder_id', folder_id,
      'drive_id', nullif(drive_id, ''),
      'lookback_hours', greatest(1, least(720, lookback_hours)),
      'apply', true
    )),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || worker_token
    ),
    timeout_milliseconds := 25000
  );
end;
$drive_poll_schedule$;

revoke all on function private.invoke_poll_drive_artifacts() from public, anon, authenticated;

create or replace function private.ensure_poll_drive_artifacts_schedule()
returns void
language plpgsql
security definer
set search_path = private, extensions, public
as $drive_poll_schedule$
begin
  if coalesce(private.transcript_worker_secret('shape_transcript_worker_project_url'), '') = ''
    or coalesce(private.transcript_worker_secret('shape_transcript_worker_token'), '') = ''
    or coalesce(private.transcript_worker_secret('shape_transcript_worker_org_id'), '') = ''
    or coalesce(private.transcript_worker_secret('shape_drive_artifact_folder_id'), '') = '' then
    raise notice 'Drive artifact watcher Vault secrets are missing; cron schedule not enabled yet';
    return;
  end if;

  begin
    perform cron.unschedule('poll-drive-artifacts-every-15-minutes');
  exception
    when others then
      null;
  end;

  perform cron.schedule(
    'poll-drive-artifacts-every-15-minutes',
    '*/15 * * * *',
    $$ select private.invoke_poll_drive_artifacts(); $$
  );
  raise notice 'Drive artifact watcher cron schedule enabled: poll-drive-artifacts-every-15-minutes';
end;
$drive_poll_schedule$;

revoke all on function private.ensure_poll_drive_artifacts_schedule() from public, anon, authenticated;

select private.ensure_poll_drive_artifacts_schedule();

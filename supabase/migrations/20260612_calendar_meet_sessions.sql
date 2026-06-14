-- Shape Rotator OS calendar + Meet transcript preparation.
-- This migration defines the first operational tables needed to move calendar
-- sessions from repo snapshots into Supabase while keeping raw transcript
-- material behind stricter source-artifact boundaries.

create extension if not exists pgcrypto;

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.org_memberships (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('member', 'coordinator', 'admin')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_memberships m
    where m.org_id = target_org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_coordinator(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_memberships m
    where m.org_id = target_org_id
      and m.user_id = auth.uid()
      and m.role in ('coordinator', 'admin')
  );
$$;

create or replace function public.is_org_admin(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_memberships m
    where m.org_id = target_org_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
  );
$$;

create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check (provider in ('google')),
  calendar_id text not null,
  organizer_email text not null,
  auth_mode text not null check (auth_mode in ('oauth_organizer', 'domain_wide_delegation')),
  token_ref text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled', 'error')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider, calendar_id)
);

create table if not exists public.calendar_acl_bindings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  google_acl_id text,
  scope_type text not null check (scope_type in ('user', 'group', 'domain')),
  scope_value text not null,
  google_role text not null check (google_role in ('reader', 'writer', 'owner')),
  status text not null default 'pending' check (status in ('pending', 'active', 'removed', 'error')),
  created_at timestamptz not null default now(),
  unique (calendar_connection_id, scope_type, scope_value)
);

create table if not exists public.routing_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  policy_key text not null,
  version text not null,
  policy_json jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, policy_key, version)
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  title text not null,
  public_title text,
  session_type text not null,
  max_tier text not null check (max_tier in ('T0', 'T1', 'T2', 'T3')),
  status text not null default 'draft' check (status in ('draft', 'requested', 'scheduled', 'cancelled', 'completed')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/New_York',
  location text,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  policy_id uuid references public.routing_policies(id) on delete set null,
  calendar_connection_id uuid references public.calendar_connections(id) on delete set null,
  google_calendar_id text,
  google_event_id text,
  google_ical_uid text,
  google_etag text,
  google_html_link text,
  google_meet_url text,
  google_meeting_code text,
  google_meet_space text,
  guests_can_modify boolean not null default false,
  guests_can_invite_others boolean not null default false,
  guests_can_see_other_guests boolean not null default true,
  bot_requested boolean not null default false,
  bot_status text not null default 'not_requested' check (bot_status in ('not_requested', 'requested', 'invited', 'joined', 'failed', 'transcript_uploaded', 'processed')),
  transcript_status text not null default 'not_expected' check (transcript_status in ('not_expected', 'expected', 'artifact_detected', 'source_ready', 'distilling', 'distilled', 'failed')),
  distill_due_at timestamptz,
  first_source_artifact_at timestamptz,
  first_readout_at timestamptz,
  missed_distill_sla_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (calendar_connection_id, google_event_id)
);

create table if not exists public.session_attendees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  email text not null,
  person_record_id text,
  attendee_role text not null default 'guest' check (attendee_role in ('host', 'guest', 'bot')),
  invite_status text not null default 'pending' check (invite_status in ('pending', 'needs_action', 'accepted', 'declined', 'tentative', 'removed')),
  google_response_status text,
  created_at timestamptz not null default now(),
  unique (session_id, email)
);

create table if not exists public.event_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null default auth.uid(),
  session_id uuid references public.sessions(id) on delete set null,
  request_json jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.calendar_sync_state (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  google_sync_token text,
  watch_channel_id text,
  watch_resource_id text,
  watch_expiration timestamptz,
  last_full_sync_at timestamptz,
  last_incremental_sync_at timestamptz,
  sync_requested_at timestamptz,
  sync_status text not null default 'idle' check (sync_status in ('idle', 'requested', 'running', 'ok', 'error', 'expired')),
  last_sync_started_at timestamptz,
  last_sync_finished_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (calendar_connection_id)
);

create table if not exists public.ingestion_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  provider text not null check (provider in ('google_calendar', 'google_meet', 'otter', 'manual')),
  event_type text not null,
  resource_name text,
  event_json jsonb not null default '{}'::jsonb,
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'ignored', 'failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create index if not exists ingestion_events_provider_resource_idx
on public.ingestion_events (org_id, provider, event_type, resource_name);

create table if not exists public.capture_artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  provider text not null check (provider in ('google_meet', 'otter')),
  conference_record text,
  meet_space text,
  conversation_id text,
  artifact_kind text not null check (artifact_kind in ('transcript', 'smart_notes', 'summary', 'slides', 'recording', 'attendance')),
  provider_resource_name text,
  storage_ref text,
  drive_file_id text,
  drive_export_uri text,
  status text not null default 'detected' check (status in ('detected', 'fetching', 'fetched', 'expired', 'failed')),
  fetched_at timestamptz,
  raw_retention_deadline timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, provider, artifact_kind, provider_resource_name)
);

create table if not exists public.source_artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  capture_artifact_id uuid references public.capture_artifacts(id) on delete set null,
  source_kind text not null check (source_kind in ('manual_upload', 'meet_transcript', 'meet_smart_notes', 'otter_transcript', 'otter_summary', 'otter_slide', 'audio', 'video', 'drive_doc', 'github', 'router')),
  source_tier text not null default 'T0' check (source_tier in ('T0', 'T1', 'T2', 'T3')),
  storage_mode text not null check (storage_mode in ('local_only', 'encrypted_object', 'tee_direct', 'external_ref')),
  storage_ref text,
  source_hash text,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  raw_available_to_server boolean not null default false,
  created_at timestamptz not null default now()
);

do $$
begin
  alter table public.source_artifacts
    add constraint source_artifacts_capture_kind_unique
    unique (capture_artifact_id, source_kind);
exception
  when duplicate_object then null;
end $$;

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_artifact_id uuid not null references public.source_artifacts(id) on delete cascade,
  job_kind text not null default 'distill' check (job_kind in ('distill', 'artifact_fetch', 'review_prepare')),
  processor_mode text not null check (processor_mode in ('local', 'tee', 'ordinary_cloud')),
  processor_status text not null default 'queued' check (processor_status in ('queued', 'running', 'failed', 'complete')),
  tee_required boolean not null default false,
  attestation_ref text,
  due_at timestamptz,
  policy_version text,
  prompt_version text,
  model_provider text,
  model_name text,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.derived_artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  source_artifact_id uuid references public.source_artifacts(id) on delete set null,
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  artifact_kind text not null check (artifact_kind in ('readout', 'qa', 'claim_set', 'delta_report', 'public_candidate')),
  tier text not null check (tier in ('T1', 'T2', 'T3')),
  source_transform text not null check (source_transform in ('paraphrased_distillation', 'aggregate', 'excerpt', 'public_edit')),
  review_status text not null default 'generated' check (review_status in ('generated', 'needs_review', 'reviewed', 'blocked', 'published')),
  approval_state text not null default 'not_required' check (approval_state in ('not_required', 'pending', 'approved', 'blocked')),
  confidence numeric,
  content_json jsonb not null default '{}'::jsonb,
  content_md text,
  created_at timestamptz not null default now()
);

create table if not exists public.artifact_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  derived_artifact_id uuid not null references public.derived_artifacts(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('approve', 'block', 'request_changes')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.approval_gates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete cascade,
  derived_artifact_id uuid references public.derived_artifacts(id) on delete cascade,
  gate_key text not null,
  gate_status text not null default 'pending' check (gate_status in ('pending', 'approved', 'blocked', 'not_required')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (derived_artifact_id, gate_key)
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  object_type text not null,
  object_id uuid,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);

alter table public.orgs enable row level security;
alter table public.org_memberships enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.calendar_acl_bindings enable row level security;
alter table public.routing_policies enable row level security;
alter table public.sessions enable row level security;
alter table public.session_attendees enable row level security;
alter table public.event_requests enable row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.ingestion_events enable row level security;
alter table public.capture_artifacts enable row level security;
alter table public.source_artifacts enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.derived_artifacts enable row level security;
alter table public.artifact_reviews enable row level security;
alter table public.approval_gates enable row level security;
alter table public.audit_log enable row level security;

create policy "members read orgs"
on public.orgs for select
using (public.is_org_member(id));

create policy "members read memberships"
on public.org_memberships for select
using (public.is_org_member(org_id));

create policy "admins manage memberships"
on public.org_memberships for all
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create policy "members read calendar connections"
on public.calendar_connections for select
using (public.is_org_member(org_id));

create policy "admins manage calendar connections"
on public.calendar_connections for all
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create policy "members read calendar acl bindings"
on public.calendar_acl_bindings for select
using (public.is_org_member(org_id));

create policy "admins manage calendar acl bindings"
on public.calendar_acl_bindings for all
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create policy "members read active routing policies"
on public.routing_policies for select
using (public.is_org_member(org_id));

create policy "coordinators manage routing policies"
on public.routing_policies for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "coordinators read sessions"
on public.sessions for select
using (public.is_org_coordinator(org_id));

create policy "coordinators create sessions"
on public.sessions for insert
with check (public.is_org_coordinator(org_id));

create policy "coordinators manage sessions"
on public.sessions for update
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "members read attendees"
on public.session_attendees for select
using (public.is_org_coordinator(org_id));

create policy "coordinators manage attendees"
on public.session_attendees for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "members create event requests"
on public.event_requests for insert
with check (
  public.is_org_member(org_id)
  and requested_by = auth.uid()
  and status = 'pending'
);

create policy "members read own or coordinator event requests"
on public.event_requests for select
using (public.is_org_coordinator(org_id) or requested_by = auth.uid());

create policy "coordinators review event requests"
on public.event_requests for update
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "coordinators read calendar sync state"
on public.calendar_sync_state for select
using (public.is_org_coordinator(org_id));

create policy "admins manage calendar sync state"
on public.calendar_sync_state for all
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create policy "coordinators read ingestion events"
on public.ingestion_events for select
using (public.is_org_coordinator(org_id));

create policy "coordinators manage ingestion events"
on public.ingestion_events for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "coordinators read capture artifacts"
on public.capture_artifacts for select
using (public.is_org_coordinator(org_id));

create policy "coordinators manage capture artifacts"
on public.capture_artifacts for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "source artifact private read"
on public.source_artifacts for select
using (
  public.is_org_coordinator(org_id)
  or uploaded_by = auth.uid()
);

create policy "members create source artifacts"
on public.source_artifacts for insert
with check (
  public.is_org_member(org_id)
  and source_tier = 'T0'
  and storage_mode in ('local_only', 'external_ref')
  and raw_available_to_server = false
);

create policy "coordinators create source artifacts"
on public.source_artifacts for insert
with check (
  public.is_org_coordinator(org_id)
);

create policy "coordinators manage source artifacts"
on public.source_artifacts for update
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "coordinators read processing jobs"
on public.processing_jobs for select
using (public.is_org_coordinator(org_id));

create policy "coordinators manage processing jobs"
on public.processing_jobs for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "derived artifact tiered read"
on public.derived_artifacts for select
using (
  public.is_org_coordinator(org_id)
  or (
    review_status in ('reviewed', 'published')
    and tier = 'T2'
    and public.is_org_member(org_id)
  )
  or (
    review_status = 'published'
    and tier = 'T3'
    and approval_state = 'approved'
    and public.is_org_member(org_id)
  )
);

create policy "coordinators manage derived artifacts"
on public.derived_artifacts for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "coordinators read artifact reviews"
on public.artifact_reviews for select
using (public.is_org_coordinator(org_id));

create policy "coordinators create artifact reviews"
on public.artifact_reviews for insert
with check (public.is_org_coordinator(org_id));

create policy "coordinators read approval gates"
on public.approval_gates for select
using (public.is_org_coordinator(org_id));

create policy "coordinators manage approval gates"
on public.approval_gates for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create policy "coordinators read audit log"
on public.audit_log for select
using (public.is_org_coordinator(org_id));

create index if not exists sessions_org_start_idx on public.sessions (org_id, starts_at);
create index if not exists sessions_google_event_idx on public.sessions (google_calendar_id, google_event_id);
create index if not exists session_attendees_session_idx on public.session_attendees (session_id);
create index if not exists ingestion_events_session_idx on public.ingestion_events (session_id, received_at);
create index if not exists capture_artifacts_session_idx on public.capture_artifacts (session_id);
create index if not exists source_artifacts_session_idx on public.source_artifacts (session_id);
create index if not exists processing_jobs_status_due_idx on public.processing_jobs (processor_status, due_at);
create unique index if not exists processing_jobs_source_kind_prompt_idx on public.processing_jobs (source_artifact_id, job_kind, prompt_version);
create index if not exists derived_artifacts_session_idx on public.derived_artifacts (session_id, review_status);
create index if not exists approval_gates_artifact_idx on public.approval_gates (derived_artifact_id, gate_status);

-- Shape OS Google auth gate and receive-route hardening.
--
-- Shape OS may share one Supabase project with other clients. The project Site
-- URL can stay web-owned, but Shape OS auth must be routed by the explicit app
-- deep-link allow-list plus these app-owned membership predicates.

create table if not exists public.app_members (
  email text primary key,
  record_id text,
  record_type text not null default 'person',
  role text not null default 'member',
  status text not null default 'pending',
  display_name text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_members_email_normalized check (
    email = lower(btrim(email)) and position('@' in email) > 1
  ),
  constraint app_members_record_type_nonempty check (length(btrim(record_type)) > 0),
  constraint app_members_role_check check (role in ('member', 'admin')),
  constraint app_members_status_check check (status in ('pending', 'approved', 'rejected'))
);

create table if not exists public.app_access_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  requested_record_id text,
  message text,
  status text not null default 'pending',
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_access_requests_email_normalized check (
    email = lower(btrim(email)) and position('@' in email) > 1
  ),
  constraint app_access_requests_status_check check (status in ('pending', 'approved', 'rejected'))
);

create index if not exists app_access_requests_email_created_idx
  on public.app_access_requests (email, created_at desc);

alter table public.app_members enable row level security;
alter table public.app_access_requests enable row level security;

drop policy if exists "app members read own row" on public.app_members;
create policy "app members read own row"
  on public.app_members
  for select
  to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

drop policy if exists "app access requests insert own email" on public.app_access_requests;
create policy "app access requests insert own email"
  on public.app_access_requests
  for insert
  to authenticated
  with check (email = lower(auth.jwt() ->> 'email'));

drop policy if exists "app access requests read own email" on public.app_access_requests;
create policy "app access requests read own email"
  on public.app_access_requests
  for select
  to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

create or replace view public.app_my_membership
with (security_barrier = true) as
select
  member.email,
  member.record_id,
  member.record_type,
  member.role,
  member.status,
  member.display_name,
  member.approved_at
from public.app_members member
where member.email = lower(auth.jwt() ->> 'email');

create or replace view public.cohort_app_transcript_evidence_cards
with (security_barrier = true) as
select
  card.id,
  card.claim_type,
  card.title,
  card.claim_text,
  card.summary,
  card.evidence_level,
  card.confidence,
  card.attribution_scope,
  card.surface_tier,
  card.content_json,
  card.created_at,
  card.reviewed_at
from public.evidence_cards card
where card.surface_tier = 'T2'
  and card.review_status in ('reviewed', 'published')
  and (
    auth.role() in ('cohort_app', 'service_role')
    or exists (
      select 1
      from public.app_members member
      where member.email = lower(auth.jwt() ->> 'email')
        and member.status = 'approved'
        and member.record_id is not null
    )
  );

create or replace view public.cohort_app_transcript_distillations
with (security_barrier = true) as
select
  artifact.id,
  artifact.artifact_kind,
  artifact.tier as surface_tier,
  artifact.confidence,
  artifact.content_json,
  artifact.content_md,
  artifact.created_at
from public.derived_artifacts artifact
where artifact.tier = 'T2'
  and artifact.review_status in ('reviewed', 'published')
  and artifact.source_transform in ('paraphrased_distillation', 'aggregate', 'public_edit')
  and artifact.artifact_kind = 'readout'
  and artifact.content_md is not null
  and length(btrim(artifact.content_md)) > 0
  and (
    auth.role() in ('cohort_app', 'service_role')
    or exists (
      select 1
      from public.app_members member
      where member.email = lower(auth.jwt() ->> 'email')
        and member.status = 'approved'
        and member.record_id is not null
    )
  );

create or replace view public.cohort_app_cohort_insight_cards
with (security_barrier = true) as
select
  card.id,
  card.kind,
  card.subject_type,
  card.subject_ids,
  card.title,
  card.claim_text,
  card.summary,
  card.evidence_level,
  card.confidence,
  card.surface_tier,
  card.source_refs,
  card.content_json,
  card.generated_at,
  card.created_at,
  card.reviewed_at
from public.cohort_insight_cards card
where card.raw_allowed = false
  and card.surface_tier = 'cohort'
  and card.review_status in ('reviewed', 'published')
  and (
    auth.role() in ('cohort_app', 'service_role')
    or exists (
      select 1
      from public.app_members member
      where member.email = lower(auth.jwt() ->> 'email')
        and member.status = 'approved'
        and member.record_id is not null
    )
  );

revoke all privileges on public.app_members from anon, authenticated;
revoke all privileges on public.app_access_requests from anon, authenticated;
grant select on public.app_members to authenticated;
grant select, insert on public.app_access_requests to authenticated;
grant all privileges on public.app_members to service_role;
grant all privileges on public.app_access_requests to service_role;

revoke all privileges on public.app_my_membership from anon, authenticated, service_role;
revoke all privileges on public.cohort_app_transcript_evidence_cards from anon, authenticated, service_role;
revoke all privileges on public.cohort_app_transcript_distillations from anon, authenticated, service_role;
revoke all privileges on public.cohort_app_cohort_insight_cards from anon, authenticated, service_role;

grant select on public.app_my_membership to authenticated, service_role;
grant select on public.cohort_app_transcript_evidence_cards to authenticated, service_role;
grant select on public.cohort_app_transcript_distillations to authenticated, service_role;
grant select on public.cohort_app_cohort_insight_cards to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cohort_app') then
    revoke all privileges on public.cohort_app_transcript_evidence_cards from cohort_app;
    revoke all privileges on public.cohort_app_transcript_distillations from cohort_app;
    revoke all privileges on public.cohort_app_cohort_insight_cards from cohort_app;

    grant select on public.cohort_app_transcript_evidence_cards to cohort_app;
    grant select on public.cohort_app_transcript_distillations to cohort_app;
    grant select on public.cohort_app_cohort_insight_cards to cohort_app;
  end if;
end
$$;

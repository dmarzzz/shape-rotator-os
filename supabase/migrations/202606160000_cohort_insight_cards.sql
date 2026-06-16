-- Cohort insight cards are engine-generated, app-safe read models for cohort
-- views such as say/did/shipped, latent overlap, and reviewed rotation.
-- They are intentionally separate from transcript evidence cards: transcript
-- evidence remains gated by source/derived artifact provenance, while these
-- rows may be generated from public cohort records and public GitHub metadata.

create extension if not exists pgcrypto;

create table if not exists public.cohort_insight_cards (
  org_id uuid not null references public.orgs(id) on delete cascade,
  id text not null,
  kind text not null
    check (kind in ('say_did_shipped', 'latent_overlap', 'rotation', 'progress_drift')),
  subject_type text not null
    check (subject_type in ('team', 'team_pair', 'person', 'cluster', 'cohort')),
  subject_ids text[] not null default '{}'::text[],
  title text not null,
  claim_text text not null,
  summary text,
  evidence_level text not null
    check (evidence_level in ('declared_only', 'observed_public_metadata', 'inferred_public_metadata', 'app_safe_distillation', 'reviewed_model_judgment')),
  confidence text not null default 'low'
    check (confidence in ('low', 'low-medium', 'medium', 'high')),
  surface_tier text not null default 'cohort'
    check (surface_tier in ('operator', 'cohort', 'public')),
  source_boundary text not null default 'public_bundle'
    check (source_boundary in ('public_bundle', 'app_safe_supabase', 'private_vault', 'derived_model_judgment')),
  review_status text not null default 'generated'
    check (review_status in ('generated', 'needs_review', 'reviewed', 'blocked', 'published')),
  approval_state text not null default 'not_reviewed'
    check (approval_state in ('not_reviewed', 'not_required', 'pending', 'approved', 'blocked')),
  raw_allowed boolean not null default false,
  source_refs jsonb not null default '[]'::jsonb,
  content_json jsonb not null default '{}'::jsonb,
  generated_by text not null default 'unknown',
  generated_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  check (cardinality(subject_ids) > 0),
  check (jsonb_typeof(source_refs) = 'array'),
  check (jsonb_typeof(content_json) = 'object'),
  check (raw_allowed = false),
  check (not (content_json ? 'source_artifact_id')),
  check (not (content_json ? 'processing_job_id')),
  check (not (content_json ? 'derived_artifact_id')),
  check (not (content_json ? 'storage_ref')),
  check (not (content_json ? 'drive_file_id')),
  check (surface_tier <> 'public' or approval_state = 'approved'),
  check (surface_tier <> 'public' or review_status = 'published'),
  check (surface_tier <> 'public' or source_boundary = 'public_bundle')
);

create index if not exists cohort_insight_cards_org_kind_idx
on public.cohort_insight_cards (org_id, kind, review_status, surface_tier, updated_at desc);

create index if not exists cohort_insight_cards_subject_ids_idx
on public.cohort_insight_cards using gin (subject_ids);

alter table public.cohort_insight_cards enable row level security;

drop policy if exists "coordinators read cohort insight cards" on public.cohort_insight_cards;
create policy "coordinators read cohort insight cards"
on public.cohort_insight_cards for select
using (public.is_org_coordinator(org_id));

drop policy if exists "coordinators manage cohort insight cards" on public.cohort_insight_cards;
create policy "coordinators manage cohort insight cards"
on public.cohort_insight_cards for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create or replace function public.enforce_cohort_insight_card_boundary()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if new.raw_allowed is true then
    raise exception 'cohort insight cards may not expose raw source text';
  end if;

  if new.source_refs is null or jsonb_typeof(new.source_refs) <> 'array' then
    raise exception 'cohort insight source_refs must be a JSON array';
  end if;

  if new.content_json is null or jsonb_typeof(new.content_json) <> 'object' then
    raise exception 'cohort insight content_json must be a JSON object';
  end if;

  if new.surface_tier = 'public' then
    if new.review_status <> 'published' or new.approval_state <> 'approved' then
      raise exception 'public cohort insight cards require published/approved state';
    end if;

    if new.source_boundary <> 'public_bundle' then
      raise exception 'public cohort insight cards require public_bundle source boundary';
    end if;
  end if;

  if private.transcript_public_text_has_private_markers(
    coalesce(new.title, '') || ' ' ||
    coalesce(new.claim_text, '') || ' ' ||
    coalesce(new.summary, '') || ' ' ||
    coalesce(new.source_refs::text, '') || ' ' ||
    coalesce(new.content_json::text, '')
  ) then
    raise exception 'cohort insight card contains private-source or direct-contact markers';
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists enforce_cohort_insight_card_boundary on public.cohort_insight_cards;
create trigger enforce_cohort_insight_card_boundary
before insert or update of kind, subject_type, subject_ids, title, claim_text, summary, evidence_level, confidence, surface_tier, source_boundary, review_status, approval_state, raw_allowed, source_refs, content_json
on public.cohort_insight_cards
for each row
execute function public.enforce_cohort_insight_card_boundary();

revoke all on function public.enforce_cohort_insight_card_boundary() from public, anon, authenticated;

drop view if exists public.public_cohort_insight_cards;
drop view if exists public.app_cohort_insight_cards;

create view public.app_cohort_insight_cards
with (security_barrier = true)
as
select
  id,
  org_id,
  kind,
  subject_type,
  subject_ids,
  title,
  claim_text,
  summary,
  evidence_level,
  confidence,
  surface_tier,
  source_boundary,
  review_status,
  approval_state,
  source_refs,
  content_json,
  generated_by,
  generated_at,
  created_at,
  updated_at,
  reviewed_at
from public.cohort_insight_cards card
where public.is_org_member(card.org_id)
  and raw_allowed = false
  and surface_tier = 'cohort'
  and review_status in ('generated', 'reviewed', 'published');

create view public.public_cohort_insight_cards
with (security_barrier = true)
as
select
  id,
  kind,
  subject_type,
  title,
  claim_text,
  summary,
  evidence_level,
  confidence,
  source_boundary,
  content_json,
  generated_at,
  created_at,
  updated_at
from public.cohort_insight_cards card
where raw_allowed = false
  and surface_tier = 'public'
  and review_status = 'published'
  and approval_state = 'approved'
  and source_boundary = 'public_bundle'
  and not private.transcript_public_text_has_private_markers(
    coalesce(title, '') || ' ' ||
    coalesce(claim_text, '') || ' ' ||
    coalesce(summary, '') || ' ' ||
    coalesce(content_json::text, '')
  );

revoke all on public.cohort_insight_cards from anon;
grant select, insert, update, delete on public.cohort_insight_cards to authenticated;
grant all privileges on public.cohort_insight_cards to service_role;

revoke all on public.app_cohort_insight_cards from public, anon, authenticated;
grant select on public.app_cohort_insight_cards to authenticated, service_role;

revoke all on public.public_cohort_insight_cards from public, anon, authenticated;
grant select on public.public_cohort_insight_cards to anon, authenticated, service_role;

comment on table public.cohort_insight_cards is
  'Engine-generated cohort insight cards. Base table is coordinator-managed; app/public access goes through app_cohort_insight_cards and public_cohort_insight_cards.';

comment on view public.app_cohort_insight_cards is
  'Authenticated cohort-facing read model for generated/reviewed cohort insight cards. Does not expose raw source text.';

comment on view public.public_cohort_insight_cards is
  'Anonymous public cohort insight slice. Only published, approved, public_bundle cards are exposed, without org_id or source_refs.';

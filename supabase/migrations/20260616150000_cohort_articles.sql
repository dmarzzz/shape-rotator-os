-- Cohort article read models. These are app/public markdown-style articles
-- hydrated by apps/os/src/renderer/supabase-articles.mjs.

create table if not exists public.cohort_articles (
  org_id uuid not null references public.orgs(id) on delete cascade,
  id text not null,
  slug text not null,
  title text not null,
  dek text,
  body_markdown text not null,
  tags text[] not null default '{}'::text[],
  article_kind text not null default 'article',
  article_mode text not null default 'manual',
  surface_tier text not null default 'cohort'
    check (surface_tier in ('operator', 'cohort', 'public')),
  source_boundary text not null default 'public_bundle'
    check (source_boundary in ('public_bundle', 'app_safe_supabase', 'private_vault', 'derived_model_judgment')),
  review_status text not null default 'generated'
    check (review_status in ('generated', 'needs_review', 'reviewed', 'blocked', 'published')),
  approval_state text not null default 'not_reviewed'
    check (approval_state in ('not_reviewed', 'not_required', 'pending', 'approved', 'blocked')),
  source_refs jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  generated_by text not null default 'unknown',
  generated_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, slug),
  check (jsonb_typeof(source_refs) = 'array'),
  check (jsonb_typeof(metadata) = 'object'),
  check (surface_tier <> 'public' or review_status = 'published'),
  check (surface_tier <> 'public' or approval_state = 'approved'),
  check (surface_tier <> 'public' or source_boundary = 'public_bundle')
);

create index if not exists cohort_articles_org_surface_idx
on public.cohort_articles (org_id, surface_tier, review_status, updated_at desc);

alter table public.cohort_articles enable row level security;

drop policy if exists "coordinators read cohort articles" on public.cohort_articles;
create policy "coordinators read cohort articles"
on public.cohort_articles for select
using (public.is_org_coordinator(org_id));

drop policy if exists "coordinators manage cohort articles" on public.cohort_articles;
create policy "coordinators manage cohort articles"
on public.cohort_articles for all
using (public.is_org_coordinator(org_id))
with check (public.is_org_coordinator(org_id));

create or replace function public.enforce_cohort_article_boundary()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if new.source_refs is null or jsonb_typeof(new.source_refs) <> 'array' then
    raise exception 'cohort article source_refs must be a JSON array';
  end if;

  if new.metadata is null or jsonb_typeof(new.metadata) <> 'object' then
    raise exception 'cohort article metadata must be a JSON object';
  end if;

  if new.surface_tier = 'public' then
    if new.review_status <> 'published' or new.approval_state <> 'approved' then
      raise exception 'public cohort articles require published/approved state';
    end if;

    if new.source_boundary <> 'public_bundle' then
      raise exception 'public cohort articles require public_bundle source boundary';
    end if;
  end if;

  if private.transcript_public_text_has_private_markers(
    coalesce(new.title, '') || ' ' ||
    coalesce(new.dek, '') || ' ' ||
    coalesce(new.body_markdown, '') || ' ' ||
    coalesce(new.source_refs::text, '') || ' ' ||
    coalesce(new.metadata::text, '')
  ) then
    raise exception 'cohort article contains private-source or direct-contact markers';
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists enforce_cohort_article_boundary on public.cohort_articles;
create trigger enforce_cohort_article_boundary
before insert or update of slug, title, dek, body_markdown, tags, article_kind, article_mode, surface_tier, source_boundary, review_status, approval_state, source_refs, metadata
on public.cohort_articles
for each row
execute function public.enforce_cohort_article_boundary();

revoke all on function public.enforce_cohort_article_boundary() from public, anon, authenticated;

drop view if exists public.public_cohort_articles;
drop view if exists public.app_cohort_articles;

create view public.app_cohort_articles
with (security_barrier = true)
as
select
  id,
  org_id,
  slug,
  title,
  dek,
  body_markdown,
  tags,
  article_kind,
  article_mode,
  surface_tier,
  source_boundary,
  review_status,
  approval_state,
  source_refs,
  metadata,
  generated_by,
  generated_at,
  created_at,
  updated_at,
  reviewed_at
from public.cohort_articles article
where public.is_org_member(article.org_id)
  and surface_tier in ('cohort', 'public')
  and review_status in ('generated', 'needs_review', 'reviewed', 'published');

create view public.public_cohort_articles
with (security_barrier = true)
as
select
  id,
  slug,
  title,
  dek,
  body_markdown,
  tags,
  article_kind,
  article_mode,
  source_boundary,
  generated_at,
  created_at,
  updated_at
from public.cohort_articles
where surface_tier = 'public'
  and review_status = 'published'
  and approval_state = 'approved'
  and source_boundary = 'public_bundle'
  and not private.transcript_public_text_has_private_markers(
    coalesce(title, '') || ' ' ||
    coalesce(dek, '') || ' ' ||
    coalesce(body_markdown, '')
  );

revoke all on public.cohort_articles from anon;
grant select, insert, update, delete on public.cohort_articles to authenticated;
grant all privileges on public.cohort_articles to service_role;

revoke all on public.app_cohort_articles from public, anon, authenticated;
grant select on public.app_cohort_articles to authenticated, service_role;

revoke all on public.public_cohort_articles from public, anon, authenticated;
grant select on public.public_cohort_articles to anon, authenticated, service_role;

comment on table public.cohort_articles is
  'Reviewed cohort/article read models hydrated by the OS context renderer.';

comment on view public.app_cohort_articles is
  'Authenticated cohort-facing article view with review metadata and safe source refs.';

comment on view public.public_cohort_articles is
  'Anonymous public article view. Only published, approved public_bundle articles are exposed without org_id, source_refs, metadata, or reviewer fields.';

-- Follow-up for projects that already applied 20260616150000_cohort_articles.sql
-- before article tags were included in the public boundary checks.

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
    coalesce(new.tags::text, '') || ' ' ||
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

create or replace view public.public_cohort_articles
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
    coalesce(tags::text, '') || ' ' ||
    coalesce(body_markdown, '')
  );

revoke all on public.public_cohort_articles from public, anon, authenticated;
grant select on public.public_cohort_articles to anon, authenticated, service_role;

comment on view public.public_cohort_articles is
  'Anonymous public article view. Only published, approved public_bundle articles are exposed without org_id, source_refs, metadata, or reviewer fields. Tags are included in public marker checks.';

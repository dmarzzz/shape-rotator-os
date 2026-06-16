-- Public transcript evidence cards are the anonymous, no-named public slice of
-- evidence_cards. Authenticated app/member routing should use
-- app_transcript_evidence_cards; this view is safe for anon web hydration.

drop view if exists public.public_transcript_evidence_cards;

create view public.public_transcript_evidence_cards
with (security_barrier = true)
as
select
  id,
  claim_type,
  title,
  claim_text,
  summary,
  evidence_level,
  confidence,
  'anonymous_public'::text as attribution_scope,
  jsonb_strip_nulls(
    jsonb_build_object(
      'claim_type', coalesce(content_json->>'claim_type', claim_type),
      'date', content_json->>'date',
      'named_entities_allowed', false,
      'raw_allowed', false,
      'source_note', content_json->>'source_note',
      'themes', coalesce(content_json->'themes', '[]'::jsonb),
      'week_start', content_json->>'week_start'
    )
  ) as content_json,
  created_at
from public.evidence_cards
where surface_tier = 'T3'
  and review_status = 'published'
  and approval_state = 'approved'
  and public_anonymous = true
  and public_article_mode = 'generalized_no_named_insights'
  and not private.transcript_public_text_has_private_markers(
    coalesce(title, '') || ' ' ||
    coalesce(claim_text, '') || ' ' ||
    coalesce(summary, '') || ' ' ||
    coalesce(content_json::text, '')
  );

revoke all on public.public_transcript_evidence_cards from public, anon, authenticated;
grant select on public.public_transcript_evidence_cards to anon, authenticated, service_role;

comment on view public.public_transcript_evidence_cards is
  'Anonymous public transcript evidence cards. Does not expose org, session, source artifact, processing job, team, person, or storage provenance.';

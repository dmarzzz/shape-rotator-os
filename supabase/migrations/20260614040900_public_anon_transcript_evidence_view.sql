-- Public, anon-readable projection of T3 transcript evidence cards.
--
-- Privacy posture (decided 2026-06-14): the app surfaces transcript evidence
-- LIVE from Supabase, but only the person-anonymized, team-attributed T3 layer
-- is public. Named per-person "who said what" stays gated behind
-- app_transcript_evidence_cards (authenticated org members only) and is a
-- member-auth roadmap item.
--
-- This view exposes ONLY the public-safe columns (no org_id, session_id,
-- reviewed_by/at) and ONLY rows that already cleared every T3 gate:
--   surface_tier = 'T3'
--   review_status = 'published'
--   approval_state = 'approved'
--   public_anonymous = true
--   public_article_mode = 'generalized_no_named_insights'
-- The enforce_t3_evidence_card_boundary trigger guarantees any such row is free
-- of private-source / direct-contact markers before it can reach this state, so
-- anon SELECT here cannot leak raw transcripts, emails, Drive/vault URIs, or
-- provenance ids.
--
-- security_barrier = true keeps the WHERE predicate from being bypassed by a
-- pushed-down user predicate. Idempotent (drop-if-exists + create); documents
-- in-repo what was applied live on 2026-06-14
-- (schema_migrations version 20260614040900).

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
  attribution_scope,
  content_json,
  created_at
from public.evidence_cards
where surface_tier = 'T3'
  and review_status = 'published'
  and approval_state = 'approved'
  and public_anonymous = true
  and public_article_mode = 'generalized_no_named_insights';

revoke all on public.public_transcript_evidence_cards from public;
grant select on public.public_transcript_evidence_cards to anon, authenticated, service_role;

-- Allow `collaboration_edge` cohort insight cards. A collaboration edge is an
-- OBSERVED public-GitHub fact: a cohort member's commits landing on a repo linked
-- to a different team than their own. The deterministic public bundle emits these
-- at surface_tier `cohort` with source_boundary `public_bundle`, evidence_level
-- `observed_public_metadata`, and source_refs pointing only at public team records
-- and public github-progress artifacts -- never a private source artifact.
--
-- Before this migration the kind whitelist rejected the kind outright, so
-- publish-cohort-insights-supabase.mjs could not upsert a manifest once the
-- github-progress scanner produced cross-team contribution data. The existing
-- table CHECKs (public requires published/approved/public_bundle; no private
-- provenance keys in content_json; raw_allowed = false) already bound exposure,
-- so this migration only widens the kind whitelist; no new exposure.

alter table public.cohort_insight_cards
  drop constraint if exists cohort_insight_cards_kind_check;

alter table public.cohort_insight_cards
  add constraint cohort_insight_cards_kind_check
  check (kind in ('project_identity', 'say_did_shipped', 'latent_overlap', 'collaboration_edge', 'rotation', 'progress_drift', 'award'));

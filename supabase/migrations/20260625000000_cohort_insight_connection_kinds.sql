-- Allow the LLM-computation SNAPSHOT to ride on the existing cohort_insight_cards
-- stream instead of a parallel table. Three new kinds carry the precomputed
-- legibility layer a daily local-AI routine produces (scripts/build-cohort-
-- connections.mjs):
--   connection_edge  (subject_type 'team_pair') — "who should talk to whom" + why
--   card_attribution (subject_type 'team')      — the FROZEN card→team mapping
--                                                  attributeInsightCards() inferred,
--                                                  so the renderer reads it instead
--                                                  of recomputing every refresh
--   cluster_summary  (subject_type 'cluster')   — short per-cluster summary
--
-- These are produced at surface_tier 'cohort', source_boundary 'public_bundle',
-- evidence_level 'inferred_public_metadata', raw_allowed false, with source_refs
-- pointing only at PUBLIC team records + the public cohort-insights manifest.
-- The existing table CHECKs (raw_allowed=false; no source_artifact_id/
-- processing_job_id/derived_artifact_id/storage_ref/drive_file_id in content_json;
-- surface_tier='public' requires public_bundle) and the
-- enforce_cohort_insight_card_boundary trigger already bound exposure, so this
-- migration only WIDENS the kind whitelist — no new exposure. Mirrors
-- 20260620000000_cohort_insight_collaboration_edge_kind.sql.

alter table public.cohort_insight_cards
  drop constraint if exists cohort_insight_cards_kind_check;

alter table public.cohort_insight_cards
  add constraint cohort_insight_cards_kind_check
  check (kind in (
    'project_identity', 'say_did_shipped', 'latent_overlap', 'collaboration_edge',
    'rotation', 'progress_drift', 'award',
    'connection_edge', 'card_attribution', 'cluster_summary'
  ));

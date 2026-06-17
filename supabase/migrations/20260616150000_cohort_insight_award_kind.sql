-- Allow `award` cohort insight cards. An award is a reviewed model judgment
-- (the same species as the gated `rotation` kind): the real verdict is produced
-- by the PRIVATE transcript engine and written here as a needs_review card with
-- source_boundary `derived_model_judgment`, then approved by a coordinator.
--
-- The deterministic PUBLIC bundle only emits award SCAFFOLD cards — public-signal
-- nominations and empty editorial slots — at surface_tier `cohort`. The existing
-- table CHECKs already guarantee an award can never reach the public slice unless
-- it is published, approved, and public_bundle, so this migration only widens the
-- kind whitelist; no new exposure.

alter table public.cohort_insight_cards
  drop constraint if exists cohort_insight_cards_kind_check;

alter table public.cohort_insight_cards
  add constraint cohort_insight_cards_kind_check
  check (kind in ('project_identity', 'say_did_shipped', 'latent_overlap', 'rotation', 'progress_drift', 'award'));

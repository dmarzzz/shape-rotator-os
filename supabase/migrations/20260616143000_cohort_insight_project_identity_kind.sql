-- Allow deterministic project identity cards generated from public cohort
-- metadata. These feed cohort views with "what this project is / does"
-- without adding any raw transcript or private-source surface.

alter table public.cohort_insight_cards
  drop constraint if exists cohort_insight_cards_kind_check;

alter table public.cohort_insight_cards
  add constraint cohort_insight_cards_kind_check
  check (kind in ('project_identity', 'say_did_shipped', 'latent_overlap', 'rotation', 'progress_drift'));

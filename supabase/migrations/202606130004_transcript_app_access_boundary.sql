-- Tighten the app-facing transcript boundary.
--
-- Browser/app members should consume reviewed distillations, not source rows,
-- processing rows, or internal derived-artifact provenance columns. Coordinators
-- keep direct table access for operations through the existing RLS role checks.

drop policy if exists "source artifact private read" on public.source_artifacts;

create policy "coordinators read source artifacts"
on public.source_artifacts for select
using (public.is_org_coordinator(org_id));

drop policy if exists "derived artifact tiered read" on public.derived_artifacts;

create policy "coordinators read derived artifacts"
on public.derived_artifacts for select
using (public.is_org_coordinator(org_id));

drop view if exists public.app_transcript_distillations;

create view public.app_transcript_distillations
with (security_barrier = true)
as
select
  id,
  org_id,
  session_id,
  artifact_kind,
  tier,
  source_transform,
  review_status,
  approval_state,
  confidence,
  content_json,
  content_md,
  created_at
from public.derived_artifacts
where public.is_org_member(org_id)
  and (
    (
      tier = 'T2'
      and review_status in ('reviewed', 'published')
    )
    or (
      tier = 'T3'
      and review_status = 'published'
      and approval_state = 'approved'
    )
  )
  and source_transform in ('paraphrased_distillation', 'aggregate', 'public_edit')
  and artifact_kind in ('readout', 'qa', 'claim_set', 'delta_report', 'public_candidate');

revoke all on public.app_transcript_distillations from public, anon, authenticated;
grant select on public.app_transcript_distillations to authenticated, service_role;

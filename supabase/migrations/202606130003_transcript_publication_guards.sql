-- Harden transcript processing and public publication boundaries.
--
-- 1. Claim transcript worker jobs atomically so overlapping cron/function
--    invocations cannot process the same source artifact concurrently.
-- 2. Enforce T3 approval gates in the database, not only in client/operator code.

create or replace function public.claim_transcript_processing_jobs(
  p_org_id uuid,
  p_limit integer default 5
)
returns setof public.processing_jobs
language sql
security definer
set search_path = public
as $$
  with next_jobs as (
    select id
    from public.processing_jobs
    where org_id = p_org_id
      and job_kind = 'artifact_fetch'
      and processor_status = 'queued'
    order by due_at asc nulls last, created_at asc
    limit greatest(1, least(25, coalesce(p_limit, 5)))
    for update skip locked
  )
  update public.processing_jobs as job
     set processor_status = 'running',
         started_at = now(),
         error = null
    from next_jobs
   where job.id = next_jobs.id
  returning job.*;
$$;

revoke all on function public.claim_transcript_processing_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_transcript_processing_jobs(uuid, integer) to service_role;

create or replace function public.enforce_t3_publication_gates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tier = 'T3'
    and (
      new.review_status = 'published'
      or new.approval_state = 'approved'
    ) then
    if new.artifact_kind <> 'public_candidate' then
      raise exception 'T3 approval/publication requires a public_candidate artifact';
    end if;

    if new.approval_state <> 'approved' then
      raise exception 'T3 publication requires approval_state=approved';
    end if;

    if not exists (
      select 1
      from public.approval_gates gate
      where gate.derived_artifact_id = new.id
        and gate.org_id = new.org_id
    ) then
      raise exception 'T3 approval/publication requires approval gates';
    end if;

    if exists (
      select 1
      from public.approval_gates gate
      where gate.derived_artifact_id = new.id
        and gate.org_id = new.org_id
        and gate.gate_status not in ('approved', 'not_required')
    ) then
      raise exception 'T3 approval/publication requires all gates approved or not_required';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_t3_publication_gates on public.derived_artifacts;
create trigger enforce_t3_publication_gates
before insert or update of review_status, approval_state, tier, artifact_kind
on public.derived_artifacts
for each row
execute function public.enforce_t3_publication_gates();

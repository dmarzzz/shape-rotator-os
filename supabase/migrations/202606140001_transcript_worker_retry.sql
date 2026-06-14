-- Retry/backoff + stale-lease recovery for the transcript worker.
--
-- C5-4: a transient failure (Drive 5xx, OAuth refresh blip, a single write error)
--       used to mark the job processor_status='failed' permanently, silently
--       dropping work that runs unattended on a 30-minute cron. Track attempts
--       and let the worker requeue with backoff until max_attempts, then fail.
-- C5-3: a worker that crashed/timed out after claiming a job left it 'running'
--       forever, because the claim RPC only ever picked 'queued' jobs. The claim
--       now also re-picks STALE 'running' jobs (started_at older than the lease
--       window), so a dead worker's jobs are recovered on the next tick.
--
-- Additive + idempotent: safe to apply on top of the already-deployed schema.

alter table public.processing_jobs
  add column if not exists attempts integer not null default 0;
alter table public.processing_jobs
  add column if not exists max_attempts integer not null default 5;

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
      and attempts < max_attempts
      and (
        -- queued and due (backoff sets a future due_at on requeue)
        (processor_status = 'queued' and (due_at is null or due_at <= now()))
        -- or 'running' past the lease window: the worker that claimed it is
        -- presumed dead, so reclaim it (this counts as another attempt).
        or (
          processor_status = 'running'
          and started_at is not null
          and started_at < now() - interval '15 minutes'
        )
      )
    order by due_at asc nulls last, created_at asc
    limit greatest(1, least(25, coalesce(p_limit, 5)))
    for update skip locked
  )
  update public.processing_jobs as job
     set processor_status = 'running',
         started_at = now(),
         attempts = job.attempts + 1,
         error = null
    from next_jobs
   where job.id = next_jobs.id
  returning job.*;
$$;

revoke all on function public.claim_transcript_processing_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_transcript_processing_jobs(uuid, integer) to service_role;

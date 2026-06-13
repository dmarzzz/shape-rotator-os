-- Reschedule transcript queue processing to the hour and half hour.
--
-- This replaces the initial every-5-minutes cron job while keeping the same
-- Vault-backed invocation function and worker token boundary.

create or replace function private.ensure_process_transcript_jobs_schedule()
returns void
language plpgsql
security definer
set search_path = private, extensions, public
as $worker_schedule$
begin
  if coalesce(private.transcript_worker_secret('shape_transcript_worker_project_url'), '') = ''
    or coalesce(private.transcript_worker_secret('shape_transcript_worker_token'), '') = ''
    or coalesce(private.transcript_worker_secret('shape_transcript_worker_org_id'), '') = '' then
    raise notice 'transcript worker Vault secrets are missing; cron schedule not enabled yet';
    return;
  end if;

  begin
    perform cron.unschedule('process-transcript-jobs-every-5-minutes');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('process-transcript-jobs-every-30-minutes');
  exception
    when others then
      null;
  end;

  perform cron.schedule(
    'process-transcript-jobs-every-30-minutes',
    '0,30 * * * *',
    $$ select private.invoke_process_transcript_jobs(); $$
  );
  raise notice 'transcript worker cron schedule enabled: process-transcript-jobs-every-30-minutes';
end;
$worker_schedule$;

revoke all on function private.ensure_process_transcript_jobs_schedule() from public, anon, authenticated;

select private.ensure_process_transcript_jobs_schedule();

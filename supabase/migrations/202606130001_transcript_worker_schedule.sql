-- Schedule transcript queue processing without a local PC.
--
-- Required Vault secrets before the cron job can succeed:
-- - shape_transcript_worker_project_url: https://<project-ref>.supabase.co
-- - shape_transcript_worker_token: same value as the Edge Function TRANSCRIPT_WORKER_TOKEN
-- - shape_transcript_worker_org_id: org id to process
-- Optional:
-- - shape_transcript_worker_limit: queued jobs per tick, defaults to 5

create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

create schema if not exists private;

create or replace function private.transcript_worker_secret(secret_name text)
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = secret_name
  order by created_at desc
  limit 1
$$;

revoke all on function private.transcript_worker_secret(text) from public, anon, authenticated;

create or replace function private.invoke_process_transcript_jobs()
returns bigint
language plpgsql
security definer
set search_path = private, extensions, public
as $$
declare
  project_url text := private.transcript_worker_secret('shape_transcript_worker_project_url');
  worker_token text := private.transcript_worker_secret('shape_transcript_worker_token');
  org_id text := private.transcript_worker_secret('shape_transcript_worker_org_id');
  job_limit integer := coalesce(nullif(private.transcript_worker_secret('shape_transcript_worker_limit'), '')::integer, 5);
begin
  if project_url is null or project_url = '' then
    raise exception 'missing Vault secret: shape_transcript_worker_project_url';
  end if;
  if worker_token is null or worker_token = '' then
    raise exception 'missing Vault secret: shape_transcript_worker_token';
  end if;
  if org_id is null or org_id = '' then
    raise exception 'missing Vault secret: shape_transcript_worker_org_id';
  end if;

  return net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/process-transcript-jobs',
    body := jsonb_build_object(
      'org_id', org_id,
      'limit', greatest(1, least(25, job_limit)),
      'apply', true
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || worker_token
    ),
    timeout_milliseconds := 25000
  );
end;
$$;

revoke all on function private.invoke_process_transcript_jobs() from public, anon, authenticated;

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

  perform cron.schedule(
    'process-transcript-jobs-every-5-minutes',
    '*/5 * * * *',
    $$ select private.invoke_process_transcript_jobs(); $$
  );
  raise notice 'transcript worker cron schedule enabled: process-transcript-jobs-every-5-minutes';
end;
$worker_schedule$;

revoke all on function private.ensure_process_transcript_jobs_schedule() from public, anon, authenticated;

select private.ensure_process_transcript_jobs_schedule();

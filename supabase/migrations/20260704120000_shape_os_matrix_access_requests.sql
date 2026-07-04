-- Shape OS Matrix access requests.
--
-- Matrix sign-in can prove a Matrix account but does not produce a Supabase JWT,
-- so the approved-but-unbound Matrix path needs a write-only contact request
-- lane. Keep the existing email-shaped authenticated policy, and add a narrow
-- anon insert path for Matrix ids only.

alter table public.app_access_requests
  drop constraint if exists app_access_requests_email_normalized;

alter table public.app_access_requests
  add constraint app_access_requests_contact_normalized check (
    email = lower(btrim(email))
    and (
      position('@' in email) > 1
      or (
        email like '@%:%'
        and position(':' in email) > 2
      )
    )
  );

grant insert (email, display_name, requested_record_id, message)
  on public.app_access_requests to anon;

drop policy if exists "app access requests insert matrix contact" on public.app_access_requests;
create policy "app access requests insert matrix contact"
  on public.app_access_requests
  for insert
  to anon
  with check (
    email = lower(btrim(email))
    and email like '@%:%'
    and position(':' in email) > 2
  );

# Calendar Ingress Launch Checklist

Status: managed Google calendar, Supabase calendar copy, Cube interim capture attendee, Calendar owner ACLs, Drive manager ACLs, and capture-readiness audit are live; Otter and production transcript recording automation remain follow-up work
Date: 2026-06-13

## Read This First

Read `docs/calendar-ingress-quality-audit.md` before treating this as launched.
The app now has a workable scaffold, but the remaining launch work is not just
supplying accounts, IDs, and secrets. The code path is split this way:

- Client apps use browser-safe Supabase config only.
- Supabase Edge Functions hold Google and service-role credentials.
- Google Calendar is the invite authority.
- Supabase is the product database.
- Meet, Gemini, Otter, Drive, and manual uploads enter as private source
  artifacts.
- A Supabase Edge Function now turns queued private Drive source artifacts into
  `needs_review` derived rows and approval gates. Local workers remain replay
  and debug tools; they are not the production runtime.

Before changing policy behavior, run:

```bash
npm run check:calendar-policy
```

Do not put Google OAuth tokens, Supabase service-role keys, raw transcript text,
or raw slide images into committed files, Google event descriptions, or browser
config.

## Current Default Calendar State

- Calendar name: `Shape Rotator OS`
- Calendar ID:
  `c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com`
- Calendar timezone: `America/New_York`
- Desired editor/admin emails are supplied through private env, not committed
  defaults.
- Current ACL state: Google API ACL apply promoted all six accounts to `owner`
  on 2026-06-13.
- Current Drive ACL state: Google Drive API apply promoted the configured
  private admin list to shared-drive `organizer`/manager on 2026-06-13.
- Current backfill state: Google Calendar and Supabase have the managed calendar
  source backfilled and verified.
- Current capture state: historical backfill rows are schedule placeholders, not
  proof of recordable meetings. Use `npm run calendar:capture:audit` to
  distinguish Calendar/Supabase health from Meet/Cube/transcript capture health.
- Current credential state: no Google OAuth client secret, access token, refresh
  token, Supabase service-role key, raw transcript text, or raw slide image
  belongs in this repo. Keep those in `.env.calendar.local`, a process-local
  shell env, or Supabase function secrets. `TRANSCRIPT_WORKER_TOKEN` also
  belongs only in local operator env or Supabase function secrets.

Important CLI boundary:

- `calendar:setup:check`, `calendar:setup:seed-sql`, and
  `calendar:setup:plan` can read `--env-file .env.calendar.local`.
- `calendar:oauth:google`, `calendar:backfill:google`, `calendar:acl:google`,
  and `calendar:launch:google` can also read
  `--env-file .env.calendar.local`. Explicit CLI flags still win over loaded
  env values.

## Human Checklist

### 0. Credential Worksheet

- [ ] Copy `docs/calendar-ingress.env.example` to `.env.calendar.local`.
- [ ] Confirm the copied worksheet already contains the current default
  `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_NAME`, `GOOGLE_CALENDAR_TIMEZONE`, and
  `GOOGLE_CALENDAR_EDITOR_EMAILS`.
- [ ] Add every admin organizer's Supabase `auth.users.id` to
  `ADMIN_ORGANIZER_USER_IDS` once those accounts exist. `ADMIN_USER_ID` is only
  the single-admin shortcut; the organizer list is the durable app admin list.
- [ ] Fill only the blank values you actually have. Leave unknown secrets blank
  until the real OAuth/Supabase credential exists.
- [ ] Run the setup check:

```bash
npm run calendar:setup:check -- --env-file .env.calendar.local --allow-missing
```

- [ ] After Supabase and Google values are filled, generate the seed SQL:

```bash
npm run calendar:setup:seed-sql -- --env-file .env.calendar.local --out calendar-ingress-seed.sql
```

- [ ] Before applying the seed SQL, confirm `GOOGLE_CALENDAR_ORGANIZER_EMAIL`
  is the real owning/authorizing Google account. If it is blank, the generator
  emits `calendar@your-domain.example` as an inspection placeholder.
- [ ] Before applying the seed SQL, confirm `ADMIN_ORGANIZER_USER_IDS` covers
  the same humans who should have in-app admin event creation access. Google
  calendar ACLs alone do not satisfy Supabase RLS.
- [ ] Inspect `calendar-ingress-seed.sql` before running it in Supabase.
- [ ] Generate the deployment runbook:

```bash
npm run calendar:setup:plan -- --env-file .env.calendar.local --out calendar-ingress-deploy-plan.md
```

- [ ] Keep `.env.calendar.local`, generated SQL, and generated deploy plans out
  of git. `.gitignore` covers `.env.*.local`,
  `calendar-ingress-seed.sql`, and `calendar-ingress-deploy-plan.md`.

### 1. Supabase Project

- [ ] Create or choose the Supabase project.
- [ ] Record the project URL as `SUPABASE_URL`.
- [ ] Record the anon public key as `SUPABASE_ANON_KEY`.
- [ ] Record the service-role key as `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] Record the Supabase project ref as `SUPABASE_PROJECT_REF`.
- [ ] Apply `supabase/migrations/20260612_calendar_meet_sessions.sql`.
- [ ] Apply `supabase/migrations/202606130000_calendar_ingress_api_grants.sql`.
- [ ] Create the first `orgs` row.
- [ ] Create `org_memberships` rows as `admin` for every
  `ADMIN_ORGANIZER_USER_IDS` value, or generate them through
  `calendar:setup:seed-sql`.
- [ ] Add any non-admin coordinator members who should be able to create
  calendar events immediately.
- [ ] Insert the active routing policy from
  `cohort-data/policies/transcript-routing-policy.json` into
  `routing_policies`.
- [ ] Create a `calendar_connections` row for the organizer calendar.
- [ ] Verify RLS with one member account and one coordinator/admin account.

Minimum SQL seed shape after the migration:

```sql
insert into public.orgs (slug, name)
values ('shape-rotator', 'Shape Rotator')
returning id;

insert into public.org_memberships (org_id, user_id, role)
values ('ORG_ID', 'AUTH_USER_ID', 'admin');

-- Multiple admin organizers:
insert into public.org_memberships (org_id, user_id, role)
values
  ('ORG_ID', 'AUTH_USER_ID_1', 'admin'),
  ('ORG_ID', 'AUTH_USER_ID_2', 'admin')
on conflict (org_id, user_id) do update set role = excluded.role;

insert into public.routing_policies (org_id, policy_key, version, policy_json, active)
values ('ORG_ID', 'transcript-routing', '2026-06-13', 'ROUTING_POLICY_JSON'::jsonb, true);

insert into public.calendar_connections (
  org_id,
  provider,
  calendar_id,
  organizer_email,
  auth_mode,
  status
) values (
  'ORG_ID',
  'google',
  'c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com',
  'calendar@your-domain.example',
  'oauth_organizer',
  'active'
)
returning id;
```

### 2. Google Calendar

- [x] Default organizer calendar exists: `Shape Rotator OS`.
- [x] Default organizer calendar timezone is `America/New_York`.
- [x] Default calendar ID is recorded as
  `c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com`.
- [x] Authorized calendar users should open the ACL-gated Google Calendar
  subscription URL from deploy/runtime config, not from a committed repo link.
  The public Google, webcal, and `.ics` links remain read-only feed
  subscriptions. Adding the capture bot attempts to subscribe to its primary
  calendar and correctly fails.
- [x] Web deploys can expose the ACL-gated link by setting
  `SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL` before `npm run deploy:web`; the writer
  emits `apps/web/calendar-runtime-config.js` for the deployed artifact without
  committing the private URL.
- [ ] Record the owning organizer account as
  `GOOGLE_CALENDAR_ORGANIZER_EMAIL`. Prefer a dedicated account such as
  `calendar@...`, not a human's personal calendar.
- [ ] Create a Google Cloud OAuth client for server-side Calendar access.
- [ ] Grant the app the scopes used by the helper:
  `https://www.googleapis.com/auth/calendar`,
  `https://www.googleapis.com/auth/drive`,
  `https://www.googleapis.com/auth/meetings.space.settings`,
  `https://www.googleapis.com/auth/meetings.space.readonly`,
  `https://www.googleapis.com/auth/userinfo.email`, and `openid`.
- [ ] Add `http://127.0.0.1:8787/oauth2callback` or your configured
  `GOOGLE_OAUTH_REDIRECT_URI` as an authorized redirect URI on that OAuth
  client.

The concrete commands below target the current calendar. Backfill, ACL, launch,
and the preferred OAuth `--format summary --update-env-file` commands do not
print secrets. Use OAuth `--format env` only in a trusted local shell when you
explicitly need token assignment lines.

Process-local PowerShell setup for a trusted operator shell:

```powershell
$env:GOOGLE_CALENDAR_ID = "c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com"
$env:GOOGLE_CALENDAR_EDITOR_EMAILS = "admin-one@example.com,admin-two@example.com"
$env:GOOGLE_OAUTH_REDIRECT_URI = "http://127.0.0.1:8787/oauth2callback"
# Paste these only when the real values exist:
# $env:GOOGLE_OAUTH_CLIENT_ID = "<oauth-client-id>"
# $env:GOOGLE_OAUTH_CLIENT_SECRET = "<oauth-client-secret>"
# $env:GOOGLE_CALENDAR_ACCESS_TOKEN = "<access-token>"
# $env:GOOGLE_OAUTH_REFRESH_TOKEN = "<refresh-token>"
```

- [ ] Dry-run the generated app/web calendar backfill against the current
  calendar. This does not require a Google token. The source backfill expands
  parseable timed blocks into real Google timed events and keeps only
  unparseable or genuinely all-day blocks in the all-day strip:

```powershell
npm run calendar:backfill:google -- --env-file .env.calendar.local --dry-run
```

- [ ] Generate the Google OAuth consent URL after the OAuth client ID exists:

```powershell
npm run calendar:oauth:google -- --env-file .env.calendar.local --auth-url
```

- [ ] Produce a server-held access token for first testing. Open the printed
  URL in the organizer account:

```powershell
npm run calendar:oauth:google -- --env-file .env.calendar.local --listen --format summary --update-env-file .env.calendar.local
```

- [ ] Confirm the command updated `GOOGLE_CALENDAR_ACCESS_TOKEN`,
  `GOOGLE_OAUTH_REFRESH_TOKEN`, and `GOOGLE_OAUTH_SCOPES` in
  `.env.calendar.local`; do not print or paste token values into docs or git.
- [ ] Confirm the consent screen account is `cube@shaperotator.xyz`, not a
  personal Gmail account.
- [ ] Confirm the returned `GOOGLE_OAUTH_SCOPES` includes
  `https://www.googleapis.com/auth/meetings.space.settings`; without it the app
  can create Meet links but cannot pre-enable auto transcripts/recordings.
- [ ] Refresh the access token when needed:

```powershell
npm run calendar:oauth:google -- --env-file .env.calendar.local --refresh-token "$env:GOOGLE_OAUTH_REFRESH_TOKEN" --format summary --update-env-file .env.calendar.local
```

- [ ] After `GOOGLE_CALENDAR_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN` is
  available in the trusted shell, apply the backfill and editor ACLs together.
  This command immediately reruns both operations; `"ready": true` means the
  source backfill and editor grants were idempotently verified:

```powershell
npm run calendar:launch:google -- --env-file .env.calendar.local --role owner --scope-type user --send-notifications --apply
```

- [ ] Treat the launch as passing only if output has `"ready": true`,
  `verification.backfill.inserted === 0`, `verification.backfill.updated === 0`,
  `verification.acl.inserted === 0`, `verification.acl.updated === 0`, and the
  ACL planned count matches the six configured admins or the chosen group.

- [ ] If applying the pieces separately, apply the backfill:

```powershell
npm run calendar:backfill:google -- --env-file .env.calendar.local --apply
```

- [ ] Confirm the backfill reports `inserted`, `updated`, and `unchanged`
  counts and does not duplicate events on a second run.
- [ ] Decide the production token strategy: OAuth refresh token storage or
  Workspace domain-wide delegation.
- [ ] Decide whether editor access should be a Google Group or individual user
  ACL rules. Prefer a group if the organizer Workspace policy permits it.
- [ ] If using a Google Group, dry-run with `--scope-type group` and the group
  address:

```powershell
npm run calendar:acl:google -- --env-file .env.calendar.local --emails "shape-calendar-admins@your-domain.example" --role owner --scope-type group --dry-run
```

- [ ] If using the current individual editor emails, dry-run the Calendar ACL
  setup:

```powershell
npm run calendar:acl:google -- --env-file .env.calendar.local --role owner --scope-type user --dry-run
```

- [ ] After a token exists, verify live Google ACL state without writing. This
  fetches existing ACLs and reports `missing` or `would_update` rows:

```powershell
npm run calendar:acl:google -- --env-file .env.calendar.local --role owner --scope-type user --verify
```

- [ ] Treat Shape Rotator OS / Supabase-backed event creation as the normal
  admin path. Admins and coordinators create events through the web/Electron
  calendar ingress panel; public Google, webcal, and `.ics` links remain
  read-only subscriptions.
- [ ] For every real person in `GOOGLE_CALENDAR_EDITOR_EMAILS`, confirm the
  matching Supabase auth user is present in `ADMIN_ORGANIZER_USER_IDS` or has a
  coordinator/admin membership. Without that membership, the user may have
  Google calendar access but cannot use the normal Shape Rotator OS event path.
- [ ] If the Supabase auth users already exist, reconcile Google editor emails
  into app admin memberships from a trusted operator shell:

```powershell
npm run calendar:admins:supabase -- --env-file .env.calendar.local --dry-run
npm run calendar:admins:supabase -- --env-file .env.calendar.local --apply
```

- [ ] Only for operators who need direct editing in Google Calendar, verify that
  operator's own Google account can see the managed calendar as a writable
  CalendarList entry. Run this with the direct operator's OAuth token, not with
  the Cube/organizer token:

```powershell
npm run calendar:list:google -- --calendar-id "$env:GOOGLE_CALENDAR_ID" --required-role writer --verify
```

- [ ] If the CalendarList check reports `would_insert` or `would_update`, repair
  that user's visible calendar-list entry:

```powershell
npm run calendar:list:google -- --calendar-id "$env:GOOGLE_CALENDAR_ID" --required-role writer --apply
```

- [ ] Treat `create_dropdown_expected: true` as the browser-readiness signal for
  direct Google editing from that account. If the check reports
  `insufficient_access`, the operator may see Shape Rotator events but still
  lack a writable event-creation target; fix the Calendar ACL or organizer
  Workspace external-sharing policy first.

- [ ] After `GOOGLE_CALENDAR_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN` is
  available, apply owner/admin access for the configured admin emails:

```powershell
npm run calendar:acl:google -- --env-file .env.calendar.local --role owner --scope-type user --send-notifications --apply
```

- [ ] ACL setup treats stronger existing roles as satisfying weaker requested
  roles. An existing `owner` is not downgraded to `writer` unless the operator
  deliberately passes `--allow-downgrade`.
- [ ] If Google still blocks `writer` or `owner`, resolve the organizer
  account's Workspace external calendar sharing policy first. The prior UI
  behavior, where users were accepted but writer/manage-sharing choices were
  disabled, is not a successful ACL grant.
- [ ] Confirm the ACL setup reports `inserted`, `updated`, and `unchanged`
  counts and does not downgrade ordinary guests into calendar editors.
- [ ] Confirm ordinary invitees are only event guests, not calendar editors.

Calendar event invariant:

```json
{
  "guestsCanModify": false,
  "guestsCanInviteOthers": false,
  "guestsCanSeeOtherGuests": true
}
```

Capture readiness invariant for timed sessions:

```text
timed event + Google Meet link + Cube covered as attendee/organizer + guest edit flags locked
```

This still does not prove a transcript was created. A transcript is proven only
when a matching Meet/Otter/manual `capture_artifacts` or `source_artifacts` row
exists for the session.

Auto-transcript invariant:

```text
Cube OAuth includes meetings.space.settings + Meet space artifactConfig turns transcription ON before the meeting
```

### 3. Supabase Functions

- [x] Deploy `create-calendar-event`.
- [x] Deploy `google-calendar-webhook`.
- [x] Deploy `ingest-artifacts`.
- [x] Deploy `review-transcript-artifact`.
- [x] Set function secrets:
  - [x] `SUPABASE_URL`
  - [x] `SUPABASE_SERVICE_ROLE_KEY`
  - [x] `GOOGLE_CALENDAR_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN`
  - [x] `SHAPE_CALENDAR_BOT_EMAIL`, if using a separate capture bot attendee
  - [x] `GOOGLE_CALENDAR_WEBHOOK_TOKEN`
  - [x] `ROUTING_POLICY_JSON`, only if overriding the committed default
- [x] Confirm `create-calendar-event` resolves `calendar_connection_id` and the
  active routing policy server-side; clients must not supply `calendar_id` or a
  custom policy.
- [x] Confirm `create-calendar-event` rejects callers who are not
  coordinators/admins before using the Supabase service-role key.
- [x] Confirm `ingest-artifacts` allows member manual submissions only as T0
  local/external source refs with `raw_available_to_server = false`, while
  automated Meet/Otter ingestion remains coordinator/admin-only.
- [ ] Dry-run `create-calendar-event` from the web or Electron surface.
- [x] Create one real test event with a non-sensitive title.
- [ ] Confirm guests receive normal invitations and cannot edit the event.
- [x] Confirm the created event appears in Supabase `sessions`.
- [x] Re-run the setup check without `--allow-missing`:

```bash
npm run calendar:setup:check -- --env-file .env.calendar.local
```

### 4. Google Calendar Sync

- [ ] Dry-run a fixture import of existing organizer calendar events:

```bash
npm run calendar:sync:google -- --env-file .env.calendar.local --events google-events.json
```

- [x] Run an initial full sync against Google and apply it to Supabase:

```bash
npm run calendar:sync:google -- --env-file .env.calendar.local --full --apply
```

- [x] Create a Google Calendar watch channel for the organizer calendar.
- [x] Store channel/resource identifiers in `calendar_sync_state`.
- [x] Confirm the webhook performs an incremental sync when Google notifies the
  app; the live smoke test created a no-guest Google event, observed the
  Supabase `sessions` row, then deleted the temporary Google event and cleaned
  the temporary Supabase row.
- [x] Confirm the webhook writes/updates Supabase `sessions` and
  `session_attendees`, marks cancelled Google tombstones as cancelled sessions,
  clears `sync_requested_at`, sets `sync_status = 'ok'`, and stores
  `google_sync_token`.
- [x] Confirm an expired Google sync token returns to a full sync path and
  records `sync_status = 'expired'` before recovering.
- [ ] Decide watch renewal cadence. Google watch channels expire and must be
  renewed before expiration.
- [ ] Put the sync command on a trusted host/scheduler. Do not run it in the
  browser or Electron client because it needs Google access and Supabase
  service-role credentials.

### 5. Meet, Gemini, and Transcripts

- [ ] Confirm the organizer Workspace plan supports Meet transcripts.
- [x] Enable the Google Meet API (`meet.googleapis.com`) in the Google Cloud
  project used by the OAuth client.
- [ ] Confirm whether Gemini smart notes are available for that account. The
  default automation must not patch Smart Notes because some organizers cannot
  update that setting even when transcript settings work.
- [ ] Decide which session types should request auto-transcripts by default.
- [ ] Decide whether a capture bot email is required or whether organizer-owned
  Meet artifacts are enough for v1.
- [ ] Re-consent Cube if `GOOGLE_OAUTH_SCOPES` does not include
  `https://www.googleapis.com/auth/meetings.space.settings`.
- [ ] For a new app-created event, enable Meet auto-transcripts before the
  meeting. The deployed `create-calendar-event` function now attempts this
  automatically when it creates a Meet; this CLI remains the manual repair path:

```bash
npm run meet:auto-artifacts -- --env-file .env.calendar.local --session-id SESSION_ID --apply
```

- [ ] If policy allows smart notes or recording, pass `--smart-notes` or
  `--recording` explicitly. Do not turn on video recording or Smart Notes by
  default unless the session type, Workspace feature set, and consent model
  allow it.
- [ ] Audit current Calendar/Supabase capture readiness:

```bash
npm run calendar:capture:audit -- --env-file .env.calendar.local
```

- [ ] Treat the audit as passing for future timed sessions only when there are
  no `missing_meet`, `missing_capture_bot`, or guest-edit failures. Treat past
  timed sessions as transcript-complete only after a matching artifact/source
  row is observed.
- [ ] Configure `GOOGLE_DRIVE_ARTIFACT_FOLDER_ID` if Meet/Gemini artifacts land
  in an organizer Drive folder.
- [ ] Run the metadata-only Drive artifact poller after a meeting:

```bash
npm run artifacts:drive -- --org-id ORG_ID --drive-folder-id GOOGLE_DRIVE_ARTIFACT_FOLDER_ID
```

- [ ] Apply matched artifact refs from a trusted operator shell:

```bash
npm run artifacts:drive -- --org-id ORG_ID --drive-folder-id GOOGLE_DRIVE_ARTIFACT_FOLDER_ID --apply
```

- [ ] Add Workspace Events or a scheduler around the Drive poller if the
  organizer account supports it.
- [ ] Call `ingest-artifacts` with Meet transcript/smart-note manifests.
- [ ] Verify `ingest-artifacts` writes `ingestion_events`, private
  `source_artifacts`, correctly typed `processing_jobs`, and updates the
  session `transcript_status` to `source_ready`.
- [ ] Verify external Meet/Drive transcript refs queue `artifact_fetch`, not
  `distill`, until raw text has been fetched into an allowed local/encrypted
  location.
- [ ] Verify raw transcript text never appears in `sessions`, Google event
  descriptions, public calendar exports, or committed files.

Fast-path manual test:

```bash
npm run artifacts:meet -- --manifest meet-manifest.json --session-id SESSION_ID --org-id ORG_ID
```

Post the same manifest to the deployed `ingest-artifacts` Edge Function from a
trusted coordinator/admin session. The dry-run rows should show
`ingestionEvents`, `captureArtifacts`, `sourceArtifacts`, and no
`processingJobs` until Supabase returns persisted source artifact IDs.

In the web app, use `source ingress` to submit a `session_id`, declared
`source_kind`, storage mode, and source ref/path. Member submissions should be
limited to T0 `local_only` or `external_ref` rows and should never include raw
transcript text in the browser payload.

### 6. Otter Slide Capture

- [ ] Decide whether the cohort has Otter Enterprise API access.
- [ ] If not, use the export-folder path first.
- [ ] Export an Otter conversation folder after a presentation.
- [ ] Build a metadata-only manifest:

```bash
npm run artifacts:otter:manifest -- --dir otter-export --conversation-id OTTER_ID --out otter-manifest.json
```

- [ ] Convert the manifest to Supabase rows:

```bash
npm run artifacts:otter -- --manifest otter-manifest.json --session-id SESSION_ID --org-id ORG_ID
```

- [ ] Post the manifest to `ingest-artifacts` or upsert rows with the service
  role from a trusted machine.
- [ ] Verify slide/image rows queue `artifact_fetch` or `review_prepare`, never
  transcript `distill`.
- [ ] Verify slide images remain private source artifacts until a reviewed
  derived artifact is promoted.

### 7. Cloud Transcript Worker

- [ ] Deploy the cloud transcript worker:

```bash
supabase functions deploy process-transcript-jobs --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt --use-api
supabase functions deploy review-transcript-artifact --project-ref "$SUPABASE_PROJECT_REF"
```

- [ ] Apply the scheduled worker migration. It installs the private invoke
  function and only enables cron after Vault secrets exist:

```bash
supabase db push
```

- [ ] Generate the private Vault seed SQL from the local worksheet. This writes
  secret values under `cohort-data/.private/`; do not print or commit the SQL:

```bash
npm run transcripts:worker:vault-sql -- --env-file .env.calendar.local
```

- [ ] Run the generated private SQL in the Supabase SQL Editor or a trusted DB
  client to create these Vault secrets and enable the cron schedule:
  - `shape_transcript_worker_project_url`
  - `shape_transcript_worker_token`
  - `shape_transcript_worker_org_id`
  - `shape_transcript_worker_limit`
- [ ] Verify the cron job exists in Supabase Cron as
  `process-transcript-jobs-every-30-minutes` and is scheduled for minute `0`
  and `30` each hour.
- [ ] Verify `private.invoke_process_transcript_jobs()` returns a `pg_net`
  request id and that the Edge Function logs show a successful
  `process-transcript-jobs` invocation.
- [ ] Keep `processing_jobs.processor_mode = 'edge'` or `cloud` for normal
  queued Drive refs. Use local mode only for debug/replay.
- [ ] Keep one-off local distillation available for testing against a local
  transcript file:

```bash
npm run artifacts:distill -- --transcript transcript.txt --session session.json --source-artifact source-artifact.json --processing-job processing-job.json
```

- [ ] Run the local worker only against a fixture batch or emergency replay:

```bash
npm run artifacts:worker -- --input worker-batch.json --transcript-root ./private-transcripts --out worker-output.json
```

- [ ] Verify the cloud worker inserts only `derived_artifacts` and
  `approval_gates`, marks the
  `processing_jobs` row complete/failed, and updates the session
  `transcript_status`.
- [ ] Require human review before anything becomes cohort-visible or public.
- [ ] Keep ordinary cloud LLM processing limited to already-distilled material
  whose tier allows it.
- [ ] Define the TEE attestation format only when hosted raw processing is
  actually introduced.

### 8. App Configuration

- [ ] In the web app connection panel, set:
  - [ ] Supabase URL
  - [ ] Supabase anon key
  - [ ] signed-in access token for the current browser session; it is used for
        calls but is not persisted when saving the connection
  - [ ] org ID
  - [ ] calendar connection ID
  - [ ] create-event function URL, if different from the default Supabase
        function URL
- [ ] Repeat the same browser-safe config in the Electron calendar tab.
- [ ] Never paste the Supabase service-role key into either UI.
- [ ] Never rely on browser localStorage for durable bearer-token storage.
      Users should sign in through the eventual auth flow; the manual token
      input is only a temporary operator scaffold.
- [ ] Verify member users can submit `event_requests`.
- [ ] Verify member users can submit manual T0 source refs from the source
  ingress form.
- [ ] Verify coordinator/admin users can create real events.
- [ ] Verify coordinator/admin users can refresh the operator queue.
- [ ] Verify a coordinator/admin can approve a pending event request and create
  the Google invite from the queue.
- [ ] Verify public gates can be approved/blocked and that T3 artifacts require
  a separate publish action after all gates clear.

## Codex/App Setup Already Done

- [x] Routing policy file exists at
  `cohort-data/policies/transcript-routing-policy.json`.
- [x] Supabase migration exists for calendar, artifacts, jobs, review, and
  audit tables.
- [x] Supabase schema tracks `ingestion_events`, transcript SLA state,
  idempotent processing jobs, and public `approval_gates`.
- [x] RLS distinguishes members, coordinators, and admins.
- [x] Members submit `event_requests`; direct `sessions` creation is limited to
  coordinators/admins.
- [x] Source artifact metadata is readable by coordinators or the uploader, not
  cohort-wide based only on `source_tier`.
- [x] Edge Functions check coordinator/admin membership before service-role
  writes.
- [x] Google webhook requires a configured channel token and matching watch
  channel/resource row.
- [x] Google event payload builder enforces non-editable guests.
- [x] Google Calendar event creation Edge Function exists.
- [x] Google Calendar generated-feed backfill helper exists:
  `npm run calendar:backfill:google`.
- [x] Google Calendar capture-readiness audit helper exists:
  `npm run calendar:capture:audit`.
- [x] Google Meet auto-artifact configuration helper exists:
  `npm run meet:auto-artifacts`.
- [x] Google Calendar editor ACL setup helper exists:
  `npm run calendar:acl:google`.
- [x] Google Calendar launch helper exists:
  `npm run calendar:launch:google`.
- [x] Google Calendar OAuth helper exists:
  `npm run calendar:oauth:google`.
- [x] Google Calendar webhook receiver exists.
- [x] Meet/Gemini/Otter/manual artifact ingest Edge Function exists.
- [x] Artifact ingest writes event logs, persists private source artifacts,
  queues typed processing jobs after source IDs exist, and marks sessions
  `source_ready`.
- [x] Local deterministic distillation command exists:
  `npm run artifacts:distill`.
- [x] Local queued distillation worker exists:
  `npm run artifacts:worker`.
- [x] Distillation emits only derived readouts/public candidates and approval
  gates; it masks emails, links, and phone-like strings and does not output the
  raw transcript.
- [x] Web calendar ingress panel exists.
- [x] Electron calendar ingress panel exists.
- [x] Web and Electron have a basic operator queue for pending event requests,
  local processing jobs, derived artifact review, and public gates.
- [x] Event-request approval can be completed through the server-side
  create-calendar Edge Function via `event_request_id`, with a client fallback
  for older deployments.
- [x] Web calendar can optionally read Supabase `sessions`.
- [x] Web calendar export links keep `.ics` as a secondary feed and point
  `managed google calendar` at the canonical organizer calendar ID, not the
  generated `webcal://` feed.
- [x] Otter export-folder manifest script exists.
- [x] Otter slide hashes, MIME type, size, and slide number are preserved.
- [x] Linked source artifacts dedupe by `capture_artifact_id, source_kind`.
- [x] Tests cover calendar policy, web ingress, Electron ingress, parity,
  Supabase export, Meet/Gemini artifacts, Otter artifacts, and Otter export
  scanning.
- [x] Setup check and seed SQL scripts exist:
  `npm run calendar:setup:check` and `npm run calendar:setup:seed-sql`.
- [x] Deployment runbook generator exists:
  `npm run calendar:setup:plan`.
- [x] Credential worksheet exists at `docs/calendar-ingress.env.example`.

## Code Placement Review

The current placement is acceptable for a credential-gated scaffold:

| Area | Current home | Why |
| --- | --- | --- |
| Product policy | `cohort-data/policies/transcript-routing-policy.json` | Human-readable policy source; Node helpers load it. |
| Server-side calendar/artifact helpers | `scripts/lib/calendar-integration.cjs` and `supabase/functions/_shared/calendar.ts` | Runtime boundary: Node CLI and Deno Edge Functions cannot share one file directly without a build step. |
| Supabase schema | `supabase/migrations/20260612_calendar_meet_sessions.sql` and `supabase/migrations/202606130000_calendar_ingress_api_grants.sql` | Correct place for operational product database shape and API-role privileges. |
| Edge Functions | `supabase/functions/*` | Correct place for service-role keys and Google tokens. |
| Web ingress UI | `apps/web/calendar/index.html`, `apps/web/scripts/calendar-ingress*.mjs`, `apps/web/styles/calendar-ingress.css` | Static web runtime needs local assets under `apps/web`. |
| Electron ingress UI | `apps/os/src/renderer/calendar-ingress.mjs`, `apps/os/src/renderer/calendar-ingress.css` | Electron packaging only ships `apps/os/src/**/*`. |
| CLI/manual ingestion | `scripts/prepare-*`, `scripts/run-local-distillation-worker.js`, `scripts/sync-google-calendar-events.js`, `scripts/export-supabase-calendar.js` | Correct for credentialed operator workflows outside browser clients. |
| Operator setup | `scripts/check-calendar-ingress-setup.js`, `scripts/prepare-calendar-ingress-seed-sql.js`, `scripts/prepare-calendar-ingress-deploy-plan.js`, `docs/calendar-ingress.env.example` | Turns the human credential checklist into runnable checks, inspectable seed SQL, and a secret-safe deploy runbook. |
| Launch plan | `docs/calendar-meet-supabase-integration.md` and this checklist | Keeps product direction separate from implementation files. |

One intentional compromise remains: web and Electron each need their own runtime
client file because their deployed file roots are different. The parity test
`scripts/calendar-ingress-parity.test.mjs` now guards the behavior that must not
drift across those two surfaces.

## What Still Needs Product Planning

These are not just implementation chores; they need explicit choices:

1. **Auth model**: who can submit requests, approve sessions, create events,
   ingest artifacts, review derived outputs, and publish public material.
2. **Approval workflow depth**: the basic queue can approve/reject, but a rich
   editor for modifying requests before approval is still needed.
3. **Google token lifecycle**: refresh-token storage, revocation, Workspace
   delegation, and failed-token recovery.
4. **Calendar sync worker**: watch renewal, incremental sync retry rules, and
   conflict handling when admins edit directly in Google Calendar.
5. **Meet artifact watcher**: Workspace Events versus polling, retention window,
   and artifact checkpoint timing.
6. **Drive/document ingestion**: which folders are allowed, what metadata can be
   indexed, and how deterministic organization avoids leaking sensitive content.
7. **Worker operations**: scheduled Edge processing now handles the normal
   queue; remaining choices are retry/backoff rules, alerting, and whether a
   future hosted raw-processing mode requires TEE attestation.
8. **Derived artifact editor**: reviewers can mark rows reviewed/blocked and
   decide gates, but they still need a richer editor for content revisions and
   provenance inspection.
9. **Publication workflow**: Tina's T3 gates need explicit reviewer checkboxes
   and audit log entries.
10. **GitHub signal ingestion**: commits/issues should enter as reviewed
    evidence artifacts, not as raw noisy activity feeds.
11. **Retention and deletion**: raw source references, encrypted blobs, local
    files, and derived artifacts need retention rules.
12. **Observability**: function errors, calendar sync lag, watch expiration,
    failed artifact ingestion, and TEE job failures need operator alerts.

## Verification Commands

Run these after any calendar/artifact change:

```powershell
npm test
npm --workspace @shape-rotator/os run bundle:check
npm run check:ics
npm run check:calendar-transcripts
npm run calendar:setup:check -- --env-file .env.calendar.local --allow-missing
npm run calendar:setup:plan -- --env-file .env.calendar.local
npm run calendar:oauth:google -- --env-file .env.calendar.local --auth-url
npm run calendar:launch:google -- --env-file .env.calendar.local --role owner --scope-type user --dry-run
npm run calendar:capture:audit -- --env-file .env.calendar.local
npm run meet:auto-artifacts -- --env-file .env.calendar.local --meeting-code abc-defg-hij
npm run calendar:backfill:google -- --env-file .env.calendar.local --dry-run
npm run calendar:acl:google -- --env-file .env.calendar.local --role owner --scope-type user --dry-run
npm run artifacts:distill -- --help
npm run artifacts:worker -- --help
```

Known current gaps in this workstation:

- `npm run check:cohort` fails because `apps/os/src/cohort-surface.json` is
  stale relative to generated cohort data.
- Electron smoke cannot run until the local Electron install is repaired.
- Deno and `psql` are not installed, so Edge Function type checking and local
  migration linting need a configured Supabase/Deno environment.

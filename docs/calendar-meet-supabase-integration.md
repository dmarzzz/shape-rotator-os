# Calendar, Meet, and Supabase Integration

Status: implementation scaffold prepared; cloud transcript path and capture-readiness audit wired
Date: 2026-06-13

Launch checklist: `docs/calendar-ingress-launch-checklist.md`

## Goal

Shape Rotator OS should let coordinators create cohort sessions that become real
Google Calendar invites for guests, while keeping the product database in
Supabase and routing Meet/Otter transcript and slide artifacts into the private
evidence pipeline.

The product split is:

- Google Calendar owns invite delivery, attendee RSVP state, event time, and
  Google Meet entry points.
- Supabase owns session policy, review state, transcript/source metadata,
  processing jobs, derived artifacts, and audit history.
- GitHub remains an export/cache layer for public-safe schedule snapshots,
  reviewed artifacts, and offline app/web bundles.

## Calendar Authority

Use one organizer calendar for the first implementation:

- Organizer account: `calendar@shaperotator...`
- App-created events are inserted onto that calendar.
- Calendar timezone: `America/New_York`.
- Guests are attendees only.
- Admins/coordinators are granted write access to the organizer calendar.

This avoids requiring every cohort member to connect Google OAuth before the
product can send real invitations.

## Guest Versus Admin Editing

Google Calendar has three permission/state planes:

1. Event guest permissions.
2. Calendar ACL permissions.
3. Each admin user's personal CalendarList entry.

For guests, every app-created event should set:

```json
{
  "guestsCanModify": false,
  "guestsCanInviteOthers": false,
  "guestsCanSeeOtherGuests": true
}
```

This gives guests a normal invitation on their own calendar without letting them
change the canonical event.

The normal product split is:

- Admins and coordinators create/approve sessions through Shape Rotator OS.
  The deployed `create-calendar-event` function writes to the managed organizer
  calendar with server-held organizer credentials.
- Cohort members and guests subscribe to the exported Google/webcal/ICS feed as
  read-only consumers.
- Direct editing in Google Calendar is optional operator/break-glass access,
  not the primary admin workflow.

For direct Google Calendar operators, grant calendar-level ACL access:

- `writer`: can edit events on the organizer calendar.
- `owner`: can edit events and manage calendar sharing.

Prefer a Google Group such as `shape-calendar-admins@...` as the ACL subject so
admin membership is managed outside event payloads.

ACL success alone is not enough to prove the Google Calendar web UI can create
events on the managed calendar. If someone truly needs direct Google Calendar
editing, their account must also have the managed secondary calendar in its own
CalendarList as visible/selected, and the CalendarList entry must report
`accessRole` of `writer` or `owner`. Otherwise the operator may see Shape
Rotator events on the grid while the event-creation calendar dropdown only
offers their personal calendar, making the calendar look read-only. Check this
only for direct-Google operators with:

```bash
npm run calendar:list:google -- --calendar-id "$GOOGLE_CALENDAR_ID" --verify
```

Run that command with the direct operator's OAuth token, not with the organizer
or capture-bot token. If it reports `would_insert` or `would_update`, rerun with
`--apply`; if it reports `insufficient_access`, fix the calendar ACL or the
organizer Workspace sharing policy first. This is not needed for normal admin
creation through Shape Rotator OS.

## Event Creation Flow

1. User creates an event request in the app or web app.
2. The request must include `session_type`.
3. The routing policy computes the maximum travel tier.
4. If the user is a coordinator/admin, create the event immediately.
5. Otherwise create an `event_requests` row for approval.
6. Backend inserts a Google Calendar event with attendees and `sendUpdates=all`.
7. Backend stores `google_calendar_id`, `google_event_id`, `google_ical_uid`,
   `google_etag`, Meet URL, and policy fields in Supabase.
8. App/web render live sessions from Supabase.
9. Export job writes reviewed/public-safe calendar snapshots back into
   `cohort-data/calendar.json` and `cohort-data/calendar.ics`.

Use Google Calendar `extendedProperties.private` for non-sensitive join keys:

```json
{
  "shape_session_id": "sess_...",
  "shape_policy_version": "transcript-routing-v1",
  "shape_session_type": "office_hours",
  "shape_max_tier": "T2"
}
```

Do not put private transcript state, sensitive routing notes, or raw source
references into the Google event body.

## Meet, Gemini, and Otter Artifact Routing

Google Meet distinguishes transcripts from Gemini smart notes:

- Transcript: verbatim Google Docs artifact with speaker/timestamp detail.
- Smart notes: Gemini-generated concise notes with decisions and action items.

Otter can also capture transcripts and presentation/screen-share images. Treat
Otter slide captures as sensitive source artifacts, not as public slide decks by
default.

All of these should be treated as source material, not final product knowledge.

Routing flow:

1. Calendar event creates or attaches a Google Meet space.
2. Backend configures the Meet space artifact settings before the meeting:
   transcript generation on by default, smart notes or video recording only
   when policy and consent allow it.
3. After the conference ends, Google Meet emits transcript/smart-note artifact
   events or the backend finds them during a periodic artifact sync.
4. Backend maps the Meet conference record back to `sessions.google_meeting_code`
   or `sessions.google_meet_space`.
5. Backend creates `capture_artifacts` rows.
6. Transcript entries or Drive document references become `source_artifacts`
   with `source_kind = 'meet_transcript'` or `source_kind = 'meet_smart_notes'`.
7. Backend records `ingestion_events`, creates the right queued work after
   persisted source IDs exist, and marks the session `transcript_status` as
   `source_ready`.
8. External transcript references queue `artifact_fetch`; local or encrypted
   readable transcript sources queue `distill`; slides/audio/video queue
   `artifact_fetch` or `review_prepare`, not transcript distillation.
9. Raw text is not exposed to the cohort surface. The v1 path processes a local
   transcript file into `derived_artifacts`; TEE processing remains optional for
   hosted raw processing later.
10. Human review promotes derived artifacts to cohort-visible or public-safe
   outputs.

Important distinction: inviting Cube or making Cube the organizer is necessary
calendar coverage, not transcript proof. A session is only capture-ready when it
is timed, has a Meet link, covers Cube as attendee/organizer, and keeps guest
edit flags locked. A transcript is proven only when a matching Meet/Otter/manual
artifact or source row exists in Supabase.

Google's current Meet API supports pre-configuring auto transcripts, recordings,
and smart notes on a meeting space, including spaces created through Google
Calendar. That requires the Cube OAuth token to include
`https://www.googleapis.com/auth/meetings.space.settings`. The
`create-calendar-event` Edge Function attempts transcript configuration
immediately after creating a Meet link. Default automation patches only
recording and transcription settings: transcription ON, recording OFF. Smart
Notes must be requested explicitly because some organizer accounts cannot
update that setting even to OFF. The manual repair helper is:

```bash
npm run meet:auto-artifacts -- --env-file .env.calendar.local --session-id SESSION_ID --apply
```

The current checked-in OAuth defaults include that scope, but an already-issued
Cube refresh token must be re-consented before it can apply Meet artifact
settings. The Google Cloud project for the OAuth client must also have
`meet.googleapis.com` enabled.

Important retention constraint: Google Meet transcript entries exposed by the
Meet REST API are available for a limited post-meeting window. The integration
should fetch or checkpoint artifacts promptly, then persist only the allowed
source reference or encrypted/private copy.

Otter should be treated as an optional provider:

- Enterprise API path: use Otter API/webhooks if the account has API access.
- Export path: allow a coordinator to register exported Otter transcript,
  summary, and slide refs against a `session_id`.
- Export-folder path: use `scripts/prepare-otter-slides-manifest.js` to scan an
  Otter export folder, hash transcript/summary/slide files, and create a
  metadata-only manifest with relative refs.
- Manual fallback: allow app users to submit a T0 source ref/path from the web
  app with `source_kind = 'manual_upload'`, `source_kind =
  'otter_transcript'`, `source_kind = 'otter_summary'`, `source_kind =
  'otter_slide'`, `source_kind = 'meet_transcript'`, or `source_kind =
  'meet_smart_notes'`.

Do not make Otter mandatory for the core product. It is useful for slide capture
and presentation artifacts, but Google Meet transcripts and manual uploads must
still work without it.

## Required Google Capabilities

Calendar:

- Create/update events with attendees.
- Send invite notifications.
- Create or attach Google Meet conference data.
- Watch calendar event changes and maintain an incremental sync token.
- Manage calendar ACLs for admin/editor access.

Meet:

- Subscribe to conference ended / transcript generated / smart notes generated
  events, or poll conference records as a fallback.
- Retrieve transcript artifacts and transcript entries.
- Retrieve smart-note artifact metadata where available.
- Optionally preconfigure auto-transcripts for app-created meeting spaces; add
  smart notes only when the organizer Workspace plan supports that setting.

Otter:

- If Enterprise API access is enabled, ingest conversation, transcript,
  summary, and slide metadata through the provider integration.
- Otherwise accept coordinator-uploaded Otter exports.
- Store captured slide images as private source artifacts until reviewed.

Auth:

- Backend-held OAuth connection for the organizer calendar is the MVP.
- Service account with domain-wide delegation is only appropriate if Shape
  Rotator controls the Workspace and is willing to grant admin scopes.
- OAuth tokens and service-role secrets must never ship inside the Electron app.

## Supabase Responsibilities

Supabase stores the operational state:

- sessions
- attendees
- event requests
- calendar connection and sync state
- Google IDs and ETags
- capture artifact metadata from Google Meet, Gemini smart notes, Otter, or
  manual uploads
- transcript source metadata
- processing jobs and attestations
- derived artifacts
- reviews and approvals
- audit log

Supabase should not store raw transcript text in ordinary plaintext columns.
Raw text should be local-only, encrypted object storage, or direct-to-TEE.
The current web app manual path submits metadata and refs, not raw browser file
contents. Direct browser upload requires an explicit Supabase Storage policy and
raw-data retention decision.

## Local Processing, TEE, and TLS Position

TLS is required for every network hop: app to Supabase, Edge Function to Google,
Edge Function to Supabase, and any worker to object storage. That is transport
security only; it does not solve the raw-transcript trust boundary.

The v1 processing rule should be:

- If raw text stays on the coordinator machine, create a `source_artifacts` row
  with `storage_mode = 'local_only'` and `raw_available_to_server = false`,
  then run local distillation from a trusted local worker with
  `--transcript-root`.
- If the app only knows a Drive/Meet/Otter reference, create a
  `source_artifacts` row with `storage_mode = 'external_ref'` and queue
  `job_kind = 'artifact_fetch'`; do not send that row to the distillation
  worker until the raw content has been fetched into an allowed local/encrypted
  location.
- If raw text is copied into product-managed storage, store it only as encrypted
  object data and mark `storage_mode = 'encrypted_object'`.
- If the source is a slide, audio, or video artifact, queue
  `job_kind = 'artifact_fetch'` while it is an external ref and
  `job_kind = 'review_prepare'` after the artifact is available. Do not queue it
  as a transcript `distill` job.
- If raw text is processed by hosted infrastructure, require
  `processing_jobs.processor_mode = 'tee'`, keep `tee_required = true`, and
  write the attestation reference to `processing_jobs.attestation_ref`.
- Ordinary cloud processing is acceptable only for already-distilled material
  whose tier allows that processing path.

That keeps the product aligned with Tina's rule: raw transcript stays in the
room unless an explicit, reviewable exception exists.

Current local command:

```bash
npm run artifacts:distill -- --transcript transcript.txt --session session.json --source-artifact source-artifact.json --processing-job processing-job.json
npm run artifacts:worker -- --input worker-batch.json --transcript-root ./private-transcripts --out worker-output.json
npm run artifacts:worker -- --supabase-url "$SUPABASE_URL" --service-role-key "$SUPABASE_SERVICE_ROLE_KEY" --org-id "$ORG_ID" --transcript-root ./private-transcripts --apply
```

The one-off command emits Supabase-ready `derivedArtifacts`, public
`approvalGates` when the policy allows T3, and an optional completed
`processingJobs` row. The worker command can process queued Supabase
`processing_jobs` rows from a trusted local machine, insert derived rows/gates,
and patch job/session state. Neither command emits the raw transcript text.

## Prepared Backend Artifacts

The repo now has the credential-free pieces needed to wire the live integration:

- `supabase/migrations/20260612_calendar_meet_sessions.sql` defines orgs,
  memberships, calendar connections, sessions, attendees, requests, sync state,
  ingestion events, capture artifacts, source artifacts, processing jobs,
  derived artifacts, reviews, public approval gates, and audit log.
- `cohort-data/policies/transcript-routing-policy.json` encodes the session
  travel ceilings from the transcript handling policy.
- `scripts/lib/calendar-integration.cjs` builds safe Google Calendar event
  payloads, maps Google events back to Supabase rows, normalizes Meet/Gemini
  and Otter artifacts, preserves Otter slide hashes/MIME metadata, queues
  processing jobs by source readiness and artifact kind, performs deterministic local
  distillation, and exports sessions back into the existing `calendar.json`
  shape.
- `scripts/prepare-otter-slides-manifest.js` converts a local Otter export
  folder into an ingest manifest without copying raw transcript or slide bytes
  into JSON.
- `scripts/poll-google-drive-artifacts.js` scans an allowed Google Drive
  artifact folder, matches transcript/smart-note files back to Supabase
  sessions, and persists only Drive references plus fetch/review jobs.
- `scripts/prepare-transcript-vault-import.mjs` prepares historical transcript
  vault copies for import. It strips Drive's `Copy of ` prefix in the manifest,
  infers dates/session types from filenames, matches against
  `cohort-data/calendar.json`, and writes only private Drive refs under
  `cohort-data/.private/`.
- `docs/calendar-ingress.env.example`,
  `scripts/check-calendar-ingress-setup.js`, and
  `scripts/prepare-calendar-ingress-seed-sql.js`, and
  `scripts/prepare-calendar-ingress-deploy-plan.js` provide the operator path:
  fill credentials, check readiness, generate inspectable Supabase seed SQL,
  and produce a secret-safe deployment runbook.
- `scripts/lib/supabase-rest.cjs` prepares Supabase REST upsert requests for
  sessions, attendees, ingestion events, capture artifacts, source artifacts,
  processing jobs, derived artifacts, approval gates, and artifact reviews.
- `scripts/prepare-derived-artifacts.js` reads a local transcript file and
  emits only derived artifact rows, approval gates, and optional job completion
  rows.
- `scripts/run-local-distillation-worker.js` processes queued local
  `processing_jobs` from a fixture batch or live Supabase queue, constrained to
  transcript files under `--transcript-root`.
- `supabase/functions/create-calendar-event` creates real Google Calendar
  events from server-held credentials, enforces non-editable guests, and can
  persist the result to Supabase. When called with `event_request_id`, it also
  marks the pending request approved after the session/attendee rows are stored.
- `supabase/functions/google-calendar-webhook` accepts Google Calendar push
  notifications, verifies the optional channel token, and marks the connection
  as needing incremental sync.
- `supabase/functions/ingest-artifacts` accepts Google Meet/Gemini or Otter
  manifests, plus manual/local source manifests, inserts ingestion/capture/source
  rows, queues typed fetch/review/distillation jobs, and marks sessions
  `source_ready`.
- `apps/web/calendar/index.html`, `apps/web/scripts/calendar-ingress.js`, and
  `apps/web/scripts/calendar-ingress-client.mjs` add the first web calendar
  ingress surface. It can submit pending `event_requests`, call the
  create-calendar Edge Function for coordinators, and preview the Google event
  payload locally without leaking the private title into the public invite. It
  also has a basic operator queue for event request approval, processing-job
  visibility, derived-artifact review, and public approval gates.
- `apps/web/scripts/calendar-supabase-source.mjs` adds an optional live web
  read path from Supabase `sessions`. If browser-safe Supabase config is absent,
  the calendar keeps using the existing static GitHub/exported bundle.
- `apps/os/src/renderer/calendar-ingress.mjs` and
  `apps/os/src/renderer/calendar-ingress.css` port the same request/create
  workflow and operator queue into the Electron calendar tab. The desktop
  surface stores only browser-safe Supabase config, never a service-role key.
- `scripts/calendar-ingress-parity.test.mjs` guards the web and Electron
  ingress adapters so they keep producing the same core session/request/event
  payloads.

Useful local commands:

```bash
npm run test:calendar-integration
npm run calendar:setup:check -- --env-file .env.calendar.local --allow-missing
npm run calendar:setup:seed-sql -- --env-file .env.calendar.local --out calendar-ingress-seed.sql
npm run calendar:setup:plan -- --env-file .env.calendar.local --out calendar-ingress-deploy-plan.md
npm run calendar:sync:google -- --events google-events.json
npm run calendar:sync:google -- --org-id "$ORG_ID" --calendar-connection-id "$CALENDAR_CONNECTION_ID" --full --apply
npm run calendar:sync:google -- --org-id "$ORG_ID" --calendar-connection-id "$CALENDAR_CONNECTION_ID" --apply
npm run calendar:capture:audit -- --env-file .env.calendar.local
npm run meet:auto-artifacts -- --env-file .env.calendar.local --session-id "$SESSION_ID" --apply
npm run artifacts:drive -- --org-id "$ORG_ID" --drive-folder-id "$GOOGLE_DRIVE_ARTIFACT_FOLDER_ID"
npm run artifacts:drive -- --org-id "$ORG_ID" --drive-folder-id "$GOOGLE_DRIVE_ARTIFACT_FOLDER_ID" --apply
npm run transcripts:vault:prepare -- --files cohort-data/.private/transcript-vault/vault-files.json --raw-folder-id "$GOOGLE_DRIVE_ARTIFACT_FOLDER_ID"
npm run artifacts:otter:manifest -- --dir otter-export --conversation-id OTTER_ID --out otter-manifest.json
npm run artifacts:meet -- --manifest meet-manifest.json --session-id SESSION_ID
npm run artifacts:otter -- --manifest otter-manifest.json --session-id SESSION_ID
npm run artifacts:manual -- --manifest manual-manifest.json --session-id SESSION_ID
npm run artifacts:distill -- --transcript transcript.txt --session session.json --source-artifact source-artifact.json --processing-job processing-job.json
npm run artifacts:worker -- --input worker-batch.json --transcript-root ./private-transcripts
npm run artifacts:worker -- --supabase-url "$SUPABASE_URL" --service-role-key "$SUPABASE_SERVICE_ROLE_KEY" --org-id "$ORG_ID" --transcript-root ./private-transcripts --apply
npm run calendar:supabase:upsert -- --input rows.json --supabase-url "$SUPABASE_URL"
node --test scripts/web-calendar-ingress.test.mjs
node --test scripts/web-calendar-supabase-source.test.mjs
node --test scripts/os-calendar-ingress.test.mjs
node --test scripts/calendar-ingress-parity.test.mjs
node --test scripts/google-calendar-sync.test.js
node --test scripts/otter-slides-manifest.test.mjs
```

Required live secrets/configuration:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PROJECT_REF`, for CLI deploy commands
- `ORG_ID`, after seed SQL creates/selects the org
- `CALENDAR_CONNECTION_ID`, after seed SQL creates/selects the connection
- `GOOGLE_CALENDAR_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN`
- `SHAPE_CALENDAR_BOT_EMAIL`, if the capture bot is a separate attendee
- `GOOGLE_CALENDAR_WEBHOOK_TOKEN`
- `ROUTING_POLICY_JSON`, only if overriding the default deployed policy

`GOOGLE_CALENDAR_ID` is seed/setup data for `calendar_connections`, not a
client-controlled event-creation input. The Edge Function should resolve both
the calendar connection and the active routing policy server-side from
`org_id`/`calendar_connection_id`; clients must not supply `calendar_id` or a
custom `policy`.

## First Implementation Slice

1. Apply the Supabase migration to a real project.
2. Create one organizer Google account and connect it server-side.
3. Deploy `create-calendar-event`, `google-calendar-webhook`, and
   `ingest-artifacts`.
4. Create the calendar watch channel and store the resulting channel/resource
   identifiers in `calendar_sync_state`.
5. Import organizer-calendar events into Supabase with
   `scripts/sync-google-calendar-events.js --full --apply`, then run the same
   command without `--full` after webhook notifications so it consumes the
   stored Google sync token.
6. Connect the web calendar ingress/read path to a real authenticated Supabase
   org and verify RLS with member/coordinator accounts.
7. Verify the Electron ingress workflow against a real authenticated Supabase
   org and deployed create-calendar Edge Function.
8. Verify the operator queue can approve one pending request, reject one pending
   request, review one derived artifact, and approve/block public gates.
9. Add every admin organizer to Supabase `org_memberships` as `admin` or
   `coordinator`, then grant the same people calendar ACL `writer` or `owner`
   on the organizer calendar. The Supabase membership is what unlocks the
   normal Shape Rotator OS event creator; the Google ACL is only for direct
   Google Calendar editing and operational fallback.
10. Configure `GOOGLE_DRIVE_ARTIFACT_FOLDER_ID` and run
   `scripts/poll-google-drive-artifacts.js` after meetings; replace or trigger
   it with Workspace Events later if the organizer account supports it.
   For copied historical vault files, first run
   `scripts/prepare-transcript-vault-import.mjs` and review the private summary;
   copied files have fresh Drive modified times, so the live poller's time
   window is not a reliable calendar matcher for backfills.
11. Use the Otter export-folder manifest path for slide capture now; add Otter
   Enterprise API ingestion only if API access is available.
12. Route external refs through fetch/review jobs, run `npm run
   artifacts:worker` only for readable local transcript jobs, and promote only
   reviewed `derived_artifacts`.

## Open Questions

- What is the exact organizer account and Workspace domain?
- Are auto-transcripts and smart notes available on the organizer's Workspace
  plan?
- Should every app-created Meet have transcripts on by default, or only
  sessions whose policy allows capture?
- Should admin editing happen only in Shape Rotator OS, or also directly in
  Google Calendar through shared-calendar ACLs?
- Should `artifacts:worker` be triggered manually, scheduled on the coordinator
  desktop, or run from a trusted host cron?
- Does Shape Rotator have Otter Enterprise API access, or should v1 support
  only manual/exported Otter artifacts?
- Should slide images be OCRed locally/inside TEE, or stored only as visual
  evidence attached to the reviewed readout?

## References

- Google Calendar event resource: https://developers.google.com/workspace/calendar/api/v3/reference/events
- Google Calendar ACL resource: https://developers.google.com/workspace/calendar/api/v3/reference/acl
- Google Calendar event creation: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- Google Calendar push notifications: https://developers.google.com/workspace/calendar/api/guides/push
- Google Calendar incremental sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Google Meet artifacts: https://developers.google.com/workspace/meet/api/guides/artifacts
- Google Meet events: https://developers.google.com/workspace/events/guides/events-meet
- Google Meet space configuration: https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration
- Otter API availability: https://help.otter.ai/hc/en-us/articles/4412365535895-Does-Otter-offer-an-open-API
- Otter automated slide capture: https://help.otter.ai/hc/en-us/articles/5093321813911-Automated-Slide-Capture-Overview
- Otter export conversations: https://help.otter.ai/hc/en-us/articles/360047733634-Export-conversations

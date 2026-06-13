# Calendar Ingress Quality Audit

Date: 2026-06-13

## Verdict

This is not production-complete calendar ingress. It is a useful scaffold with
local validation and a working local transcript-distillation worker, but the live
product still needs account setup, richer review UX, watcher deployment, and
end-to-end verification.

The highest-risk quality issue found in this pass was policy drift: the
canonical transcript-routing policy existed in
`cohort-data/policies/transcript-routing-policy.json`, but runtime copies in the
web app, Electron app, and Supabase Edge Function had diverged. That would have
made routing decisions inconsistent across surfaces. The runtime policy copies
now match the canonical policy, and `npm run check:calendar-policy` is wired
into `npm test`.

## What Is Solid Enough To Build On

- Supabase is the right v1 system of record for product state: sessions,
  attendees, event requests, calendar connections, artifact manifests, routing
  policies, derived artifacts, processing jobs, and approvals.
- Google Calendar is the right invite authority. Ordinary guests should receive
  normal calendar invites with `guestsCanModify: false`; admins edit through the
  shared organizer calendar or the app.
- Raw transcripts and slides should not go to GitHub. GitHub can hold code,
  deterministic policy, generated public/cohort readouts, and audit-friendly
  metadata, but not sensitive source artifacts.
- The app has browser/Electron request builders, event preview generation,
  Supabase request-row builders, and scripts for Google event preparation,
  calendar sync preparation, Meet/Gemini artifact manifests, Otter manifests,
  manual manifests, and Supabase upsert payloads.
- The web app has a source-ingress form for manually registering T0 source refs
  against a session, including Meet/Gemini/Otter/Drive/manual source kinds,
  without sending raw transcript text through the browser.
- The transcript-routing policy now travels with approval gates, including the
  public approval requirements for salons and demos.
- Service-role-backed Edge Functions now require signed-in org authorization
  and derive calendar/policy authority from Supabase instead of trusting
  client-supplied `calendar_id` or `policy` fields. Manual source submission is
  member-allowed only for T0 local/external refs with no raw server access;
  automated ingestion remains coordinator/admin-only.
- The Google Calendar webhook now fails closed unless a channel token is
  configured and the channel/resource IDs match stored sync state.
- The Google Calendar sync command now has a worker mode: it can consume the
  stored sync token, page through Google changes, recover from expired sync
  tokens with a full sync, upsert Supabase sessions/attendees, and mark
  cancellation tombstones without inserting invalid session rows.
- Artifact ingest now writes `ingestion_events`, persists private source rows,
  queues processing jobs only after source artifact IDs exist, routes external
  refs to `artifact_fetch`, routes readable text to `distill`, routes
  slides/media to `artifact_fetch` or `review_prepare`, and marks sessions
  `source_ready`.
- A metadata-only Google Drive artifact poller now scans an allowed Drive
  folder for Meet transcripts/Gemini notes, matches files to sessions, and
  writes Drive refs plus fetch/review jobs without downloading raw text.
- Local distillation now has a runnable command that emits only derived
  readouts/public candidates and approval gates, with raw emails/links masked
  and no raw transcript text in the output.
- A local worker now processes queued local `processing_jobs` from either a
  fixture batch or a live Supabase queue, constrained to transcript files under
  `--transcript-root`.

## What Is Not Done

- There is no production Google OAuth token lifecycle yet. The current path can
  use a server-held access token for testing, but production needs refresh-token
  storage or Workspace domain-wide delegation.
- The Google Calendar sync worker exists as an operator command, but it is not
  deployed or scheduled on trusted infrastructure yet.
- There is no Workspace Events subscription yet, and the Drive poller does not
  fetch raw transcript contents. It detects refs quickly; a raw fetch/export
  worker still needs credentials, storage policy, and review gates.
- Otter slide support is manifest-oriented. It does not yet call an Otter API,
  pull enterprise exports, OCR slides, or promote slide-derived readouts.
- The basic web/Electron operator queue now covers event request approval,
  processing-job visibility, derived artifact review/blocking, and public gate
  approval/blocking. It is not a rich editor for request changes or content
  rewrites.
- There is no always-on deployed worker. The local worker command exists, but an
  operator still has to run it manually, schedule it locally, or place it on a
  trusted host.
- There is no LLM-backed distillation pass yet. The current local path is
  deterministic and conservative; it proves the data movement and gates, not
  final editorial quality.
- Live RLS behavior has not been verified against real Supabase users.
- Edge Functions have not been typechecked with Deno in this local environment.
- Migrations have not been linted against a local Postgres/Supabase instance in
  this local environment.
- End-to-end live creation of a Google Calendar event, receipt by guests, Meet
  artifact discovery, Supabase artifact ingestion, processing, and reviewed
  cohort publication has not been exercised.

## Quality Bar For The Next Build Phase

1. Stand up Supabase and apply the migration.
2. Seed one org, one admin, one calendar connection, and the active routing
   policy.
3. Deploy the three Edge Functions with real secrets.
4. Implement or choose the Google token strategy before treating event creation
   as production-ready.
5. Expand the basic operator queue into a richer editor for modifying event
   requests before approval and revising derived readouts before publication.
6. Deploy or schedule the incremental calendar sync worker on a trusted host.
7. Schedule the Drive artifact poller or replace it with Workspace Events, then
   add the raw fetch/export worker.
8. Use the local coordinator-machine processor first; introduce TEE only when
   hosted raw processing is actually needed.
9. Verify RLS with real member/admin accounts.
10. Run a live test from app request to Google invite to Supabase session to
    artifact manifest to queued job to `artifacts:worker` to reviewed derived
    readout.

## Verification Added In This Pass

- `npm run check:calendar-policy`
- Expanded `scripts/calendar-ingress-parity.test.mjs` coverage across every
  session type in the canonical policy.
- Browser and Electron payload assertions for public approval gates.
- Helper coverage for transcript deadlines, ingestion events, local processing
  jobs, deterministic distillation, public approval gates, and Supabase upsert
  table order.
- Web/Electron coverage for the operator queue, server-side event-request
  approval handoff, and T3 publication gates.
- Google Calendar sync coverage for clean reusable sync-token parameters,
  pagination, Supabase apply, cancellation tombstones, and expired-token
  recovery.
- Local worker coverage for safe transcript-root reads, queued Supabase fetch,
  derived row/gate generation, job completion, and session transcript status.
- Processing job coverage for avoiding impossible distillation jobs on external
  refs and slide/media artifacts.
- Drive artifact poller coverage for folder-scoped metadata queries, matching,
  Supabase apply, and avoiding raw text export calls.

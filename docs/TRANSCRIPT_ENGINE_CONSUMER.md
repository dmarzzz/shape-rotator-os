# Transcript Engine Consumer Contract

Status: current app-side contract as of 2026-07-03.

Shape OS is a transcript consumer, not the transcript engine. The private
transcript engine owns Google Calendar/Meet, Google Drive, raw transcript
processing, Supabase migrations, service-role access, worker scheduling, review,
and publication. Shape OS receives reviewed, app-safe transcript derivatives.

## What Shape OS reads

The app may read:

- `public_transcript_evidence_cards` with the anon/publishable key for public
  T3 evidence.
- `cohort_app_transcript_evidence_cards` with a `role=cohort_app` JWT or a
  Google sign-in app session (Supabase-issued JWT) for named cohort T2 evidence.
- `cohort_app_transcript_distillations` with the same gated bearer for cohort
  distilled readouts.
- `cohort_app_cohort_insight_cards` with the same gated bearer for app-safe
  insight rows.
- committed/static bundle data as fallback.

The app must not query private transcript tables such as `source_artifacts`,
`processing_jobs`, `derived_artifacts`, `evidence_cards`,
`capture_artifacts`, `ingestion_events`, `approval_gates`, `artifact_reviews`,
or `audit_log`.

## Runtime path

The current receive path lives in:

- `apps/os/src/renderer/supabase-config.mjs`
- `apps/os/src/renderer/supabase-anon-write.mjs`
- `apps/os/src/renderer/supabase-evidence.mjs`
- `apps/os/src/renderer/supabase-distillations.mjs`
- `apps/os/src/renderer/cohort-source.js`

Credential behavior:

- The anon key is safe to ship because RLS and views limit it to public T3.
- A cohort key is optional and must not be committed to source. It is injected
  at package time, stored per install, or replaced by a Google sign-in app
  session.
- The platform route is the Google sign-in app session. Supabase issues the app
  JWT behind that Google login so RLS can enforce membership. The `cohort_app`
  key remains an operator/package backup route, not a public secret.
- If no gated bearer exists, T2 reads no-op and the app keeps public T3/static
  behavior.
- Reader failures resolve to empty/error states; they do not crash the app.

## Forbidden in Shape OS

Do not add these to the app, the public repo, app-facing config, or public docs:

- Supabase service-role key
- Google OAuth client secret, refresh token, or access token
- Google Calendar webhook token
- transcript worker token
- raw transcript text or recordings
- Drive inventories, Drive file ids, `drive://` refs, source manifests, or
  private vault/session-map plans
- code paths that fetch raw transcript files from Google Drive

## Verification

Use the app receive doctor:

```powershell
cd "C:\Users\micha\OneDrive\Desktop\Projects\Shape OS"
npm run transcripts:receive:check -- --json --skip-audit
npm run transcripts:receive:check -- --env-file "C:\Users\micha\Projects\shape-rotator-transcript-engine\.env" --json
npm run transcripts:receive:check -- --env-file "C:\Users\micha\Projects\shape-rotator-transcript-engine\.env" --strict-public-names --json
npm run keys:cohort:package-check -- --json --allow-empty
```

Expected degraded states:

- `release_ready=false` with no Google sign-in app session and no cohort key
  means the current runtime is public T3 only.
- An empty packaged cohort key is acceptable when Google sign-in is the intended
  T2 route; the app uses `window.api.auth.getSession()` at read time.
- `strict-public-names` failure means public content cleanup is still needed; it
  is not by itself proof of raw/private table exposure.
- Missing service-role in the app repo is good. The service-role audit can use
  the private engine `.env` only from a trusted local operator context.

The canonical engine-side contract is
`C:\Users\micha\Projects\shape-rotator-transcript-engine\docs\SHAPE_OS_TRANSCRIPT_ROUTE_CONTRACT.md`.

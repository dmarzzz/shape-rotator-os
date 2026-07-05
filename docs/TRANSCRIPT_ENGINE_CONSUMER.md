# Transcript Engine Consumer Contract

Status: current app-side contract as of 2026-07-03.

Shape OS is a transcript consumer, not the transcript engine. The private
transcript engine owns capture, private source/artifact intake, raw transcript
processing, Supabase migrations, service-role access, worker scheduling, review,
and publication. Shape OS receives only reviewed, app-safe transcript
derivatives.

The app-side contract is intentionally narrow:

- Public T3 data must work with only the anon/publishable key.
- Named T2 data must work only through an approved Google sign-in app session,
  or through the `cohort_app` backup key in an operator-provisioned build.
- If T2 cannot be proven, the app must degrade to public T3/static data instead
  of crashing, leaking private source detail, or pretending the cohort route is
  release-ready.

## What Shape OS reads

The app may read:

- `public_transcript_evidence_cards` with the anon/publishable key for public
  T3 evidence.
- `cohort_app_transcript_evidence_cards` with a `role=cohort_app` JWT backup or
  a Google sign-in app session that resolves to an approved/bound
  `app_members` row for named cohort T2 evidence.
- `cohort_app_transcript_distillations` with the same gated bearer for cohort
  distilled readouts.
- `cohort_app_cohort_insight_cards` with the same gated bearer for app-safe
  insight rows.
- committed/static bundle data as fallback.

The app must not query private transcript tables such as `source_artifacts`,
`processing_jobs`, `derived_artifacts`, `evidence_cards`,
`capture_artifacts`, `ingestion_events`, `approval_gates`, `artifact_reviews`,
or `audit_log`.

## Source-Backing Cues

Transcript-derived surfaces should expose provenance as a user-facing confidence
cue, not as private source detail. Shape OS renders a compact `source-backed`
percentage and safe chips:

| Bucket | User label | App meaning |
| --- | --- | --- |
| `source_backed` | From transcript | Reviewed evidence or transcript-backed claim. |
| `metadata_inferred` | From metadata | Filename, folder, calendar, tag, or route metadata. |
| `ai_matched` | AI matched | Generated summary matched back to app-safe evidence. |
| `ai_inferred` | AI inferred | Generated synthesis without direct source backing. |
| `source_missing` | Needs source | Missing or unresolved source trail. |

The engine may store richer provenance internally. When it sends a compact
rollup such as `source_mix_json`, Shape OS can render the public label and
percentage directly; otherwise it recomputes the same mix from app-safe evidence
levels. App-facing rows should keep the label, percentage, confidence/review
status, and boundary. Do not expose Drive file IDs, storage refs, raw transcript
snippets, or private vault/session identifiers in the UI.

## Runtime path

The current receive path lives in:

- `apps/os/src/renderer/supabase-config.mjs`
- `apps/os/src/renderer/supabase-anon-write.mjs`
- `apps/os/src/renderer/supabase-evidence.mjs`
- `apps/os/src/renderer/supabase-distillations.mjs`
- `apps/os/src/renderer/cohort-source.js`

Credential behavior:

- The anon key is safe to ship because RLS and views limit it to public T3.
- A cohort key is optional and must not be committed to source. It is an
  operator/package fallback: injected at package time or stored per install for
  a trusted test build.
- The primary product route is the Google sign-in app session. Supabase brokers
  the Google identity into an app JWT, and RLS uses that JWT to enforce
  membership. The `cohort_app` key remains a backup route, not a public secret
  and not proof that the Google path works.
- Primary T2 release proof requires the app JWT to read `app_my_membership` as
  an approved, bound Shape OS member. A Google-authenticated but unapproved or
  unbound account must fail closed.
- The backing database contract is captured in
  `supabase/migrations/20260703000000_shape_os_app_members_auth_gate.sql`.
  Until that migration is applied through the operator DB lane and the Google
  account has an approved, bound `app_members` row, the app must treat T2 as
  not live-proven.
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
- private source inventories, source file ids/refs, source manifests, or
  private vault/session-map plans
- code paths that fetch raw transcript files from external source systems

## Verification

Use the app receive doctor. Pick the command that matches the claim you are
trying to prove:

```powershell
cd "C:\Users\micha\OneDrive\Desktop\Projects\Shape OS"

# Quick app contract check without private audit.
npm run transcripts:receive:check -- --json --skip-audit

# Full receive check from the private engine env, allowing either gated route.
npm run transcripts:receive:check -- --env-file "C:\Users\micha\Projects\shape-rotator-transcript-engine\.env" --json

# Primary release proof: Google app session + approved/bound membership.
npm run transcripts:receive:check -- --env-file "C:\Users\micha\Projects\shape-rotator-transcript-engine\.env" --require-google-session --json

# Public-safety audit for names in public rows.
npm run transcripts:receive:check -- --env-file "C:\Users\micha\Projects\shape-rotator-transcript-engine\.env" --strict-public-names --json

# Desktop profile proof from inside Electron.
npm --workspace @shape-rotator/os run transcripts:receive:selftest

# Fallback-key packaging check.
npm run keys:cohort:package-check -- --json --allow-empty
```

For a primary T2 release proof, use `--require-google-session`. It fails unless
the gated T2 evidence, distillation, and insight readers use the Google sign-in
app-session path and the app session resolves to approved/bound membership through
`app_my_membership`. `--require-gated` is broader: it can pass with the
`cohort_app` key backup and is useful for fallback-package checks.

When running the CLI outside Electron, the desktop `safeStorage` session is not
decrypted by the verifier. To prove the primary session path from a trusted local
operator shell, provide a short-lived app-session token via
`SHAPE_GOOGLE_SIGNIN_APP_SESSION_TOKEN` in a private env file or process env. The
legacy names `SHAPE_SUPABASE_SESSION_TOKEN` and `SUPABASE_ACCESS_TOKEN` still
work, but the Google-named variable is preferred so this does not read like a
second user-facing Supabase login.

For the real desktop app profile, use
`npm --workspace @shape-rotator/os run transcripts:receive:selftest`. It launches
Electron hidden, waits for the renderer to boot, calls `window.api.auth.getSession()`,
and reads public T3 plus gated T2 from inside the app. This is the best proof
that the stored desktop session, auth bridge, and gated readers agree. It prints
only counts and status fields, never the session token or row text.

Expected degraded states:

- `release_ready=false` with no Google sign-in app session and no cohort key
  means the current runtime is public T3 only.
- An empty packaged cohort key is acceptable when Google sign-in is the intended
  T2 route; the app uses `window.api.auth.getSession()` at read time. Do not
  treat an empty key as a blocker unless you are cutting a fallback-key build.
- `--require-google-session` failing with `google_signin_app_session_source=none`
  means the verifier has not been handed a desktop/app session token yet.
- `--require-google-session` failing with `google_membership.status` other than
  `approved` means the Google account still needs approval/binding in
  `app_members`.
- `transcripts:receive:selftest` failing with
  `no Google sign-in app session available from window.api.auth.getSession()`
  means this local app profile is not signed in yet; public T3 can still be ready.
- `strict-public-names` failure means public content cleanup is still needed; it
  is not by itself proof of raw/private table exposure.
- Missing service-role in the app repo is good. The service-role audit can use
  the private engine `.env` only from a trusted local operator context.

The canonical engine-side contract is
`C:\Users\micha\Projects\shape-rotator-transcript-engine\docs\SHAPE_OS_TRANSCRIPT_ROUTE_CONTRACT.md`.

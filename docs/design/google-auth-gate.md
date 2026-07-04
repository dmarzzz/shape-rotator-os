# Google sign-in gate + approval — implementation plan

Status: **Phase 1 landing** (2026-07-02). Chosen model: **required Google gate + approval**
(see the new-user-flow audit). This replaces the app's login-less, spoofable
"pick your name from a dropdown" identity with a verified Google identity bound to a
cohort record, gated by an approval roster.

## Why

Today identity is an unverified `localStorage` claim (`identity.js`), writes ride the
public anon key, and a live DB trigger auto-approves any profile edit where two
**client-supplied** strings match (`proposer_record_id = record_id`). Anyone can write
as anyone. There is also no email on file for any member (`people_ops` has no email
column; the cohort markdown carries only github/x/website). Google sign-in fixes both:
it proves who the user is **and** captures a verified email.

## The model in one paragraph

A user signs in with Google. Supabase Auth is only the broker that turns that
verified Google identity into the app JWT that Postgres/RLS can trust; it is not
a second user-facing login. The verified email is checked against `app_members`.
If **approved**, the app binds their Google identity to a cohort `record_id` and
all writes are authenticated (JWT), with RLS enforcing that a write's `record_id`
matches the caller's bound record. If **not approved**, they land on a "request
access" screen that files an `app_access_requests` row an admin can approve — the
missing "reach a human to be approved" path.

## Data model

New tables in the shared project:

- **`app_members`** — the approval roster / allowlist. `email` (PK), `record_id`
  (the cohort record they are, nullable until bound), `role` (`member` | `admin`),
  `status` (`approved` | `pending` | `rejected`), `approved_at`, `approved_by`, `note`.
  RLS: a signed-in user may `SELECT` only their own row (`email = auth.jwt()->>'email'`);
  writes are service-role / admin only.
- **`app_access_requests`** — inbound join requests from un-approved sign-ins. `email`,
  `display_name` (from Google), `requested_record_id` (who they claim to be, optional),
  `message`, `status`, `created_at`. RLS: authenticated INSERT where `email` = the
  caller's JWT email; SELECT own; admins SELECT all.
- **`app_my_membership`** (view) — `select … from app_members where email =
  auth.jwt()->>'email'`. The app reads this right after sign-in to learn "am I approved,
  and which record am I."

Identity binding: an approved `app_members.record_id` is the **server-side** source of
truth for "who is this writer," replacing the client-supplied `proposer_record_id`.

## RLS / write-path changes (phased — see below)

- `cohort_events` / `os_profile_updates`: add an `authenticated`-role INSERT policy
  requiring the row's `record_id` to equal the caller's approved `app_members.record_id`.
- `os_profile_updates` auto-approve trigger: derive `is_self` from the **JWT email's
  bound record_id**, not from a client string. This closes the impersonation hole.
- The existing anon INSERT policies stay **until** the gate is enforced everywhere
  (Phase 2), so applying Phase 1 cannot break current clients.

## App changes (this repo)

- `src/renderer/supabase-auth.mjs` — session state (access/refresh/expiry/user),
  `signInWithGoogle()`, `signOut()`, `getSession()`, `onAuthChanged()`,
  `fetchMyMembership()`, `requestAccess()`. Pure, tested helpers for session validity
  and membership parsing.
- `preload.js` — `window.api.auth = { signIn, signOut, getSession, refresh, onSession }`.
- `main.js` — Supabase OAuth via the **existing `sros://` deep-link** infra:
  `auth:sign-in` builds `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=sros://auth-callback`
  and `shell.openExternal`s it; `deliverDeepLink` detects `sros://auth-callback`, parses
  the token fragment, persists the session encrypted via `safeStorage`
  (`auth-session.enc`, same pattern as `swarm-api-key.enc`), and emits `auth:session`.
  `auth:refresh` hits `/auth/v1/token?grant_type=refresh_token`.
- `boot.js` — when the gate flag is on and there is no valid, approved session, render
  the gate screen (sign-in → pending / request-access) instead of the app. **Flag is
  OFF by default** so current users are unaffected until the infra below is live.

## Infra steps — these need you (dashboard access, not code)

1. **Supabase → Auth → URL Configuration**:
   - Site URL: use the public Shape OS web fallback, `https://os-web.shaperotator.xyz`.
   - Redirect URLs: include `sros://auth-callback` and `sros://auth-callback/`.

   The Supabase project may also serve other clients, so sibling apps should keep
   their own explicit redirect URLs in the allow-list. Shape OS must always pass
   its app deep link via `redirect_to`; if that deep link is missing from the
   allow-list, Supabase can fall back to the project Site URL instead of returning
   to the app.
2. **Google Cloud console**: confirm the OAuth 2.0 client used by the Supabase Google
   provider is live. No new client needed unless you want a separate one for the
   desktop app.
3. **Apply the Shape OS migration**
   `supabase/migrations/20260703000000_shape_os_app_members_auth_gate.sql`
   (Phase 1, additive, plus gated-view hardening).
4. **Seed `app_members`**: insert the admin row(s) (your emails) as `approved`; approve
   others as they sign in and request. Optionally backfill the 52 directory people once
   you have their emails (which sign-in itself will collect).
5. Flip the gate flag on in the app once 1–4 are done.

## Phasing

- **Phase 1 (now)**: additive data model + client auth core + main/preload wiring +
  gate UI (flag-off) + this doc. Nothing destructive; safe to ship.
- **Phase 2**: swap write paths (`supabase-anon-write.postAnonRow`, `cohort-emit`,
  `self-report`, `context-submit`) to send the user JWT; enforce the authenticated RLS;
  flip the gate on.
- **Phase 3**: revoke the anon INSERT policies + tighten the auto-approve trigger to the
  JWT-derived `is_self`; retire the `claim_token` model.

## Open decisions (defaults chosen; change if wanted)

- Binding UX: on first approved sign-in, if the email isn't yet bound to a `record_id`,
  the app asks the user to pick their cohort record once, then stores it server-side.
  (We have no emails on file, so auto-match is impossible on day one.)
- Admin approvals: for now, approve via SQL / a small admin view. A first-class in-app
  admin queue is a later add.

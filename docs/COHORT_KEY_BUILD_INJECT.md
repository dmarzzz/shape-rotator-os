# Baking the cohort key into a release (T2 evidence for all app users)

The app reads two tiers of transcript evidence live from Supabase:

- **T3 (public)** — person-anonymized cards, read with the baked **anon** key. These
  already show for everyone, in the app and on the public web.
- **T2 (cohort)** — the gated `cohort_app_transcript_evidence_cards` view, read with a
  **`role=cohort_app` JWT**. This is deliberately *not* in source, because the repo is
  public — a committed key would put T2 on the open web.

This doc is how that cohort key reaches a build so **every install reads T2 with no
per-user setup** — the "bake into the build" path.

## How it flows

```
SRFG_COHORT_KEY (build env)
  └─ beforePack hook  → apps/os/build-resources/cohort-app-key.json   (gitignored)
       └─ electron-builder extraResources → Resources/cohort-app-key.json (in the app)
            └─ main.js reads it → ipcMain "cohort-key:get" (sync)
                 └─ preload exposes window.api.cohortKey
                      └─ supabase-evidence.mjs DEFAULT_COHORT_KEY → gated T2 read
```

The key never enters git: `apps/os/build-resources/cohort-app-key.json` is gitignored and
re-written on every packaged build. An **un-provisioned build** (no `SRFG_COHORT_KEY`) ships
an empty file, so the cohort read no-ops and the app falls back to the anon T3 read.

> ⚠️ **Soft gate.** A key inside a distributed binary is extractable, so this keeps T2
> *off the public web*, not behind a hard wall. Revoke by dropping the `cohort_app`
> grant/role server-side. Mint the JWT long-lived (far-future `exp`) or T2 reads silently
> stop when it expires. If a key is leaked/extracted, **rotate**: drop the grant, then
> re-mint a fresh JWT and cut a new build — don't treat expiry as revocation.

## Prerequisites (one-time, cohort DB `txjntzwksiluvqcpccpc`)

1. Deploy migration `20260618000000_cohort_app_evidence_reader.sql` (creates the
   `cohort_app` role + the gated view). Needs the cohort-Supabase login.
   *(As of 2026-06-21 this is already live: the `cohort_app` role + the gated views
   `cohort_app_transcript_evidence_cards` (206 rows), `cohort_app_transcript_distillations`
   (23), and `cohort_app_cohort_insight_cards` (4 collaboration_contribution) exist and grant
   SELECT to `cohort_app`.)*
2. Mint a JWT with `role: cohort_app`, signed with the project JWT secret, long-lived.

## Mint + verify the key (reproducible)

Put the project's **JWT secret** (Supabase dashboard → Settings → API → JWT Secret) in
your gitignored env (e.g. `.env.calendar.local`, beside the `SUPABASE_*` values already
there) as `SUPABASE_JWT_SECRET`, then:

```sh
npm run keys:cohort:mint   -- --env-file .env.calendar.local   # writes the gitignored baked key
npm run keys:cohort:verify -- --env-file .env.calendar.local   # proves it reads all 3 gated views
npm run keys:cohort:package-check -- --env-file .env.calendar.local   # checks the baked package file, no token output
npm run transcripts:receive:check -- --env-file .env.calendar.local --require-gated
```

`mint` writes `apps/os/build-resources/cohort-app-key.json` (gitignored; the signing secret
is never written or printed). `verify` hits the gated views with the key exactly as the app
does (`apikey: anon`, `Authorization: Bearer <cohortKey>`) and reports row counts — a PASS
means T2 is reachable. The pure signing/inspection logic lives in
`scripts/lib/cohort-key.mjs` (unit-tested: `npm run test:cohort-key`).
`package-check` is a local release-readiness check: it decodes claims such as role, ref,
and expiry from the gitignored baked file, but never prints the JWT. An empty baked file is
expected for unprovisioned builds and can be reported with `--allow-empty`; a T2 release
should pass without `--allow-empty`.
`transcripts:receive:check` is the full app receive-route doctor: it proves the public T3
reader, the gated T2 evidence/distillation/insight readers, the packaged-key status, and
the optional service-role privacy audit without printing keys or row text.

## Cut a provisioned release

```sh
# from the repo root, with the minted JWT in the environment
export SRFG_COHORT_KEY='<role=cohort_app JWT>'
npm --workspace @shape-rotator/os run dist:mac     # or dist:win / dist:linux / dist:all
```

`beforePack` bakes the key; the rest of the chain is automatic. Verify in the packaged app:
open the Context page → the cohort (T2) evidence appears; with no key it stays on T3.

## Per-install alternative (no release needed)

`readSupabaseConfig` also honors a `supabaseCohortKey` field in the app's Supabase config
blob (`localStorage` key `srfg:calendar_ingress_config`). Setting it there lights up T2 for
that one install — useful for testing before cutting a build. Per-install config always
overrides the baked default.

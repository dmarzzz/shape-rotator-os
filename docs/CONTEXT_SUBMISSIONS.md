# Context submissions — user-contributed context inbox

Lets any cohort user paste a **transcript or note** on the Context page and send
it to Supabase for downstream distillation. This is the first surface in the app
that pushes **raw user text to the server**, so it is deliberately built as the
*inverse* of every other anon Supabase surface.

## Surface

Context page → **transcripts** view (the Context Vault `raw` mode). The "add
context" composer is collapsed by default, pinned under the page header. Fields:

| field   | required | notes |
|---------|----------|-------|
| kind    | yes (defaults to `note`) | `transcript · note · doc · link · audio · video · other` |
| title   | no | ≤ 300 chars |
| context | yes | the raw text, 1–200 000 chars |
| contact | no | optional `@handle`/email so the engine can follow up |

## Data flow

```
composer (alchemy.js renderContextComposer / submitContextCompose)
  → submitContext()                         apps/os/src/renderer/context-submit.mjs
  → POST /rest/v1/context_submissions        anon key, Prefer: return=minimal
  → public.context_submissions               private, insert-only (RLS)
  → [distillation engine — separate backend] reads pending queue, marks processed
```

The renderer talks to PostgREST directly with the embedded **anon key** (same
config as the calendar/evidence reads, via `readSupabaseConfig`). It sends
`Prefer: return=minimal` because anon has **no SELECT grant** — a default
`return=representation` insert would try to read the new row back and 401.

## Security boundary (the whole point)

`supabase/migrations/20260618120000_context_submissions.sql` — the checked-in,
reviewable source of the boundary. This repo is public and ships the anon key, so
RLS + grants *are* the security model:

- **anon / authenticated** → `INSERT` only, and only a row that passes the
  `WITH CHECK` policy: `processing_status = 'pending'`, `org_id = 'srfg'`, bounded
  body/title length, known `source_kind`.
- **anon / authenticated** → **no** select/update/delete (no policy, no grant) —
  a submitter cannot read back, edit, or delete any row, theirs or anyone's.
- **service_role** (the engine) → full access; reads the pending queue + marks
  rows processed.
- The table is **never** wrapped in a `public_*` view. Boundary is asserted by
  `scripts/context-submissions-supabase.test.mjs`.

Table `CHECK` constraints duplicate the length/kind/status limits so they hold
for every role, independent of RLS.

## Deploy (action required)

The migration is **not yet applied** to the live cohort project. Until it is, the
composer surfaces a graceful inline error and no data is written.

- Target project: **`txjntzwksiluvqcpccpc`** (the cohort project — *not* the
  web3-jobs project the headless Supabase MCP is pointed at).
- Apply via the cohort project's authenticated path (plugin-supabase OAuth, or
  `supabase db push` against that project), then submit one row from the app to
  confirm a `201` + a pending row visible to the service role.

## Out of scope (separate backend)

The actual **processing / distillation** of submitted context (turning a pasted
transcript into evidence cards) is the engine's job and is intentionally not in
this repo. This feature only lands the raw submission safely in the gated queue.

## Follow-ups

- Anon rate-limiting is not enforced in Postgres RLS (only a length cap). Add a
  per-`client_id` / per-IP throttle at the gateway or a `pg_cron` sweep if abuse
  appears.
- When a real member auth session lands, switch the insert to the signed-in token
  for attribution (the table already carries `client_id` for anon dedup/triage).

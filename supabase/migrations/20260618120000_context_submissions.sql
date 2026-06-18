-- context_submissions — the PRIVATE inbox for user-submitted context.
--
-- The Context page ("transcripts" view) lets any cohort user paste a transcript
-- or note and send it to Supabase for downstream distillation. Unlike every
-- other anon Supabase surface in this app, this table accepts RAW user text on
-- the server, so it is the deliberate INVERSE of the public_* projections:
--   * the public_* views are SELECT-only and curated (anon reads, never writes)
--   * this table is INSERT-only and raw (anon writes, never reads)
-- Nothing here is ever exposed through a public_* view; only the service role
-- (the distillation engine) and org owners read it back.
--
-- This repo is PUBLIC and ships the anon key, so RLS + grants are the ENTIRE
-- security boundary. This file is the checked-in, reviewable source of that
-- boundary (apply to the live project txjntzwksiluvqcpccpc to match). Boundary:
--   * anon / authenticated  -> INSERT only, and only a row that passes the
--                              WITH CHECK policy (pending status, this org,
--                              bounded length, known source kind)
--   * anon / authenticated  -> NO select/update/delete (no such policy exists,
--                              and no SELECT grant => no read-back of any row)
--   * service_role          -> full access (engine reads the queue + marks rows
--                              processed; writes bypass RLS)

create extension if not exists pgcrypto;

create table if not exists public.context_submissions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             text not null default 'srfg',
  source_kind        text not null default 'note',
  title              text,
  body               text not null,
  contact            text,
  client_id          text,
  app_version        text,
  metadata           jsonb not null default '{}'::jsonb,
  processing_status  text not null default 'pending',
  submitted_at       timestamptz not null default now(),

  -- Defense in depth: these table CHECKs hold for EVERY role (including the
  -- service role) and independently of the RLS policy below. A submission that
  -- violates them is rejected even if a future policy is loosened.
  constraint context_submissions_body_len
    check (char_length(body) between 1 and 200000),
  constraint context_submissions_title_len
    check (title is null or char_length(title) <= 300),
  constraint context_submissions_contact_len
    check (contact is null or char_length(contact) <= 200),
  constraint context_submissions_kind_allowed
    check (source_kind in ('transcript', 'note', 'doc', 'link', 'audio', 'video', 'other')),
  constraint context_submissions_status_allowed
    check (processing_status in ('pending', 'processing', 'processed', 'rejected'))
);

-- Engine queue scan: pending rows, oldest first. Partial index keeps it tiny
-- once rows are marked processed.
create index if not exists context_submissions_pending_idx
  on public.context_submissions (submitted_at)
  where processing_status = 'pending';

alter table public.context_submissions enable row level security;

-- Explicit grants: start from zero, then hand anon/authenticated INSERT ONLY.
-- No SELECT/UPDATE/DELETE grant => no read-back, no edits over the public API.
-- service_role gets the verbs the engine needs (its writes bypass RLS anyway,
-- but PostgREST still requires the grant).
revoke all on public.context_submissions from anon, authenticated;
grant insert on public.context_submissions to anon, authenticated;
grant select, insert, update on public.context_submissions to service_role;

-- INSERT policy. The WITH CHECK clause is the gate every anon insert must pass:
-- a fresh PENDING submission for this org, with a bounded body/title and a known
-- source kind. anon cannot pre-set a processed/rejected status (which would let
-- a submission skip review) or spoof a different org. Length is also a table
-- CHECK; duplicated here so the policy rejects an oversize body before the
-- row-level constraint, keeping the failure on the security boundary.
drop policy if exists "anon submit context" on public.context_submissions;
create policy "anon submit context"
  on public.context_submissions
  for insert
  to anon, authenticated
  with check (
    processing_status = 'pending'
    and org_id = 'srfg'
    and char_length(body) between 1 and 200000
    and (title is null or char_length(title) <= 300)
    and source_kind in ('transcript', 'note', 'doc', 'link', 'audio', 'video', 'other')
  );

-- NB: NO select/update/delete policy is defined. With RLS enabled and no
-- permissive policy for those commands, anon/authenticated are denied them
-- outright — a submitter cannot read back, edit, or remove any row (theirs or
-- anyone else's). This table must NEVER be wrapped in a public_* view.

comment on table public.context_submissions is
  'Private inbox for user-submitted context (transcripts/notes) from the OS Context page. anon INSERT-only; never exposed via any public_* view. Service role / distillation engine reads the pending queue and marks rows processed.';

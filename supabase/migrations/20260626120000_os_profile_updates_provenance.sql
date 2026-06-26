-- os_profile_updates — provenance + identity-field whitelist extension.
--
-- Builds on 20260625010000_os_profile_updates.sql. SAME anon WRITE-ONLY,
-- operator-approved model: every proposal lands status='pending' (status is not
-- in the anon grant); an operator / the Engine promotes pending→approved→applied.
-- The table is append-only, so the full version history is inherent — every
-- proposal is a row, "current" is the newest approved row per record_id, and a
-- prior state is just an older row. This is what lets "lots of updates + previous
-- saved states" hold without a separate history table.
--
-- This migration adds the two things the agentic "Your Mirror" needs:
--
--   1. PROVENANCE (edit-others, checkable). Today the inbox implicitly assumes a
--      member proposes for THEMSELVES. To let the agent propose an update to ANY
--      member's profile while keeping it safe, we record WHO proposed it:
--        - proposer_record_id  — the claimer's record_id (nullable: anon).
--        - proposer_claim_hash — sha-256 of their device-local claim-token, the
--          trust signal (recorded now, server-enforced later — mirrors
--          cohort_events.claim_token_hash; the read view never exposes it).
--        - is_self — GENERATED, tamper-evident: the client supplies the two ids,
--          not the flag. A third-party proposal (is_self=false) is the explicit
--          "this is from someone else — check it" signal operators triage before
--          approving. Nothing here ever auto-applies; approval + public visibility
--          (the cohort_events feed) is what makes "anyone may propose about anyone"
--          safe at 20–50-member scale, exactly as the direct-self-edit safety net
--          does (docs/two-way-contribution-layer.md).
--
--   2. WHITELIST extension (the three identity-location fields the agent keeps
--      current). delta may now ALSO carry `geo` (physical location string) and
--      `links` (object, SCOPED to github + repo only). The seven self-declared
--      fields from the prior migration still pass unchanged. A CHECK cannot run a
--      subquery (Postgres 0A000), so the top-level set is validated by key
--      subtraction and `links` is sub-scoped with a second CHECK.
--
-- Idempotent (add column if not exists / drop+recreate constraints + views), so it
-- can be applied directly to the Supabase project or reconciled into the canonical
-- Engine migration path later — like os_feedback / os_spheres / os_profile_updates.

-- ── 1. provenance columns ────────────────────────────────────────────────────
alter table public.os_profile_updates
  add column if not exists proposer_record_id text,
  add column if not exists proposer_claim_hash text;

do $$ begin
  alter table public.os_profile_updates
    add constraint os_profile_updates_proposer_record_len
      check (proposer_record_id is null or char_length(proposer_record_id) <= 128);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.os_profile_updates
    add constraint os_profile_updates_proposer_hash_len
      check (proposer_claim_hash is null or char_length(proposer_claim_hash) <= 128);
exception when duplicate_object then null; end $$;

-- is_self: derived from the row's own two ids (a STORED generated column may
-- reference sibling columns). A null proposer ⇒ unknown ⇒ NOT self (review-safe).
alter table public.os_profile_updates
  add column if not exists is_self boolean
    generated always as (
      proposer_record_id is not null and proposer_record_id = record_id
    ) stored;

-- Operator triage: the pending third-party proposals that need the closest look.
create index if not exists os_profile_updates_thirdparty_idx
  on public.os_profile_updates (status, created_at desc)
  where is_self = false;

-- ── 2. whitelist extension (geo + links{github,repo}) ────────────────────────
alter table public.os_profile_updates
  drop constraint if exists os_profile_updates_delta_whitelist;
alter table public.os_profile_updates
  add constraint os_profile_updates_delta_whitelist check (
    (delta - array[
      'now', 'weekly_intention', 'skills', 'skill_areas', 'seeking', 'offering',
      'prior_work', 'geo', 'links'
    ]::text[]) = '{}'::jsonb
  );

-- `links`, when present, must be an object carrying ONLY github / repo. (The other
-- link fields — x, website, linkedin, demo, deck — stay PR/editor-only for now;
-- the agent path is scoped to the GitHub "location" the user asked for.)
do $$ begin
  alter table public.os_profile_updates
    add constraint os_profile_updates_delta_links_scope check (
      not (delta ? 'links')
      or (
        jsonb_typeof(delta -> 'links') = 'object'
        and ((delta -> 'links') - array['github', 'repo']::text[]) = '{}'::jsonb
      )
    );
exception when duplicate_object then null; end $$;

-- ── 3. widen the anon write grant to carry provenance ────────────────────────
-- status stays UNGRANTED (⇒ always defaults 'pending'); id / created_at /
-- reviewed_at / is_self stay server-assigned. Only the proposer columns are added.
grant insert (
  record_id, delta, question, answer, source_kinds, app_version, platform,
  proposer_record_id, proposer_claim_hash
) on public.os_profile_updates to anon;

-- ── 4. read-back views ───────────────────────────────────────────────────────
-- Approved overlay: now also exposes who proposed it + is_self (the feed already
-- exposes `actor`, so surfacing proposer here is consistent). The claim HASH is
-- never exposed. Backward-compatible: existing readers select named columns.
drop view if exists public.app_profile_updates;
create view public.app_profile_updates
  with (security_barrier = true) as
  select record_id, delta, proposer_record_id, is_self, created_at, reviewed_at
  from public.os_profile_updates
  where status = 'approved';
grant select on public.app_profile_updates to anon, authenticated;

-- Version history: the prior ACCEPTED states (approved + applied), newest-first.
-- Pending rows are deliberately NOT exposed (they carry member-claimed text before
-- review — same privacy stance as the original inbox). This backs a per-profile
-- "history" view in the app without leaking the unreviewed queue.
drop view if exists public.app_profile_update_history;
create view public.app_profile_update_history
  with (security_barrier = true) as
  select record_id, delta, proposer_record_id, is_self, status, created_at, reviewed_at
  from public.os_profile_updates
  where status in ('approved', 'applied')
  order by record_id, created_at desc;
grant select on public.app_profile_update_history to anon, authenticated;

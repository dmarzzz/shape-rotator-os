-- Match the live Supabase migration history for the evidence-card trigger
-- function hardening applied on 2026-06-14.
--
-- Fresh databases also get this revoke from
-- 20260614025719_transcript_evidence_operations.sql because that base
-- migration was updated after the live patch. Keeping this idempotent
-- migration preserves repo/live schema_migrations parity.

revoke all on function public.enforce_t3_evidence_card_boundary() from public, anon, authenticated;

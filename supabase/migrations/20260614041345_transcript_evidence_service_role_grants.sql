-- Grant fix for migration 20260614025719_transcript_evidence_operations.sql.
--
-- That migration created public.evidence_cards and public.private_invite_contacts
-- but the standard Supabase "grant all on tables to service_role" default
-- privileges did not propagate to these tables (only the structural
-- REFERENCES / TRIGGER / TRUNCATE privileges landed). As a result the
-- transcript worker and the anonymized evidence export -- both of which
-- authenticate as service_role -- hit `42501 permission denied for table
-- evidence_cards` on every write.
--
-- service_role carries BYPASSRLS, so granting DML here is safe: the
-- coordinator-only RLS policies still gate every other role, anon /
-- authenticated continue to read exclusively through the gated views
-- (app_transcript_evidence_cards, public_transcript_evidence_cards), and the
-- T3 boundary trigger still vets every insert/update for private markers.
--
-- Idempotent: re-running these grants is a harmless no-op. This migration
-- documents in-repo what was applied live on 2026-06-14
-- (schema_migrations version 20260614041345).

grant select, insert, update, delete on public.evidence_cards to service_role;
grant select, insert, update, delete on public.private_invite_contacts to service_role;

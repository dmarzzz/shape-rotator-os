-- Drop calendar_event_mirrors.
--
-- The guest-calendar mirror worker (scripts/mirror-google-calendar-events.js)
-- has been removed in favor of a single shared cohort calendar: admins edit it
-- directly and cohort members subscribe read-only. That worker was the only
-- writer/reader of this table — it tracked the pairing between a source admin
-- event and its stripped public "guest mirror" copy. With the worker gone the
-- table is dead bookkeeping.
--
-- No CREATE migration for this table exists in-repo (it was created out of
-- band), so the drop is guarded: it is a no-op if the table is already absent.
--
-- BEFORE APPLYING: confirm no out-of-band scheduler (e.g. a Supabase Cron job
-- or another host) still runs `calendar:mirror:google` against this table or
-- the now-deprecated guest calendar. A stray mirror run after the cutover could
-- recreate conflicting guest events.

do $$
begin
  if to_regclass('public.calendar_event_mirrors') is not null then
    drop table public.calendar_event_mirrors cascade;
  end if;
end
$$;

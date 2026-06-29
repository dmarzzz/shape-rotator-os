-- cohort_events - add the `ask` event type.
--
-- Asks move from the GitHub-PR markdown path (cohort-data/asks/*.md) onto the
-- append-only cohort_events spine, so posting / claiming / joining / completing an
-- ask is an instant anon write (apps/os/src/renderer/cohort-emit.mjs emitAsk*),
-- read back through app_cohort_feed and reduced to current state on-device
-- (apps/os/src/renderer/asks-events.mjs reduceAsks). This mirrors how profile_edit /
-- transcript / contest / self_report already work - one shape, "a member added
-- something" - and keeps the no-anon-UPDATE invariant: a claim/join/done is a NEW
-- appended row, never a mutation, folded over the original `post` row by record_id.
--
-- An ask carries record_id = the ask's id (its own timeline), actor = the member who
-- performed the action, value.action in {post,edit,claim,join,done,cancel}. No new
-- columns or grants - asks reuse the existing anon INSERT grant + write-only policy;
-- this migration only widens the event_type allow-list (table CHECK + policy CHECK).
-- The app_cohort_feed read view passes every type through (recency + supersede filter
-- only), so ask events read back with no view change.

-- 1) Widen the table-level event_type CHECK.
alter table public.cohort_events
  drop constraint if exists cohort_events_event_type_check;
alter table public.cohort_events
  add constraint cohort_events_event_type_check
  check (event_type in ('profile_edit', 'transcript', 'contest',
                        'self_report', 'connection', 'prefs', 'ask'));

-- 2) Re-assert the same allow-list in the anon INSERT policy (WITH CHECK), so the
--    write-only policy stays self-contained. Identical to the original policy plus
--    'ask'. (supersedes still forced NULL - revert remains operator-only.)
drop policy if exists "anon append cohort event" on public.cohort_events;
create policy "anon append cohort event"
  on public.cohort_events
  for insert
  to anon
  with check (
    char_length(record_id) between 1 and 128
    and event_type in ('profile_edit', 'transcript', 'contest', 'self_report', 'connection', 'prefs', 'ask')
    and weight in ('loud', 'medium', 'quiet')
    and jsonb_typeof(value) = 'object'
    and pg_column_size(value) <= 8000
    and (actor is null or char_length(actor) <= 128)
    and (field is null or char_length(field) <= 128)
    and (claim_token_hash is null or char_length(claim_token_hash) <= 128)
    and (app_version is null or char_length(app_version) <= 64)
    and (platform    is null or char_length(platform)    <= 64)
    and supersedes is null
  );

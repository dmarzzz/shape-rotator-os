-- os_profile_updates — auto-approve SELF edits (proposer == subject) at insert.
--
-- For the launch phase we drop the operator pre-approval for a member's OWN
-- updates: a self-edit applies immediately. A proposal about SOMEONE ELSE
-- (is_self=false) or an unattributed row still lands 'pending' for the daily
-- recompute / Engine review (os_profile_updates_thirdparty_idx finds them).
--
-- Why this is safe enough at 20–50-member scale: the delta whitelist CHECK still
-- guarantees a row "fits in the spots" before it can auto-approve; every applied
-- change also emits a cohort_events feed signal (visibility); and the daily
-- recompute reconciles. claim_token_hash is recorded but not yet server-enforced,
-- so pre-approval was never a real security boundary here anyway — whitelist +
-- visibility + daily recompute are. To revert to review-everything, drop the
-- trigger (the policy change is harmless on its own).

create or replace function public.os_profile_updates_autoapprove()
returns trigger language plpgsql as $fn$
begin
  -- A member updating their OWN record (proposer == subject) auto-approves;
  -- anything about someone else, or an unattributed/anon row, stays 'pending'.
  if new.proposer_record_id is not null and new.proposer_record_id = new.record_id then
    new.status := 'approved';
    new.reviewed_at := now();
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_os_profile_updates_autoapprove on public.os_profile_updates;
create trigger trg_os_profile_updates_autoapprove
  before insert on public.os_profile_updates
  for each row execute function public.os_profile_updates_autoapprove();

-- RLS WITH CHECK runs AFTER before-triggers, so the policy must now permit the
-- trigger-produced 'approved'. status is still NOT in the anon column grant, so a
-- CLIENT still cannot choose it — only the trigger can, from the row's own ids.
drop policy if exists "anon submit profile update" on public.os_profile_updates;
create policy "anon submit profile update"
  on public.os_profile_updates
  for insert
  to anon
  with check (
    char_length(record_id) between 1 and 128
    and jsonb_typeof(delta) = 'object'
    and pg_column_size(delta) <= 8000
    and status in ('pending', 'approved')
  );

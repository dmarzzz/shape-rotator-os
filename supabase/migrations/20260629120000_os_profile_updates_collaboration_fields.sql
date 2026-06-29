-- os_profile_updates -- richer self-report collaboration fields.
--
-- Builds on 20260628143000_os_profile_updates_team_subjects.sql.
-- The app now lets a member-approved self-report refresh more of the public
-- person collaboration surface, while preserving the existing split:
--   - person self-edits may auto-approve
--   - team/project evidence remains pending operator review

alter table public.os_profile_updates
  drop constraint if exists os_profile_updates_delta_whitelist;
alter table public.os_profile_updates
  add constraint os_profile_updates_delta_whitelist check (
    (
      record_type = 'person'
      and (delta - array[
        'comm_style', 'contribute_interests',
        'now', 'weekly_intention', 'availability_pref',
        'skills', 'skill_areas', 'seeking', 'offering',
        'go_to_them_for', 'recurring_themes', 'working_style', 'best_contexts',
        'prior_work', 'geo', 'links'
      ]::text[]) = '{}'::jsonb
    )
    or (
      record_type = 'team'
      and (delta - array[
        'journey', 'traction', 'prior_shipping', 'success_dimensions'
      ]::text[]) = '{}'::jsonb
    )
  );

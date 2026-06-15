-- Track derived guest-calendar events for canonical admin Google Calendar events.
--
-- The admin calendar remains the source of truth and owns Google Meet /
-- transcript artifacts. Guest-calendar events are safe mirrors: same public
-- time/title/join link, but no attendees, conference ownership, attachments, or
-- transcript access surface.

create table if not exists public.calendar_event_mirrors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  source_session_id uuid references public.sessions(id) on delete set null,
  source_google_calendar_id text,
  source_google_event_id text not null,
  source_google_etag text,
  mirror_calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  mirror_google_calendar_id text not null,
  mirror_google_event_id text,
  mirror_google_etag text,
  mirror_google_html_link text,
  mirror_status text not null default 'pending' check (mirror_status in ('pending', 'active', 'cancelled', 'error')),
  last_mirrored_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_calendar_connection_id, source_google_event_id, mirror_calendar_connection_id)
);

alter table public.calendar_event_mirrors enable row level security;

create policy "coordinators read calendar event mirrors"
on public.calendar_event_mirrors for select
using (public.is_org_coordinator(org_id));

create policy "admins manage calendar event mirrors"
on public.calendar_event_mirrors for all
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create index if not exists calendar_event_mirrors_org_source_idx
on public.calendar_event_mirrors (org_id, source_calendar_connection_id, source_google_event_id);

create index if not exists calendar_event_mirrors_mirror_idx
on public.calendar_event_mirrors (mirror_calendar_connection_id, mirror_google_event_id);

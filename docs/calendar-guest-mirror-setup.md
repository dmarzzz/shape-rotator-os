# Guest Calendar Mirror Setup

Shape Rotator uses two Google Calendars:

- Admin calendar: canonical source of truth. Owns Google Meet creation, Meet
  artifact settings, and Drive transcript handling.
- Guest calendar: derived mirror. Carries the same public title/time and Meet
  join URL, but no attendees, conference ownership, attachments, or transcript
  access surface.

## Required Google Calendars

1. Create or keep the existing admin calendar, for example `Shape Rotator OS`.
2. Create a second Google Calendar, for example `Shape Rotator Guest Schedule`.
3. Share the admin calendar with admins as `writer` or `owner`.
4. Share the guest calendar publicly/read-only or to the intended subscriber
   audience.
5. Do not invite general guests to the admin event. Guest visibility comes from
   the guest calendar mirror or the app/public calendar feed.

Repeatable ACL commands:

```bash
npm run calendar:acl:google -- --env-file .env.calendar.local --calendar-id "$GOOGLE_CALENDAR_ID" --emails "$GOOGLE_CALENDAR_EDITOR_EMAILS" --role writer --apply --send-notifications
npm run calendar:acl:google -- --env-file .env.calendar.local --calendar-id "$GOOGLE_GUEST_CALENDAR_ID" --scope-type default --role reader --apply
```

The guest subscribe URL is:

```text
https://calendar.google.com/calendar/r?cid=<url-encoded GOOGLE_GUEST_CALENDAR_ID>
```

## Required Supabase Rows

Create two `calendar_connections` rows:

- Admin row: `calendar_id = GOOGLE_CALENDAR_ID`
- Guest row: `calendar_id = GOOGLE_GUEST_CALENDAR_ID`

Store the returned IDs in:

```bash
CALENDAR_CONNECTION_ID=...
GUEST_CALENDAR_CONNECTION_ID=...
GOOGLE_CALENDAR_ID=...
GOOGLE_GUEST_CALENDAR_ID=...
SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL=...
```

Apply the migration that creates `public.calendar_event_mirrors` before running
the mirror worker.

## Mirror Worker

Dry-run:

```bash
npm run calendar:mirror:google -- --env-file .env.calendar.local
```

Apply:

```bash
npm run calendar:mirror:google -- --env-file .env.calendar.local --apply
```

The worker reads admin sessions from Supabase and writes guest Google Calendar
events. For each admin event it records the guest event ID in
`calendar_event_mirrors`.

Before the mirror migration is deployed, the worker can still populate the guest
calendar with deterministic event IDs:

```bash
npm run calendar:mirror:google -- --env-file .env.calendar.local --apply --stateless-if-missing
```

Stateless mode is an interim compatibility path. The preferred production mode
is the tracked `calendar_event_mirrors` table.

## Update Flow

1. Admin edits the admin Google Calendar.
2. The scheduled reconciliation workflow ensures future timed events have a
   Google Meet link, the capture bot attendee, and Meet transcription set to
   auto-generate.
3. Google Calendar sync imports the change into `sessions`.
4. `calendar:mirror:google --apply` updates the guest calendar.
5. Drive/Meet transcript workers continue to use the admin event/Meet artifacts.

The guest event contains the Meet URL as plain text/location. It never creates
or owns the Meet conference.

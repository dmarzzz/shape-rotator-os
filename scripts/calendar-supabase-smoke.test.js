const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSmokeSession,
  evaluateSmokeEvidence,
  formatSmoke,
} = require("./smoke-calendar-supabase-sync.js");

test("calendar Supabase smoke session is a timed New York meeting", () => {
  const session = buildSmokeSession({ now: new Date("2026-06-13T12:00:00Z"), id: "11111111-1111-4111-8111-111111111111" });

  assert.equal(session.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(session.session_type, "office_hours");
  assert.equal(session.timezone, "America/New_York");
  assert.match(session.starts_at, /T/);
  assert.match(session.ends_at, /T/);
  assert.ok(new Date(session.ends_at) > new Date(session.starts_at));
});

test("calendar Supabase smoke evidence requires Google and Supabase sides", () => {
  const googleEvent = {
    id: "google_evt",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    attendees: [{ email: "cube@shaperotator.xyz" }],
  };
  const supabaseRow = {
    session: {
      id: "session_1",
      google_meet_url: "https://meet.google.com/abc-defg-hij",
      guests_can_modify: false,
      guests_can_invite_others: false,
    },
    attendees: [{ email: "cube@shaperotator.xyz", attendee_role: "bot" }],
  };

  assert.equal(evaluateSmokeEvidence({ googleEvent, supabaseRow }).ok, true);
  assert.equal(evaluateSmokeEvidence({ googleEvent, supabaseRow: null }).ok, false);
  assert.equal(evaluateSmokeEvidence({
    googleEvent,
    supabaseRow: { ...supabaseRow, attendees: [] },
  }).supabase_bot_attendee, false);
});

test("calendar Supabase smoke formatter reports every proof bit", () => {
  const text = formatSmoke({
    ok: true,
    kept: false,
    smoke_session_id: "session_1",
    evidence: {
      google_event_id: "google_evt",
      google_has_meet: true,
      google_bot_attendee: true,
      google_guest_edit_locked: true,
      supabase_session_seen: true,
      supabase_has_meet: true,
      supabase_bot_attendee: true,
      supabase_guest_edit_locked: true,
    },
    supabase_poll: { attempts: 2 },
    cleanup: { google_event_deleted: true },
  });

  assert.match(text, /Result: pass/);
  assert.match(text, /Google Meet present: true/);
  assert.match(text, /Supabase session seen: true/);
  assert.match(text, /Cleanup:/);
});

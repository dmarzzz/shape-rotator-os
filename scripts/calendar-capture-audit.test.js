const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCaptureAudit,
  formatAudit,
  isTimedSession,
} = require("./audit-calendar-capture.js");

const NOW = new Date("2026-06-13T12:00:00Z");

function session(overrides = {}) {
  return {
    id: overrides.id || "session_1",
    title: overrides.title || "Office hours",
    status: "scheduled",
    starts_at: "2026-06-16T16:00:00-04:00",
    ends_at: "2026-06-16T17:00:00-04:00",
    session_type: "office_hours",
    google_meet_url: "https://meet.google.com/abc-defg-hij",
    guests_can_modify: false,
    guests_can_invite_others: false,
    ...overrides,
  };
}

test("timed-session detection ignores all-day calendar blocks", () => {
  assert.equal(isTimedSession(session()), true);
  assert.equal(isTimedSession(session({ starts_at: "2026-06-16", ends_at: "2026-06-17" })), false);
  assert.equal(isTimedSession(session({ starts_at: "2026-06-16T00:00:00+00:00", ends_at: "2026-06-17T00:00:00+00:00" })), false);
  assert.equal(isTimedSession(session({ starts_at: "2026-06-16T00:00:00+00:00", ends_at: "2026-06-16T01:00:00+00:00" })), true);
});

test("capture audit marks future timed Meet sessions ready when Cube is covered and guests are locked", () => {
  const audit = buildCaptureAudit({
    now: NOW,
    botEmail: "cube@shaperotator.xyz",
    sessions: [session()],
    attendees: [{ session_id: "session_1", email: "cube@shaperotator.xyz", attendee_role: "bot" }],
  });

  assert.equal(audit.counts.future_timed_sessions, 1);
  assert.equal(audit.counts.capture_ready_future_timed_sessions, 1);
  assert.equal(audit.counts.missing_meet_future_timed_sessions, 0);
  assert.equal(audit.counts.missing_bot_future_timed_sessions, 0);
  assert.deepEqual(audit.failures, []);
});

test("capture audit distinguishes calendar coverage gaps from transcript artifact gaps", () => {
  const audit = buildCaptureAudit({
    now: NOW,
    botEmail: "cube@shaperotator.xyz",
    sessions: [
      session({ id: "missing_meet", title: "Missing Meet", google_meet_url: null, google_meeting_code: null }),
      session({ id: "missing_bot", title: "Missing Cube" }),
      session({ id: "guest_edit", title: "Guest editable", guests_can_modify: true }),
      session({ id: "ready", title: "Ready session" }),
      session({
        id: "past_no_artifact",
        title: "Past without artifact",
        starts_at: "2026-06-10T16:00:00-04:00",
        ends_at: "2026-06-10T17:00:00-04:00",
      }),
      session({
        id: "past_with_artifact",
        title: "Past with artifact",
        starts_at: "2026-06-10T18:00:00-04:00",
        ends_at: "2026-06-10T19:00:00-04:00",
      }),
    ],
    attendees: [
      { session_id: "missing_meet", email: "cube@shaperotator.xyz", attendee_role: "bot" },
      { session_id: "guest_edit", email: "cube@shaperotator.xyz", attendee_role: "bot" },
      { session_id: "ready", email: "cube@shaperotator.xyz", attendee_role: "bot" },
      { session_id: "past_no_artifact", email: "cube@shaperotator.xyz", attendee_role: "bot" },
      { session_id: "past_with_artifact", email: "cube@shaperotator.xyz", attendee_role: "bot" },
    ],
    captureArtifacts: [
      { session_id: "past_with_artifact", provider: "google_meet", artifact_kind: "transcript" },
    ],
  });

  assert.equal(audit.counts.future_timed_sessions, 4);
  assert.equal(audit.counts.capture_ready_future_timed_sessions, 1);
  assert.equal(audit.counts.missing_meet_future_timed_sessions, 1);
  assert.equal(audit.counts.missing_bot_future_timed_sessions, 1);
  assert.equal(audit.counts.guest_edit_violations, 1);
  assert.equal(audit.counts.sessions_with_transcript_artifacts, 1);
  assert.equal(audit.counts.issue_counts.past_timed_no_transcript_artifact, 1);
  assert.deepEqual(
    Object.fromEntries(audit.failures.map((item) => [item.id, item.issues])),
    {
      missing_meet: ["missing_meet"],
      missing_bot: ["missing_capture_bot"],
      guest_edit: ["guest_editable"],
      past_no_artifact: ["past_timed_no_transcript_artifact"],
    },
  );
});

test("capture audit treats Cube organizer coverage as sufficient for imported calendar rows", () => {
  const audit = buildCaptureAudit({
    now: NOW,
    botEmail: "cube@shaperotator.xyz",
    sessions: [session({ google_calendar_id: "cube@shaperotator.xyz" })],
    attendees: [],
  });

  assert.equal(audit.counts.capture_ready_future_timed_sessions, 1);
  assert.equal(audit.sessions[0].bot_organizer, true);
});

test("human formatter surfaces the audit counts and first failures", () => {
  const audit = buildCaptureAudit({
    now: NOW,
    sessions: [session({ id: "missing_meet", title: "Missing Meet", google_meet_url: null })],
    attendees: [],
  });
  const text = formatAudit(audit);

  assert.match(text, /Calendar capture audit/);
  assert.match(text, /Missing Meet/);
  assert.match(text, /missing_meet/);
  assert.match(text, /missing_capture_bot/);
});

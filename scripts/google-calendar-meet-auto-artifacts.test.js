const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MEET_SETTINGS_SCOPE,
} = require("./configure-meet-auto-artifacts.js");
const {
  buildMeetAutoArtifactCalendarPlan,
  isConfigurableEvent,
  runEnsureGoogleCalendarMeetAutoArtifacts,
} = require("./ensure-google-calendar-meet-auto-artifacts.js");

const NOW = new Date("2026-06-15T12:00:00Z");

function timed(overrides = {}) {
  return {
    id: overrides.id || "event_1",
    status: "confirmed",
    summary: overrides.summary || "Office hours",
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    ...overrides,
  };
}

function allDay(overrides = {}) {
  return {
    id: overrides.id || "all_day",
    status: "confirmed",
    summary: overrides.summary || "Build day",
    start: { date: "2026-06-16" },
    end: { date: "2026-06-17" },
    hangoutLink: "https://meet.google.com/xyz-abcd-qrs",
    ...overrides,
  };
}

test("Meet auto-artifact plan targets future timed events with Meet links", () => {
  const events = [
    timed({ id: "future_meet" }),
    timed({ id: "future_missing_meet", hangoutLink: null }),
    timed({
      id: "past_meet",
      start: { dateTime: "2026-06-10T16:00:00-04:00" },
      end: { dateTime: "2026-06-10T17:00:00-04:00" },
    }),
    allDay({ id: "future_all_day" }),
    timed({ id: "cancelled", status: "cancelled" }),
  ];

  const plan = buildMeetAutoArtifactCalendarPlan(events, { now: NOW });

  assert.equal(plan.counts.total_events, 5);
  assert.equal(plan.counts.future_timed_events, 2);
  assert.equal(plan.counts.future_events_with_meeting_code, 2);
  assert.equal(plan.counts.selected_for_patch, 1);
  assert.deepEqual(plan.actions.map((action) => action.google_event_id), ["future_meet"]);
  assert.equal(plan.request_body.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration, "ON");
  assert.equal(plan.request_body.config.artifactConfig.recordingConfig.autoRecordingGeneration, "OFF");
});

test("Meet auto-artifact plan can include all-day events explicitly", () => {
  const plan = buildMeetAutoArtifactCalendarPlan([allDay({ id: "all_day" })], {
    now: NOW,
    includeAllDay: true,
  });

  assert.equal(plan.selected.length, 1);
  assert.equal(plan.actions[0].google_event_id, "all_day");
});

test("configurability requires future, non-cancelled, selected-kind events with a parseable Meet code", () => {
  assert.equal(isConfigurableEvent(timed(), { now: NOW }), true);
  assert.equal(isConfigurableEvent(timed({ hangoutLink: null }), { now: NOW }), false);
  assert.equal(isConfigurableEvent(timed({ status: "cancelled" }), { now: NOW }), false);
  assert.equal(isConfigurableEvent(allDay(), { now: NOW }), false);
  assert.equal(isConfigurableEvent(allDay(), { now: NOW, includeAllDay: true }), true);
});

test("dry-run fixture mode does not call Google", async () => {
  const result = await runEnsureGoogleCalendarMeetAutoArtifacts({
    calendarId: "calendar@example.com",
    events: [timed({ id: "event_1" })],
    now: NOW,
    fetchImpl: async () => {
      throw new Error("fixture dry-run should not call fetch");
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.selected_for_patch, 1);
  assert.equal(result.configured, 0);
  assert.equal(result.actions[0].action, "would_configure");
});

test("apply gets each Meet space and patches transcript settings", async () => {
  const calls = [];
  const result = await runEnsureGoogleCalendarMeetAutoArtifacts({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    oauthScopes: MEET_SETTINGS_SCOPE,
    events: [timed({ id: "event_1" })],
    now: NOW,
    apply: true,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body, headers: options.headers });
      assert.equal(options.headers.authorization, "Bearer google-token");
      if ((options.method || "GET") === "GET") {
        assert.equal(parsed.pathname, "/v2/spaces/abc-defg-hij");
        return Response.json({ name: "spaces/space_1", meetingCode: "abc-defg-hij" });
      }
      assert.equal(options.method, "PATCH");
      assert.equal(parsed.searchParams.get("updateMask"), [
        "config.artifactConfig.recordingConfig.autoRecordingGeneration",
        "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
      ].join(","));
      assert.equal(body.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration, "ON");
      return Response.json({ name: "spaces/space_1", config: body.config });
    },
  });

  assert.equal(result.apply, true);
  assert.equal(result.configured, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.actions[0].action, "configured");
  assert.equal(result.actions[0].space_name, "spaces/space_1");
  assert.equal(calls.length, 2);
});

test("apply can skip cleanly when the Meet settings scope is absent", async () => {
  const result = await runEnsureGoogleCalendarMeetAutoArtifacts({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    oauthScopes: "https://www.googleapis.com/auth/calendar",
    events: [timed({ id: "event_1" })],
    now: NOW,
    apply: true,
    skipIfMissingScope: true,
  });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /meetings\.space\.settings/);
});

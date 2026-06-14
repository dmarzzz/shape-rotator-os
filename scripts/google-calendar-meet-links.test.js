const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEnsureMeetPlan,
  buildMeetPatchBody,
  googleEventPatchUrl,
  hasGoogleMeet,
  isPatchableEvent,
  runEnsureGoogleCalendarMeetLinks,
  stableConferenceRequestId,
} = require("./ensure-google-calendar-meet-links.js");

function timed(overrides = {}) {
  return {
    id: overrides.id || "event_1",
    status: "confirmed",
    summary: overrides.summary || "Office hours",
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    ...overrides,
  };
}

function allDay(overrides = {}) {
  return {
    id: overrides.id || "event_all_day",
    status: "confirmed",
    summary: overrides.summary || "Build day",
    start: { date: "2026-06-16" },
    end: { date: "2026-06-17" },
    ...overrides,
  };
}

test("Meet detection accepts hangoutLink or video conference entry", () => {
  assert.equal(hasGoogleMeet(timed({ hangoutLink: "https://meet.google.com/abc-defg-hij" })), true);
  assert.equal(hasGoogleMeet(timed({
    conferenceData: {
      entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-qrs" }],
    },
  })), true);
  assert.equal(hasGoogleMeet(timed()), false);
});

test("Meet plan targets timed missing-link events and skips all-day by default", () => {
  const events = [
    timed({ id: "needs_meet" }),
    timed({ id: "has_meet", hangoutLink: "https://meet.google.com/abc-defg-hij" }),
    allDay({ id: "all_day_missing" }),
    timed({ id: "cancelled", status: "cancelled" }),
  ];
  const plan = buildEnsureMeetPlan(events);

  assert.equal(plan.counts.total_events, 4);
  assert.equal(plan.counts.timed_events, 3);
  assert.equal(plan.counts.all_day_events, 1);
  assert.equal(plan.counts.events_with_meet, 1);
  assert.equal(plan.counts.missing_meet_timed_events, 1);
  assert.equal(plan.counts.skipped_all_day_missing_meet, 1);
  assert.deepEqual(plan.actions.map((action) => action.google_event_id), ["needs_meet"]);
});

test("Meet plan can include all-day events explicitly", () => {
  const plan = buildEnsureMeetPlan([timed({ id: "timed" }), allDay({ id: "all_day" })], {
    includeAllDay: true,
  });

  assert.equal(plan.selected.length, 2);
  assert.deepEqual(plan.actions.map((action) => action.google_event_id), ["timed", "all_day"]);
});

test("patch body uses stable conference request id", () => {
  const event = timed({ id: "stable_event", iCalUID: "stable@example.com" });
  const first = stableConferenceRequestId(event);
  const second = stableConferenceRequestId(event);
  const body = buildMeetPatchBody(event);

  assert.equal(first, second);
  assert.match(first, /^shape-meet-[a-f0-9]{24}$/);
  assert.equal(body.conferenceData.createRequest.requestId, first);
  assert.deepEqual(body.conferenceData.createRequest.conferenceSolutionKey, { type: "hangoutsMeet" });
});

test("Google patch URL requests conference data and suppresses invite email", () => {
  const url = googleEventPatchUrl("calendar@example.com", "event/id");

  assert.equal(url.searchParams.get("conferenceDataVersion"), "1");
  assert.equal(url.searchParams.get("sendUpdates"), "none");
  assert.match(String(url), /event%2Fid/);
});

test("patchability requires a non-cancelled missing-link timed event", () => {
  assert.equal(isPatchableEvent(timed()), true);
  assert.equal(isPatchableEvent(timed({ hangoutLink: "https://meet.google.com/abc-defg-hij" })), false);
  assert.equal(isPatchableEvent(timed({ status: "cancelled" })), false);
  assert.equal(isPatchableEvent(allDay()), false);
  assert.equal(isPatchableEvent(allDay(), { includeAllDay: true }), true);
});

test("dry-run fixture mode does not call Google", async () => {
  const result = await runEnsureGoogleCalendarMeetLinks({
    calendarId: "calendar@example.com",
    events: [timed({ id: "event_1" })],
    fetchImpl: async () => {
      throw new Error("fixture dry-run should not call fetch");
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.selected_for_patch, 1);
  assert.equal(result.patched, 0);
  assert.equal(result.actions[0].action, "would_patch");
});

test("apply patches selected events and reports returned Meet URL", async () => {
  const calls = [];
  const result = await runEnsureGoogleCalendarMeetLinks({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    events: [timed({ id: "event_1" })],
    apply: true,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body, headers: options.headers });
      assert.equal(options.headers.authorization, "Bearer google-token");
      assert.equal((options.method || "GET"), "PATCH");
      assert.equal(parsed.searchParams.get("conferenceDataVersion"), "1");
      assert.equal(parsed.searchParams.get("sendUpdates"), "none");
      assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
      return Response.json({
        id: "event_1",
        summary: "Office hours",
        start: { dateTime: "2026-06-16T16:00:00-04:00" },
        end: { dateTime: "2026-06-16T17:00:00-04:00" },
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      });
    },
  });

  assert.equal(result.apply, true);
  assert.equal(result.selected_for_patch, 1);
  assert.equal(result.patched, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.actions[0].action, "patched");
  assert.equal(result.actions[0].meet_url, "https://meet.google.com/abc-defg-hij");
  assert.equal(calls.length, 1);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEnsureCaptureBotPlan,
  eventWithCaptureBotBody,
  googleEventPatchUrl,
  hasBotCoverage,
  isPatchableEvent,
  runEnsureGoogleCalendarCaptureBot,
} = require("./ensure-google-calendar-capture-bot.js");

const NOW = new Date("2026-06-13T12:00:00Z");
const BOT = "cube@shaperotator.xyz";

function timed(overrides = {}) {
  return {
    id: overrides.id || "event_1",
    status: "confirmed",
    summary: overrides.summary || "Office hours",
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    attendees: [],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: true,
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
    attendees: [],
    ...overrides,
  };
}

test("capture bot detection accepts attendee or organizer coverage", () => {
  assert.equal(hasBotCoverage(timed({ attendees: [{ email: BOT }] }), BOT), true);
  assert.equal(hasBotCoverage(timed({ organizer: { email: BOT } }), BOT), true);
  assert.equal(hasBotCoverage(timed(), BOT), false);
});

test("capture bot plan targets only future timed gaps by default", () => {
  const events = [
    timed({ id: "future_missing" }),
    timed({ id: "future_ready", attendees: [{ email: BOT }] }),
    timed({ id: "future_editable", attendees: [{ email: BOT }], guestsCanModify: true }),
    timed({ id: "past_missing", start: { dateTime: "2026-06-10T16:00:00-04:00" }, end: { dateTime: "2026-06-10T17:00:00-04:00" } }),
    allDay({ id: "future_all_day" }),
  ];
  const plan = buildEnsureCaptureBotPlan(events, { botEmail: BOT, now: NOW });

  assert.equal(plan.counts.future_timed_events, 3);
  assert.equal(plan.counts.future_timed_bot_covered, 2);
  assert.equal(plan.counts.missing_bot_future_timed_events, 1);
  assert.equal(plan.counts.guest_edit_future_timed_events, 1);
  assert.deepEqual(plan.actions.map((action) => action.google_event_id), ["future_missing", "future_editable"]);
});

test("capture bot plan can include future all-day events explicitly", () => {
  const plan = buildEnsureCaptureBotPlan([allDay({ id: "all_day" })], {
    botEmail: BOT,
    now: NOW,
    includeAllDay: true,
  });

  assert.equal(plan.selected.length, 1);
  assert.equal(plan.actions[0].google_event_id, "all_day");
});

test("capture bot patch body preserves existing attendees and locks guest edits", () => {
  const body = eventWithCaptureBotBody(timed({
    attendees: [{ email: "guest@example.com", responseStatus: "accepted" }],
    guestsCanModify: true,
    guestsCanInviteOthers: true,
  }), { botEmail: BOT });

  assert.deepEqual(body.attendees.map((attendee) => attendee.email), ["guest@example.com", BOT]);
  assert.equal(body.guestsCanModify, false);
  assert.equal(body.guestsCanInviteOthers, false);
  assert.equal(body.guestsCanSeeOtherGuests, true);
});

test("patchability skips past, cancelled, all-day, and already-ready events", () => {
  assert.equal(isPatchableEvent(timed(), { botEmail: BOT, now: NOW }), true);
  assert.equal(isPatchableEvent(timed({ attendees: [{ email: BOT }] }), { botEmail: BOT, now: NOW }), false);
  assert.equal(isPatchableEvent(timed({ status: "cancelled" }), { botEmail: BOT, now: NOW }), false);
  assert.equal(isPatchableEvent(allDay(), { botEmail: BOT, now: NOW }), false);
  assert.equal(isPatchableEvent(allDay(), { botEmail: BOT, now: NOW, includeAllDay: true }), true);
});

test("Google patch URL suppresses calendar-update emails", () => {
  const url = googleEventPatchUrl("calendar@example.com", "event/id");

  assert.equal(url.searchParams.get("sendUpdates"), "none");
  assert.match(String(url), /event%2Fid/);
});

test("dry-run fixture mode does not call Google", async () => {
  const result = await runEnsureGoogleCalendarCaptureBot({
    calendarId: "calendar@example.com",
    botEmail: BOT,
    events: [timed({ id: "event_1" })],
    now: NOW,
    fetchImpl: async () => {
      throw new Error("fixture dry-run should not call fetch");
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.selected_for_patch, 1);
  assert.equal(result.actions[0].action, "would_patch");
});

test("apply patches selected events and reports bot coverage", async () => {
  const calls = [];
  const result = await runEnsureGoogleCalendarCaptureBot({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    botEmail: BOT,
    events: [timed({ id: "event_1" })],
    now: NOW,
    apply: true,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body, headers: options.headers });
      assert.equal(options.headers.authorization, "Bearer google-token");
      assert.equal((options.method || "GET"), "PATCH");
      assert.equal(parsed.searchParams.get("sendUpdates"), "none");
      assert.equal(body.attendees.at(-1).email, BOT);
      return Response.json({
        id: "event_1",
        summary: "Office hours",
        start: { dateTime: "2026-06-16T16:00:00-04:00" },
        end: { dateTime: "2026-06-16T17:00:00-04:00" },
        attendees: body.attendees,
        guestsCanModify: body.guestsCanModify,
        guestsCanInviteOthers: body.guestsCanInviteOthers,
        guestsCanSeeOtherGuests: body.guestsCanSeeOtherGuests,
      });
    },
  });

  assert.equal(result.apply, true);
  assert.equal(result.patched, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.actions[0].bot_covered, true);
  assert.equal(calls.length, 1);
});

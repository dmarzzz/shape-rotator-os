const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCalendarGoogleEventsExport } = require("./export-google-calendar-links.js");

function ev(overrides = {}) {
  return {
    id: "evt",
    htmlLink: "https://www.google.com/calendar/event?eid=x",
    iCalUID: "uid",
    summary: "Session",
    status: "confirmed",
    ...overrides,
  };
}

test("export drops explicitly-private/confidential + cancelled events, keeps default-visibility", () => {
  const out = buildCalendarGoogleEventsExport({
    calendarId: "cal",
    events: [
      ev({ id: "a", iCalUID: "ua", visibility: "default" }),
      ev({ id: "b", iCalUID: "ub" }), // no visibility field -> still surfaced
      ev({ id: "c", iCalUID: "uc", visibility: "private", summary: "Private coaching" }),
      ev({ id: "d", iCalUID: "ud", visibility: "confidential", summary: "Confidential strategy" }),
      ev({ id: "e", iCalUID: "ue", status: "cancelled" }),
    ],
  });
  assert.equal(out.event_count, 2);
  assert.ok(out.by_ical_uid.ua);
  assert.ok(out.by_ical_uid.ub);
  assert.equal(out.by_ical_uid.uc, undefined);
  assert.equal(out.by_ical_uid.ud, undefined);
  assert.equal(out.by_ical_uid.ue, undefined);
});

test("export never emits source-calendar identifiers (id, html_link, calendar_id)", () => {
  const out = buildCalendarGoogleEventsExport({
    calendarId: "c_admin@group.calendar.google.com",
    events: [ev({ id: "a", iCalUID: "ua" })],
  });
  assert.equal(out.calendar_id, null);
  assert.equal(out.by_ical_uid.ua.html_link, undefined);
  assert.equal(out.by_ical_uid.ua.google_event_id, undefined);
});

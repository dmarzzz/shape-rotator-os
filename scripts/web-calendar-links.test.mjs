import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCalendarExportLinks,
  googleCalendarUrl,
  wireCalendarExportLinks,
} from "../apps/web/scripts/calendar-links.mjs";
import {
  buildEventCalendarActions,
  extractJoinLink,
  renderWeekView,
} from "../packages/shape-ui/src/cohort-calendar-week.js";

function withCalendarLinks(runtimeLinks, callback) {
  const previousLinks = globalThis.SHAPE_CALENDAR_LINKS;
  const previousMember = globalThis.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL;
  const previousAuthorized = globalThis.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL;
  globalThis.SHAPE_CALENDAR_LINKS = runtimeLinks;
  delete globalThis.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL;
  delete globalThis.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL;
  try {
    return callback();
  } finally {
    if (previousLinks === undefined) delete globalThis.SHAPE_CALENDAR_LINKS;
    else globalThis.SHAPE_CALENDAR_LINKS = previousLinks;
    if (previousMember === undefined) delete globalThis.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL;
    else globalThis.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL = previousMember;
    if (previousAuthorized === undefined) delete globalThis.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL;
    else globalThis.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL = previousAuthorized;
  }
}

test("web calendar Google link subscribes to the read-only public feed", () => {
  const href = googleCalendarUrl("webcal://shape.example/calendar.ics");

  assert.match(href, /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=/);
  assert.equal(decodeURIComponent(new URL(href).searchParams.get("cid")), "webcal://shape.example/calendar.ics");
  assert.doesNotMatch(decodeURIComponent(href), /@group\.calendar\.google\.com/);
});

test("web calendar export links keep Google, Apple/Outlook, and ICS on the read-only feed", () => {
  const links = buildCalendarExportLinks({
    host: "shape.example",
  });

  assert.equal(links.icsHref, "/calendar.ics");
  assert.equal(links.webcalHref, "webcal://shape.example/calendar.ics");
  assert.equal(decodeURIComponent(new URL(links.googleHref).searchParams.get("cid")), "webcal://shape.example/calendar.ics");
});

test("web calendar export links wire existing DOM anchors", () => {
  const anchors = {
    "cal-ics": { href: "" },
    "cal-webcal": { href: "" },
    "cal-google": { href: "" },
  };
  const documentRef = {
    getElementById: (id) => anchors[id] || null,
  };

  wireCalendarExportLinks({
    documentRef,
    host: "shape.example",
  });

  assert.equal(anchors["cal-ics"].href, "/calendar.ics");
  assert.equal(anchors["cal-webcal"].href, "webcal://shape.example/calendar.ics");
  assert.equal(decodeURIComponent(new URL(anchors["cal-google"].href).searchParams.get("cid")), "webcal://shape.example/calendar.ics");
});

test("web calendar event add link builds a Google timed event", () => {
  const actions = buildEventCalendarActions({
    blockText: "15:30-16:00 tea on roof",
    dayMs: Date.UTC(2026, 5, 16),
  });
  const url = new URL(actions.googleHref);

  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "tea on roof");
  assert.equal(url.searchParams.get("dates"), "20260616T153000/20260616T160000");
  assert.equal(url.searchParams.get("ctz"), "America/New_York");
  assert.equal(actions.timeKind, "timed");
  assert.match(decodeURIComponent(actions.icsHref), /DTSTART;TZID=America\/New_York:20260616T153000/);
});

test("web calendar event add link preserves multi-day all-day markers", () => {
  const actions = buildEventCalendarActions({
    blockText: "Mon-Tue: TEE Technical: TEEs/Attestation",
    dayMs: Date.UTC(2026, 5, 15),
  });
  const url = new URL(actions.googleHref);

  assert.equal(url.searchParams.get("dates"), "20260615/20260617");
  assert.equal(actions.timeKind, "all_day");
  assert.match(decodeURIComponent(actions.icsHref), /DTEND;VALUE=DATE:20260617/);
});

test("web calendar event renderer turns Meet markers into join links", () => {
  const meetUrl = "https://meet.google.com/abc-defg-hij";
  const html = renderWeekView({
    weekIdx: 0,
    sub: "week",
    source: "supabase",
    data: {
      last_refresh: "2026-06-13T12:00:00Z",
      tabs: {
        "May 18 Start": [
          ["Week", "Dates", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          [],
          ["1", "May 18-24", `16:00-17:00 Demo\nMeet: ${meetUrl}`, "", "", "", "", "", ""],
        ],
      },
    },
  });

  assert.equal(extractJoinLink(`Meet: ${meetUrl}.`), meetUrl);
  assert.match(html, /join event/);
  assert.match(html, new RegExp(`data-cal-join-href="${meetUrl}"`));
  assert.doesNotMatch(html, /cal-event-extra">Meet:/);
  assert.doesNotMatch(html, /calendar\.google\.com\/calendar\/render/);
  assert.doesNotMatch(html, /cal-add-link/);
});

test("web calendar Meet add action opens the shared guest calendar when configured", () => {
  const meetUrl = "https://meet.google.com/abc-defg-hij";
  const memberGoogleHref = "https://calendar.google.com/calendar/r?cid=guest%40example.com";
  const html = withCalendarLinks({ memberGoogleHref }, () => renderWeekView({
    weekIdx: 0,
    sub: "week",
    source: "supabase",
    data: {
      last_refresh: "2026-06-13T12:00:00Z",
      tabs: {
        "May 18 Start": [
          ["Week", "Dates", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          [],
          ["1", "May 18-24", `16:00-17:00 Demo\nMeet: ${meetUrl}`, "", "", "", "", "", ""],
        ],
      },
    },
  }));

  assert.match(html, /team Google/);
  assert.match(html, /data-cal-add-mode="guest_calendar"/);
  assert.match(html, /data-cal-add-note="opens the shared guest calendar"/);
  assert.ok(html.includes(`href="${memberGoogleHref}"`));
  assert.doesNotMatch(html, /calendar\.google\.com\/calendar\/render/);
});

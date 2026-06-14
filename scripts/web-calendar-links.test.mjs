import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCalendarExportLinks,
  configuredMemberGoogleHref,
  googleCalendarUrl,
  wireCalendarExportLinks,
} from "../apps/web/scripts/calendar-links.mjs";
import {
  buildEventCalendarActions,
  extractJoinLink,
  renderWeekView,
} from "../apps/web/shape-ui/src/cohort-calendar-week.js";

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
  assert.equal(links.adminHref, "#calendar-ingress");
  assert.equal(links.webcalHref, "webcal://shape.example/calendar.ics");
  assert.equal(decodeURIComponent(new URL(links.googleHref).searchParams.get("cid")), "webcal://shape.example/calendar.ics");
  assert.equal(links.memberGoogleHref, "");
});

test("web calendar export links wire existing DOM anchors", () => {
  const anchors = {
    "cal-admin": { href: "" },
    "cal-ics": { href: "" },
    "cal-webcal": { href: "" },
    "cal-google": { href: "" },
    "cal-google-member": { href: "", hidden: false },
  };
  const documentRef = {
    getElementById: (id) => anchors[id] || null,
  };

  wireCalendarExportLinks({
    documentRef,
    host: "shape.example",
  });

  assert.equal(anchors["cal-admin"].href, "#calendar-ingress");
  assert.equal(anchors["cal-ics"].href, "/calendar.ics");
  assert.equal(anchors["cal-webcal"].href, "webcal://shape.example/calendar.ics");
  assert.equal(decodeURIComponent(new URL(anchors["cal-google"].href).searchParams.get("cid")), "webcal://shape.example/calendar.ics");
  assert.equal(anchors["cal-google-member"].href, "#");
  assert.equal(anchors["cal-google-member"].hidden, true);
});

test("web calendar can expose an ACL-gated Google link from runtime config", () => {
  const memberHref = "https://calendar.google.com/calendar/r?cid=calendar%40example.com";
  const anchors = {
    "cal-admin": { href: "" },
    "cal-ics": { href: "" },
    "cal-webcal": { href: "" },
    "cal-google": { href: "" },
    "cal-google-member": { href: "", hidden: true },
  };
  const documentRef = {
    getElementById: (id) => anchors[id] || null,
    querySelector: () => null,
  };

  const links = wireCalendarExportLinks({
    documentRef,
    host: "shape.example",
    runtime: {
      SHAPE_CALENDAR_LINKS: {
        memberGoogleHref: memberHref,
      },
    },
  });

  assert.equal(anchors["cal-admin"].href, "#calendar-ingress");
  assert.equal(configuredMemberGoogleHref({ documentRef, runtime: { SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL: memberHref } }), memberHref);
  assert.equal(links.memberGoogleHref, memberHref);
  assert.equal(anchors["cal-google-member"].href, memberHref);
  assert.equal(anchors["cal-google-member"].hidden, false);
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
});

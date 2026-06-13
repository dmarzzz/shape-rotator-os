const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildBackfillPlan,
  googleEventBodyFromCollectedEvent,
  runGoogleCalendarBackfill,
} = require("./backfill-google-calendar.js");

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-google-backfill-"));
  const source = path.join(dir, "calendar.json");
  fs.writeFileSync(source, JSON.stringify({
    last_refresh: "2026-06-13T16:12:46.618Z",
    tabs: {
      "May 18 Start": [
        ["Week", "Dates", "Mon", "Tue", "Wed"],
        ["1", "Jun 1-7", "15:30-16:00 tea on roof", "Office hours", ""],
      ],
    },
  }, null, 2));
  return source;
}

test("Google backfill plan uses stable iCalUIDs from calendar.json", () => {
  const plan = buildBackfillPlan({ sourcePath: writeFixture() });

  assert.equal(plan.events.length, 2);
  assert.equal(plan.events[0].uid, "may-18-start-20260601-mon@shape-rotator-os");
  assert.equal(plan.events[0].body.iCalUID, plan.events[0].uid);
  assert.deepEqual(plan.events[0].body.start, {
    dateTime: "2026-06-01T15:30:00-04:00",
    timeZone: "America/New_York",
  });
  assert.deepEqual(plan.events[0].body.end, {
    dateTime: "2026-06-01T16:00:00-04:00",
    timeZone: "America/New_York",
  });
  assert.equal(plan.events[0].summary, "tea on roof");
  assert.equal(plan.events[0].time_kind, "timed");
  assert.equal(plan.events[0].body.eventType, "default");
  assert.equal(plan.events[0].body.extendedProperties.private.shape_source, "cohort-data/calendar.json");
  assert.equal(plan.events[0].body.extendedProperties.private.shape_calendar_time_kind, "timed");
  assert.deepEqual(plan.events[1].body.start, { date: "2026-06-02" });
  assert.equal(plan.events[1].time_kind, "all_day");
});

test("Google backfill plan splits multi-block cells and skips date headers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-google-backfill-blocks-"));
  const source = path.join(dir, "calendar.json");
  fs.writeFileSync(source, JSON.stringify({
    last_refresh: "2026-06-13T16:12:46.618Z",
    tabs: {
      "May 18 Start": [
        ["Week", "Dates", "Mon"],
        ["1", "Jun 8-14", "Fri Jun 12:\n\n16:00-16:30 tea on roof\n\n[All Day] Anarchy Day\n\n17:30 -- 10:30 Shape Rotator Demo Night\n\n- 1600-1730 Salon: Ideal Customer Profiling\n\n16:30--19:30 PMF Check Point\n\n12:00:14:00\n Tutorial: Dstack\n\n19:00 Founder night"],
      ],
    },
  }, null, 2));

  const plan = buildBackfillPlan({ sourcePath: source });

  assert.equal(plan.events.length, 7);
  assert.equal(plan.events[0].uid, "may-18-start-20260608-mon@shape-rotator-os");
  assert.equal(plan.events[0].summary, "tea on roof");
  assert.equal(plan.events[0].time_kind, "timed");
  assert.equal(plan.events[1].summary, "Anarchy Day");
  assert.equal(plan.events[1].time_kind, "all_day");
  assert.match(plan.events[1].uid, /-block-2-anarchy-day@shape-rotator-os$/);
  assert.equal(plan.events[2].summary, "Shape Rotator Demo Night");
  assert.deepEqual(plan.events[2].body.end, {
    dateTime: "2026-06-08T22:30:00-04:00",
    timeZone: "America/New_York",
  });
  assert.equal(plan.events[3].summary, "Salon: Ideal Customer Profiling");
  assert.equal(plan.events[3].time_kind, "timed");
  assert.equal(plan.events[4].summary, "PMF Check Point");
  assert.equal(plan.events[4].time_kind, "timed");
  assert.equal(plan.events[5].summary, "Tutorial: Dstack");
  assert.equal(plan.events[5].time_kind, "timed");
  assert.equal(plan.events[6].summary, "Founder night");
  assert.deepEqual(plan.events[6].body.end, {
    dateTime: "2026-06-08T19:30:00-04:00",
    timeZone: "America/New_York",
  });
});

test("Google backfill spans all-day weekday range markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-google-backfill-range-"));
  const source = path.join(dir, "calendar.json");
  fs.writeFileSync(source, JSON.stringify({
    last_refresh: "2026-06-13T16:12:46.618Z",
    tabs: {
      "May 18 Start": [
        ["Week", "Dates", "Mon", "Tue", "Wed", "Thu"],
        ["1", "Jun 15-21", "Mon-Tue: TEE Technical: TEEs/Attestation", "", "", "Thu-Fri: Salon: Content and Marketing"],
      ],
    },
  }, null, 2));

  const plan = buildBackfillPlan({ sourcePath: source });

  assert.equal(plan.events.length, 2);
  assert.equal(plan.events[0].summary, "Mon-Tue: TEE Technical: TEEs/Attestation");
  assert.deepEqual(plan.events[0].body.start, { date: "2026-06-15" });
  assert.deepEqual(plan.events[0].body.end, { date: "2026-06-17" });
  assert.equal(plan.events[0].body.extendedProperties.private.shape_calendar_span_days, "2");
  assert.equal(plan.events[1].summary, "Thu-Fri: Salon: Content and Marketing");
  assert.deepEqual(plan.events[1].body.start, { date: "2026-06-18" });
  assert.deepEqual(plan.events[1].body.end, { date: "2026-06-20" });
});

test("Google backfill dry-run does not require a token or call Google", async () => {
  const output = await runGoogleCalendarBackfill({
    sourcePath: writeFixture(),
    calendarId: "cohort@example.com",
    fetchImpl: async () => {
      throw new Error("dry-run should not call fetch");
    },
  });

  assert.equal(output.apply, false);
  assert.equal(output.planned, 2);
  assert.deepEqual(output.actions.map((action) => action.action), ["dry-run", "dry-run"]);
});

test("Google backfill imports missing events and patches changed ones", async () => {
  const calls = [];
  const existingUid = "may-18-start-20260602-tue@shape-rotator-os";
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body });
    assert.equal(options.headers.authorization, "Bearer google-token");
    if (parsed.searchParams.get("iCalUID") === existingUid) {
      return Response.json({
        items: [{
          id: "existing-google-event",
          status: "confirmed",
          summary: "Old title",
          description: "Old body",
          start: { date: "2026-06-02" },
          end: { date: "2026-06-03" },
        }],
      });
    }
    if ((options.method || "GET") === "GET") {
      return Response.json({ items: [] });
    }
    if (parsed.pathname.endsWith("/events/import")) {
      assert.equal(body.iCalUID, "may-18-start-20260601-mon@shape-rotator-os");
      return Response.json({ id: "new-google-event", ...body });
    }
    assert.equal((options.method || "GET"), "PATCH");
    assert.equal(parsed.pathname.endsWith("/events/existing-google-event"), true);
    assert.equal(body.eventType, undefined);
    return Response.json({ id: "existing-google-event", ...body });
  };

  const output = await runGoogleCalendarBackfill({
    sourcePath: writeFixture(),
    calendarId: "cohort@example.com",
    accessToken: "google-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.inserted, 1);
  assert.equal(output.updated, 1);
  assert.equal(output.unchanged, 0);
  assert.deepEqual(output.actions.map((action) => action.action), ["inserted", "updated"]);
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
  assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/events/import")), true);
  assert.equal(calls.some((call) => call.method === "PATCH" && call.path.endsWith("/events/existing-google-event")), true);
});

test("Google backfill replaces all-day imports when they become timed events", async () => {
  const source = writeFixture();
  const first = buildBackfillPlan({ sourcePath: source }).events[0];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body });
    if ((options.method || "GET") === "GET") {
      return Response.json({
        items: [{
          id: "old-all-day-google-event",
          status: "confirmed",
          summary: "Old all day",
          description: "Old body",
          start: { date: "2026-06-01" },
          end: { date: "2026-06-02" },
          extendedProperties: first.body.extendedProperties,
        }],
      });
    }
    if ((options.method || "GET") === "DELETE") {
      assert.equal(parsed.pathname.endsWith("/events/old-all-day-google-event"), true);
      return new Response(null, { status: 204 });
    }
    assert.equal((options.method || "GET"), "POST");
    assert.equal(parsed.pathname.endsWith("/events/import"), true);
    assert.deepEqual(body.start, first.body.start);
    return Response.json({ id: "new-timed-google-event", ...body });
  };

  const output = await runGoogleCalendarBackfill({
    sourcePath: source,
    calendarId: "cohort@example.com",
    accessToken: "google-token",
    apply: true,
    maxEvents: 1,
    fetchImpl,
  });

  assert.equal(output.updated, 1);
  assert.equal(output.actions[0].action, "replaced");
  assert.equal(output.actions[0].google_event_id, "new-timed-google-event");
  assert.equal(output.actions[0].replaced_google_event_id, "old-all-day-google-event");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "DELETE", "POST"]);
});

test("Google backfill leaves matching existing events unchanged", async () => {
  const source = writeFixture();
  const first = buildBackfillPlan({ sourcePath: source }).events[0];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal((options.method || "GET"), "GET");
    assert.equal(parsed.searchParams.get("iCalUID"), first.uid);
    return Response.json({
      items: [{
        id: "same-google-event",
        status: "confirmed",
        summary: first.body.summary,
        description: first.body.description,
        start: first.body.start,
        end: first.body.end,
        extendedProperties: first.body.extendedProperties,
      }],
    });
  };

  const output = await runGoogleCalendarBackfill({
    sourcePath: source,
    calendarId: "cohort@example.com",
    accessToken: "google-token",
    apply: true,
    maxEvents: 1,
    fetchImpl,
  });

  assert.equal(output.inserted, 0);
  assert.equal(output.updated, 0);
  assert.equal(output.unchanged, 1);
  assert.equal(output.actions[0].google_event_id, "same-google-event");
});

test("Google backfill patches events with stale private metadata", async () => {
  const source = writeFixture();
  const first = buildBackfillPlan({ sourcePath: source }).events[0];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, body });
    if ((options.method || "GET") === "GET") {
      return Response.json({
        items: [{
          id: "metadata-drift-event",
          status: "confirmed",
          summary: first.body.summary,
          description: first.body.description,
          start: first.body.start,
          end: first.body.end,
          extendedProperties: {
            private: {
              shape_source: "legacy",
            },
          },
        }],
      });
    }
    assert.equal((options.method || "GET"), "PATCH");
    return Response.json({ id: "metadata-drift-event", ...body });
  };

  const output = await runGoogleCalendarBackfill({
    sourcePath: source,
    calendarId: "cohort@example.com",
    accessToken: "google-token",
    apply: true,
    maxEvents: 1,
    fetchImpl,
  });

  assert.equal(output.updated, 1);
  assert.deepEqual(output.actions[0].changed, ["extendedProperties.private"]);
  assert.equal(calls.some((call) => call.method === "PATCH" && call.body.extendedProperties), true);
});

test("Google backfill event bodies preserve all-day shape for unparsed blocks", () => {
  const body = googleEventBodyFromCollectedEvent({
    uid: "uid@example.com",
    summary: "Demo",
    description: "Demo body",
    date: new Date(Date.UTC(2026, 5, 1)),
    category: "Source tab",
  });

  assert.equal(body.iCalUID, "uid@example.com");
  assert.deepEqual(body.start, { date: "2026-06-01" });
  assert.deepEqual(body.end, { date: "2026-06-02" });
  assert.equal(body.extendedProperties.private.shape_calendar_category, "Source tab");
});

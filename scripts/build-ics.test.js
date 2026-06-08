#!/usr/bin/env node
/**
 * End-to-end test for build-ics.js.
 *
 * "End-to-end" here means: generate the .ics from the real committed
 * cohort-data/calendar.json, then parse it back with node-ical — an
 * independent, spec-compliant iCalendar parser of the same lineage the
 * importers in Apple Calendar / Google Calendar / Outlook use. If a real
 * parser can read our output and recover the right events on the right days,
 * the file will import. We deliberately do NOT assert against our own
 * generator internals for the round-trip checks — only against the parser's
 * view — so a bug encoded in both the writer and a hand-rolled reader can't
 * hide.
 *
 *   node --test scripts/build-ics.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ical = require("node-ical");

const { generateIcs, collectEvents } = require("./build-ics.js");

const REAL = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "cohort-data", "calendar.json"), "utf8"),
);

const parse = (ics) => ical.parseICS(ics);
const events = (parsed) => Object.values(parsed).filter((v) => v.type === "VEVENT");
const dateKey = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const onDate = (parsed, yyyy_mm_dd) =>
  events(parsed).filter((e) => dateKey(e.start) === yyyy_mm_dd);

test("real calendar.json → a feed node-ical parses as a valid VCALENDAR", () => {
  const parsed = parse(generateIcs(REAL));
  assert.equal(parsed.vcalendar.prodid, "-//shape-rotator-os//cohort calendar//EN");
  assert.ok(events(parsed).length >= 50, "expected the full cohort schedule");
});

test("known cells land on the correct day as all-day events", () => {
  const parsed = parse(generateIcs(REAL));

  // Week 1 Monday: the kickoff-dinner cell (May 18 2026 is a Monday).
  const mon = onDate(parsed, "2026-05-18");
  assert.equal(mon.length, 1);
  assert.match(mon[0].description, /kickoff dinner/);
  assert.equal(mon[0].datetype, "date", "should be an all-day (DATE) event");
  // RFC 5545 all-day DTEND is exclusive → exactly one day after DTSTART.
  assert.equal(Math.round((mon[0].end - mon[0].start) / 86400000), 1);

  // Week 3 Monday (Jun 1 2026 = Monday).
  assert.equal(onDate(parsed, "2026-06-01")[0].description, "15:30–16:00 tea on roof");

  // Sat column, +5 from Monday (May 30 2026 = Saturday). Only the day-cell
  // ("Convent") is emitted — the half-marathon note in the Notes column is
  // not a weekday column and is correctly excluded.
  assert.equal(onDate(parsed, "2026-05-30")[0].description, "Convent");
});

test("the 'Weekly Themes' planning tab is not emitted as schedule events", () => {
  // Its columns are Phase/Theme/Goals, not weekdays — no day grid to walk.
  const cats = new Set(collectEvents(REAL).map((e) => e.category));
  assert.ok(!cats.has("Weekly Themes"));
  assert.ok(cats.has("May 18 Start"));
});

test("commas/special chars round-trip cleanly through the parser", () => {
  const parsed = parse(generateIcs(REAL));
  // Tue May 19 lists "Daedalus, Prova, Feedling" — the parser must hand back
  // real commas, not the escaped "\," we write to the wire.
  const tue = onDate(parsed, "2026-05-19")[0];
  assert.match(tue.description, /Daedalus, Prova, Feedling/);
  assert.ok(!tue.description.includes("\\,"));
});

test("UIDs are unique and stable across regeneration", () => {
  const uids = collectEvents(REAL).map((e) => e.uid);
  assert.equal(uids.length, new Set(uids).size, "UIDs must be unique (no dupes on re-import)");
  assert.deepEqual(uids, collectEvents(REAL).map((e) => e.uid));
});

test("output is byte-deterministic (so --check can detect drift)", () => {
  assert.equal(generateIcs(REAL), generateIcs(REAL));
});

test("every content line obeys the 75-octet fold limit and CRLF framing", () => {
  const ics = generateIcs(REAL);
  assert.ok(ics.endsWith("\r\n"));
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line too long: ${JSON.stringify(line)}`);
  }
});

test("date math: weekday columns map to Monday+offset (synthetic fixture)", () => {
  const fixture = {
    last_refresh: "2026-05-21T00:00:00Z",
    tabs: {
      Sched: [
        ["Week", "Dates", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        ["1", "Jun 1–7", "monday note", "", "", "", "", "", "sunday note"],
      ],
    },
  };
  const parsed = parse(generateIcs(fixture));
  const all = events(parsed);
  assert.equal(all.length, 2);
  assert.equal(onDate(parsed, "2026-06-01")[0].summary, "monday note"); // Mon
  assert.equal(onDate(parsed, "2026-06-07")[0].summary, "sunday note"); // Mon+6 = Sun
});

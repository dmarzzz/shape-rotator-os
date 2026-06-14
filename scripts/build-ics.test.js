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

const { generateIcs, collectEvents, collectIcsEvents } = require("./build-ics.js");

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
  assert.ok(Object.values(parsed).some((v) => v.type === "VTIMEZONE" && v.tzid === "America/New_York"));
  assert.ok(events(parsed).length >= 90, "expected the expanded cohort schedule");
});

test("known cells expand into timed events and true all-day events", () => {
  const parsed = parse(generateIcs(REAL));
  const all = events(parsed);

  // Week 1 Monday: the source cell is split into separate timed sessions.
  const onboarding = all.find((e) => e.uid === "may-18-start-20260518-mon@shape-rotator-os");
  assert.equal(onboarding.summary, "onboarding");
  assert.equal(onboarding.datetype, "date-time");
  assert.equal(onboarding.start.tz, "America/New_York");
  assert.equal(onboarding.start.toISOString(), "2026-05-18T16:00:00.000Z");
  assert.equal(onboarding.end.toISOString(), "2026-05-18T18:00:00.000Z");

  const kickoff = all.find((e) => /kickoff dinner/.test(e.description));
  assert.equal(kickoff.summary, "kickoff dinner @ Auditorium");
  assert.equal(kickoff.datetype, "date-time");
  assert.match(kickoff.uid, /-block-4-kickoff-dinner-auditorium@shape-rotator-os$/);
  assert.equal(kickoff.start.tz, "America/New_York");
  assert.equal(kickoff.start.toISOString(), "2026-05-18T23:30:00.000Z");
  assert.equal(kickoff.end.toISOString(), "2026-05-19T00:00:00.000Z");

  // Week 3 Monday (Jun 1 2026 = Monday).
  const tea = all.find((e) => e.uid === "may-18-start-20260601-mon@shape-rotator-os");
  assert.equal(tea.summary, "tea on roof");
  assert.equal(tea.datetype, "date-time");
  assert.equal(tea.start.tz, "America/New_York");
  assert.equal(tea.start.toISOString(), "2026-06-01T19:30:00.000Z");
  assert.equal(tea.end.toISOString(), "2026-06-01T20:00:00.000Z");

  // Sat column, +5 from Monday (May 30 2026 = Saturday). Only the day-cell
  // ("Convent") is emitted — the half-marathon note in the Notes column is
  // not a weekday column and is correctly excluded.
  const convent = all.find((e) => e.uid === "may-18-start-20260530-sat@shape-rotator-os");
  assert.equal(convent.description, "Convent");
  assert.equal(convent.datetype, "date");
  assert.equal(dateKey(convent.start), "2026-05-30");
  assert.equal(Math.round((convent.end - convent.start) / 86400000), 1);
});

test("future weekday-range markers keep their intended multi-day all-day span", () => {
  const parsed = parse(generateIcs(REAL));
  const tee = events(parsed).find((e) => e.uid === "may-18-start-20260615-mon@shape-rotator-os");

  assert.match(tee.summary, /^Mon-Tue: TEE Technical/);
  assert.equal(tee.datetype, "date");
  assert.equal(dateKey(tee.start), "2026-06-15");
  assert.equal(dateKey(tee.end), "2026-06-17");
  assert.equal(Math.round((tee.end - tee.start) / 86400000), 2);
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
  const tue = events(parsed).find((e) => /Daedalus/.test(e.description));
  assert.match(tue.description, /Daedalus, Prova, Feedling/);
  assert.ok(!tue.description.includes("\\,"));
});

test("UIDs are unique and stable across regeneration", () => {
  const uids = collectIcsEvents(REAL).map((e) => e.uid);
  assert.equal(uids.length, new Set(uids).size, "UIDs must be unique (no dupes on re-import)");
  assert.deepEqual(uids, collectIcsEvents(REAL).map((e) => e.uid));
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

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTab } = require("./build-calendar-from-google.js");

const META = {
  tab: "May 18 Start",
  header_rows: [["Week", "Dates", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "On-Site", "Feedback", "Notes"]],
  weeks: [
    { week: 1, date_range: "May 18–23", theme: "Orientation and Onboarding week", on_site: "OS1", feedback_goals: "FG1", notes: "N1" },
  ],
  recurring_rows: [["", "", "RECURRING (all weeks): Weekly Show & Tell"]],
};

// Mon May 18 2026 (week 0) with a rich description; Tue May 19 with no description (synthesized).
const EVENTS = [
  { start: { dateTime: "2026-05-18T12:00:00-04:00" }, end: { dateTime: "2026-05-18T14:00:00-04:00" }, summary: "onboarding", description: "12:00–14:00 onboarding\n    - follow the field guide (dmarz)" },
  { start: { dateTime: "2026-05-19T14:00:00-04:00" }, end: { dateTime: "2026-05-19T14:30:00-04:00" }, summary: "tea on roof" },
  // Out-of-range event (before cohort start) must be dropped, not crash.
  { start: { dateTime: "2026-05-01T10:00:00-04:00" }, summary: "pre-cohort noise" },
];

test("buildTab merges calendar day-blocks with owned metadata into the weekly grid", () => {
  const { rows, placed } = buildTab(META, EVENTS);

  // header (1) + 10 week rows + recurring (1)
  assert.equal(rows.length, 1 + 10 + 1);
  assert.deepEqual(rows[0], META.header_rows[0]);
  assert.equal(placed, 2); // pre-cohort event dropped

  const week1 = rows[1];
  assert.equal(week1[0], "1");
  assert.equal(week1[1], "May 18–23\n\nOrientation and Onboarding week"); // date range + theme from meta
  // Mon block: day header + the event description verbatim (rich text preserved)
  assert.match(week1[2], /^Mon May 18:/);
  assert.match(week1[2], /12:00–14:00 onboarding/);
  assert.match(week1[2], /follow the field guide \(dmarz\)/);
  // Tue block: synthesized from time + summary when no description
  assert.match(week1[3], /^Tue May 19:/);
  assert.match(week1[3], /14:00–14:30 tea on roof/);
  // empty days are blank
  assert.equal(week1[4], "");
  // support columns from meta land in cols 9–11
  assert.equal(week1[9], "OS1");
  assert.equal(week1[10], "FG1");
  assert.equal(week1[11], "N1");

  // weeks with no meta entry still render (empty), and recurring row is appended last
  assert.equal(rows[2][0], "2");
  assert.deepEqual(rows[rows.length - 1], META.recurring_rows[0]);
});

test("buildTab places multiple same-day events as separate blocks", () => {
  const events = [
    { start: { dateTime: "2026-05-18T12:00:00-04:00" }, summary: "a", description: "12:00 a" },
    { start: { dateTime: "2026-05-18T15:00:00-04:00" }, summary: "b", description: "15:00 b" },
  ];
  const { rows } = buildTab({ tab: "t", header_rows: [], weeks: [{ week: 1, date_range: "May 18–23" }], recurring_rows: [] }, events);
  const monday = rows[0][2];
  // blank-line separated so parseWeekRow splits them into two blocks
  assert.match(monday, /12:00 a\n\n15:00 b/);
});

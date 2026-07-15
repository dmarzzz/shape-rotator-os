const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTab, normalizeDescription, descriptionToBlock, stripMarkdown, countPopulatedCells, eventBlock } = require("./build-calendar-from-google.js");

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

test("normalizeDescription converts HTML/entities and leaves plain text intact", () => {
  // plain text (the common case) is untouched
  assert.equal(normalizeDescription("12:00–14:00 onboarding\n    - follow the field guide"), "12:00–14:00 onboarding\n    - follow the field guide");
  // HTML from the rich editor becomes plain text
  assert.equal(normalizeDescription("12:00 talk<br>Tom &amp; Jerry"), "12:00 talk\nTom & Jerry");
  assert.equal(normalizeDescription("<ul><li>one</li><li>two</li></ul>"), "- one\n- two");
  assert.equal(normalizeDescription("a<br><br><br>b"), "a\n\nb"); // blank-line runs collapsed
  assert.equal(normalizeDescription("&lt;tag&gt; it&#39;s &nbsp;fine"), "<tag> it's  fine");
  // eventBlock uses it
  assert.equal(eventBlock({ description: "16:00 demo<br>- ship it" }), "16:00 demo\n- ship it");
});

test("countPopulatedCells counts only day-cells with schedule text", () => {
  const cal = { tabs: { t: [
    ["Week", "Dates", "Mon"], [], // header rows 0,1 ignored
    ["1", "May 18–23", "Mon: a", "", "Wed: c", "", "", "", ""], // 2 populated day-cells
    ["2", "May 25–30", "", "Tue: b", "", "", "", "", ""], // 1 populated
  ] } };
  assert.equal(countPopulatedCells(cal, "t"), 3);
  assert.equal(countPopulatedCells(null, "t"), 0);
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

test("eventBlock adds the Google Meet join link only for the live grid, never the committed bundle", () => {
  const ev = {
    start: { dateTime: "2026-05-18T16:00:00-04:00" },
    end: { dateTime: "2026-05-18T17:00:00-04:00" },
    summary: "Demo",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  };
  // Committed path (default includeMeet=false): no Meet link reaches calendar.json.
  const committed = eventBlock(ev);
  assert.doesNotMatch(committed, /meet\.google\.com/);
  assert.doesNotMatch(committed, /Meet:/);
  // Live path (includeMeet=true): appends the `Meet:` marker the renderers parse.
  assert.match(eventBlock(ev, true), /\nMeet: https:\/\/meet\.google\.com\/abc-defg-hij$/);
  // buildTab honors the flag too — default grid stays Meet-free.
  const { rows } = buildTab(
    { tab: "t", header_rows: [], weeks: [{ week: 1, date_range: "May 18–23" }], recurring_rows: [] },
    [ev],
  );
  assert.doesNotMatch(rows[0][2], /meet\.google\.com/);
});

// ── the block-explosion fix ──────────────────────────────────────────────────
// A real Google event now carries a multi-paragraph markdown description in its
// body (speaker bios, topics) with the human title in `summary`. The block must
// stay ONE event: leading time+title, description as details, no internal blank
// lines (which parseWeekRow would read as event boundaries), and no literal
// markdown markers.
test("eventBlock keeps a prose/markdown description as one titled+timed block", () => {
  const block = eventBlock({
    start: { dateTime: "2026-07-07T16:00:00-04:00" },
    end:   { dateTime: "2026-07-07T17:30:00-04:00" },
    summary: "salon",
    description:
      "Upgradeable TEEs, and Inco's launch.\n\n" +
      "## Discussion Topics\n\n" +
      "### 1. Agentic transformation\n\n" +
      "**Wenhao Wang** - Yale",
  });
  // leads with the real time + summary, NOT the first line of the description
  assert.match(block, /^16:00–17:30 salon\n/);
  // NO internal blank line → parseWeekRow cannot explode it into phantom events
  assert.doesNotMatch(block, /\n\s*\n/);
  assert.equal(block.split(/\n\s*\n/).length, 1);
  // markdown markers stripped, but the content survives
  assert.doesNotMatch(block, /#{1,6}\s|\*\*/);
  assert.match(block, /Discussion Topics/);
  assert.match(block, /Wenhao Wang - Yale/);
});

test("eventBlock does not double up when the description already leads with a time", () => {
  // Authored "self-describing" style: description repeats the time+title.
  const block = eventBlock({
    start: { dateTime: "2026-05-18T12:00:00-04:00" },
    end:   { dateTime: "2026-05-18T14:00:00-04:00" },
    summary: "onboarding",
    description: "12:00–14:00 onboarding\n- follow the field guide",
  });
  assert.equal(block, "12:00–14:00 onboarding\n- follow the field guide");
  assert.equal(block.match(/onboarding/g).length, 1); // appears exactly once
});

test("buildTab does not explode a multi-paragraph description into phantom events", () => {
  const { rows } = buildTab(
    { tab: "t", header_rows: [], weeks: [{ week: 1, date_range: "May 18–23" }], recurring_rows: [] },
    [{
      start: { dateTime: "2026-05-18T13:00:00-04:00" },
      end:   { dateTime: "2026-05-18T15:00:00-04:00" },
      summary: "salon",
      description: "para one\n\npara two\n\npara three",
    }],
  );
  const body = rows[0][2].replace(/^Mon May 18:\n/, "");
  // exactly one blank-line-delimited block (before the fix this was three)
  assert.equal(body.split(/\n\s*\n/).length, 1);
  assert.match(body, /^13:00–15:00 salon/);
});

test("eventBlock still appends the Meet marker for a prose description on the live grid", () => {
  const ev = {
    start: { dateTime: "2026-07-07T16:00:00-04:00" },
    end:   { dateTime: "2026-07-07T17:30:00-04:00" },
    summary: "salon",
    description: "Upgradeable TEEs.\n\n## Topics\n\nsome prose",
    hangoutLink: "https://meet.google.com/ymi-beye-yzy",
  };
  const live = eventBlock(ev, true);
  assert.match(live, /^16:00–17:30 salon\n/);          // fixed lead line
  assert.doesNotMatch(live, /\n\s*\n/);                 // still one block
  assert.match(live, /\nMeet: https:\/\/meet\.google\.com\/ymi-beye-yzy$/); // Meet marker intact
  assert.doesNotMatch(eventBlock(ev), /meet\.google\.com/); // committed stays Meet-free
});

test("stripMarkdown clears headings and bold, keeps links and plain text", () => {
  assert.equal(stripMarkdown("## Discussion Topics"), "Discussion Topics");
  assert.equal(stripMarkdown("### 1. Agentic transformation"), "1. Agentic transformation");
  assert.equal(stripMarkdown("**Wenhao Wang** - Yale"), "Wenhao Wang - Yale");
  assert.equal(stripMarkdown("Meet: https://meet.google.com/abc-defg-hij"), "Meet: https://meet.google.com/abc-defg-hij");
});

test("descriptionToBlock flattens blank lines and normalizes html", () => {
  assert.equal(descriptionToBlock("a\n\n\nb\n\nc"), "a\nb\nc");
  assert.equal(descriptionToBlock("one<br><br>two"), "one\ntwo");
  assert.doesNotMatch(descriptionToBlock("x\n\ny\n\nz"), /\n\s*\n/);
});

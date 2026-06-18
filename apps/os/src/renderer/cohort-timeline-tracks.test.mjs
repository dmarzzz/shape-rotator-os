import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clamp01,
  axisFraction,
  programWeekToMs,
  buildActivityLane,
  buildStandingLane,
  teamStageSeries,
  isPresent,
  buildPresenceLane,
  buildDefaultTimeline,
} from "./cohort-timeline-tracks.mjs";

const DAY = 86400000;
const START = Date.UTC(2026, 4, 18); // mon may 18 2026
const END = Date.UTC(2026, 6, 26); // sun jul 26 2026
const NOW = Date.UTC(2026, 5, 17); // wed jun 17 2026
const WINDOW = { startMs: START, endMs: END, nowMs: NOW };

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test("clamp01 bounds and guards NaN", () => {
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(1.4), 1);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(NaN), 0);
});

test("axisFraction maps the program window to 0..1 and clamps", () => {
  assert.equal(axisFraction(START, START, END), 0);
  assert.equal(axisFraction(END, START, END), 1);
  assert.ok(close(axisFraction(START + (END - START) / 2, START, END), 0.5));
  assert.equal(axisFraction(START - DAY, START, END), 0); // before clamps
  assert.equal(axisFraction(END + DAY, START, END), 1); // after clamps
  assert.equal(axisFraction(START, START, START), 0); // zero span guarded
});

test("programWeekToMs returns week midpoints", () => {
  assert.equal(programWeekToMs(0, START), START + 3.5 * DAY);
  assert.equal(programWeekToMs(2, START), START + 17.5 * DAY);
});

test("buildActivityLane normalizes, filters, sorts, and flags future", () => {
  const whatsNew = [
    { date: "2026-07-23", kind: "event", label: "final demo day", meta: "ceremony", nav: { mode: "calendar" } },
    { date: "2026-06-13", kind: "release", label: "0.3.5", meta: "Shape Rotator OS", nav: { mode: "shapes", recordId: "shape-rotator-os" } },
    { date: "not-a-date", kind: "event", label: "junk" }, // dropped
    { date: "2026-05-25", kind: "ask", label: "need design help", meta: "asks" },
  ];
  const lane = buildActivityLane(whatsNew, WINDOW);
  assert.equal(lane.trackKey, "activity");
  assert.equal(lane.items.length, 3); // junk dropped
  // sorted ascending by time
  assert.deepEqual(
    lane.items.map((i) => i.title),
    ["need design help", "0.3.5", "final demo day"],
  );
  const demo = lane.items.find((i) => i.title === "final demo day");
  const release = lane.items.find((i) => i.title === "0.3.5");
  assert.equal(demo.category, "event");
  assert.equal(demo.isFuture, true); // 2026-07-23 > now
  assert.equal(demo.team, null); // calendar nav → no team
  assert.equal(release.isFuture, false); // 2026-06-13 < now
  assert.equal(release.team, "shape-rotator-os"); // shapes nav → team
  assert.deepEqual(release.detailRef, { nav: { mode: "shapes", recordId: "shape-rotator-os" } });
  assert.equal(release.tier, "public");
  assert.equal(release.shape, "point");
  assert.equal(release.id, "activity:2026-06-13:release:0-3-5");
  assert.ok(release.fraction > 0 && release.fraction < 1);
});

test("buildActivityLane tolerates non-array input", () => {
  assert.deepEqual(buildActivityLane(null, WINDOW).items, []);
  assert.deepEqual(buildActivityLane(undefined, WINDOW).items, []);
});

const STANDING = {
  weeks: [
    { program_week: 0, label: "Program start" },
    { program_week: 1, label: "Week 1" },
    { program_week: 2, label: "Week 2" },
  ],
  byTeam: {
    abra: { weeks: { 0: { stage: 0, confidence: "Low" }, 1: { stage: 2 }, 2: { stage: 4, confidence: "Medium" } } },
    beta: { weeks: { 0: { stage: 2 }, 1: { stage: 2 } } }, // no week 2
  },
};

test("buildStandingLane averages PMF stage per week across teams with data", () => {
  const lane = buildStandingLane(STANDING, WINDOW);
  assert.equal(lane.trackKey, "standing");
  assert.equal(lane.teamCount, 2);
  assert.equal(lane.stageMax, 8);
  const [w0, w1, w2] = lane.points;
  assert.equal(w0.stage, 1); // (0 + 2) / 2
  assert.equal(w0.teamsWithData, 2);
  assert.equal(w1.stage, 2); // (2 + 2) / 2
  assert.equal(w2.stage, 4); // only abra reported week 2
  assert.equal(w2.teamsWithData, 1);
  assert.ok(lane.points.every((p) => p.fraction >= 0 && p.fraction <= 1));
});

test("teamStageSeries maps a single team's weeks", () => {
  const series = teamStageSeries(STANDING.byTeam.beta, STANDING.weeks, START);
  assert.equal(series.length, 3);
  assert.equal(series[0].stage, 2);
  assert.equal(series[2].stage, null); // beta has no week 2
  assert.equal(series[1].ms, programWeekToMs(1, START));
});

test("isPresent honors window bounds and absences (inclusive end days)", () => {
  const person = {
    dates_start: "2026-05-18T00:00:00.000Z",
    dates_end: "2026-07-25T00:00:00.000Z",
    absences: [{ start: "2026-06-11T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z" }],
  };
  assert.equal(isPresent(person, Date.UTC(2026, 5, 1)), true); // jun 1, in window, no absence
  assert.equal(isPresent(person, Date.UTC(2026, 5, 15)), false); // jun 15, mid-absence
  assert.equal(isPresent(person, Date.UTC(2026, 5, 18)), true); // jun 18, day after absence ends
  assert.equal(isPresent(person, Date.UTC(2026, 4, 1)), false); // may 1, before arrival
  assert.equal(isPresent(person, Date.UTC(2026, 7, 1)), false); // aug 1, after departure
});

test("buildPresenceLane samples occupancy across the window", () => {
  const people = [
    { name: "A", dates_start: "2026-05-18T00:00:00.000Z", dates_end: "2026-07-25T00:00:00.000Z" },
    {
      name: "B",
      dates_start: "2026-05-18T00:00:00.000Z",
      dates_end: "2026-07-25T00:00:00.000Z",
      absences: [{ start: "2026-06-11T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z" }],
    },
    { name: "C", dates_start: "2026-06-15T00:00:00.000Z", dates_end: "2026-07-25T00:00:00.000Z" },
    { name: "NoDates" }, // excluded from roster
  ];
  const lane = buildPresenceLane(people, WINDOW);
  assert.equal(lane.trackKey, "presence");
  assert.equal(lane.total, 3); // NoDates excluded
  assert.equal(lane.samples[0].ms, START); // first sample at program start
  assert.equal(lane.samples[0].present, 2); // A + B present, C not yet arrived
  assert.ok(close(lane.samples[0].occupancy, 2 / 3));
  assert.ok(lane.samples.every((s) => s.fraction >= 0 && s.fraction <= 1));
  assert.ok(lane.samples.at(-1).ms <= END);
});

test("buildDefaultTimeline assembles the v1 lane set with a shared axis", () => {
  const out = buildDefaultTimeline(
    { whatsNew: [{ date: "2026-06-13", kind: "release", label: "x" }], standingWeekly: STANDING, people: [] },
    WINDOW,
  );
  assert.equal(out.axis.startMs, START);
  assert.equal(out.axis.endMs, END);
  assert.ok(out.axis.nowFraction > 0 && out.axis.nowFraction < 1);
  assert.deepEqual(
    out.lanes.map((l) => l.trackKey),
    ["activity", "standing", "presence"],
  );
});

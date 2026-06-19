import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scrubberFrac,
  clampStopIdx,
  weekStopsFrom,
  snapshotStopsFrom,
  periodScrubberHtml,
} from "./cohort-period-scrubber.mjs";

test("scrubberFrac maps an index to 0..1 and clamps both ends", () => {
  assert.equal(scrubberFrac(0, 9), 0);
  assert.equal(scrubberFrac(9, 9), 1);
  assert.ok(Math.abs(scrubberFrac(3, 9) - 3 / 9) < 1e-9);
  assert.equal(scrubberFrac(-2, 9), 0); // below range
  assert.equal(scrubberFrac(99, 9), 1); // above range
});

test("scrubberFrac guards the single-stop / zero-span case", () => {
  assert.equal(scrubberFrac(0, 0), 0);
  assert.equal(scrubberFrac(5, 0), 0);
  assert.equal(scrubberFrac(NaN, 9), 0);
});

test("clampStopIdx rounds and bounds into [0, count-1]", () => {
  assert.equal(clampStopIdx(3, 10), 3);
  assert.equal(clampStopIdx(-1, 10), 0);
  assert.equal(clampStopIdx(99, 10), 9);
  assert.equal(clampStopIdx(2.6, 10), 3); // rounds
  assert.equal(clampStopIdx("4", 10), 4); // string coerces
  assert.equal(clampStopIdx(NaN, 10), 0);
});

test("weekStopsFrom labels first as start, last as now, middle as wk N", () => {
  const weeks = [
    { program_week: 0, label: "Program start" },
    { program_week: 1, label: "Week 1" },
    { program_week: 2, label: "Latest" },
  ];
  const stops = weekStopsFrom(weeks);
  assert.equal(stops.length, 3);
  assert.equal(stops[0].compact, "start");
  assert.equal(stops[1].compact, "wk 1");
  assert.equal(stops[2].compact, "now");
  assert.equal(stops[1].label, "Week 1"); // preserves the supplied label
  assert.equal(stops[2].value, 2);
});

test("weekStopsFrom tolerates an empty / non-array input", () => {
  assert.deepEqual(weekStopsFrom(null), []);
  assert.deepEqual(weekStopsFrom(undefined), []);
  assert.deepEqual(weekStopsFrom([]), []);
});

test("snapshotStopsFrom maps snapshots 1:1 with the last index as live now", () => {
  const snaps = [{ label: "wk1 surface" }, { label: "wk2 surface" }, { label: "wk3 surface" }];
  const stops = snapshotStopsFrom(snaps);
  assert.equal(stops.length, 3); // no extra stop — last index IS live
  assert.equal(stops[0].value, 0);
  assert.equal(stops[2].value, 2);
  assert.equal(stops[0].compact, "start");
  assert.equal(stops[2].compact, "now"); // last index = live
  assert.equal(stops[1].compact, "wk 2");
});

test("periodScrubberHtml returns empty markup when there is nothing to scrub", () => {
  assert.equal(periodScrubberHtml({ stops: [] }), "");
  assert.equal(periodScrubberHtml({ stops: [{ label: "only" }] }), "");
});

test("periodScrubberHtml renders one dot per stop, marks the active one, and carries kind", () => {
  const stops = weekStopsFrom([
    { program_week: 0, label: "Program start" },
    { program_week: 1, label: "Week 1" },
    { program_week: 2, label: "Week 2" },
    { program_week: 3, label: "Latest" },
  ]);
  const html = periodScrubberHtml({ stops, activeIdx: 2, caption: "as of", kind: "week" });
  const dotCount = (html.match(/class="cps-stop/g) || []).length;
  assert.equal(dotCount, 4);
  assert.equal((html.match(/is-active/g) || []).length, 1);
  assert.ok(html.includes('data-cps-kind="week"'));
  assert.ok(html.includes('data-cps-last="3"'));
  assert.ok(html.includes('value="2"')); // the range reflects the active index
  assert.ok(html.includes("cps-glide"));
  assert.ok(html.includes("cps-fill"));
  assert.ok(html.includes(">wk 2<")); // now-label = active stop's compact label
});

test("periodScrubberHtml clamps an out-of-range activeIdx", () => {
  const stops = weekStopsFrom([
    { program_week: 0, label: "a" },
    { program_week: 1, label: "b" },
  ]);
  const html = periodScrubberHtml({ stops, activeIdx: 99 });
  assert.ok(html.includes('value="1"')); // clamped to last
});

test("periodScrubberHtml escapes labels in attributes and text", () => {
  const stops = [
    { label: 'A & "B"', compact: "x", value: 0 },
    { label: "C <d>", compact: "y", value: 1 },
  ];
  const html = periodScrubberHtml({ stops, activeIdx: 0, ariaLabel: 'lens & "scope"' });
  assert.ok(!html.includes('"B"</')); // raw quote should be entity-escaped
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&lt;d&gt;"));
  assert.ok(html.includes("&quot;"));
});

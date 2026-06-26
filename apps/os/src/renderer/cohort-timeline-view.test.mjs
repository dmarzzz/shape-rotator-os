import test from "node:test";
import assert from "node:assert/strict";
import { buildInsightLane, buildDefaultTimeline } from "./cohort-timeline-tracks.mjs";
import { renderTimelineLanesHtml } from "./cohort-timeline-render.mjs";

const START = Date.parse("2026-05-18T00:00:00Z");
const END = Date.parse("2026-07-25T00:00:00Z");
const NOW = Date.parse("2026-06-15T00:00:00Z");
const win = { startMs: START, endMs: END, nowMs: NOW };

const card = (week, teams, claim_text, basis) => ({
  claim_type: "insight",
  claim_text,
  content_json: { week_start: week, teams, ...(basis ? { teams_basis: basis } : {}) },
});

const names = new Map([["abra", "Abra"], ["teesql", "TeeSQL"]]);

test("buildInsightLane places attributed cards on the axis, skips unattributed", () => {
  const lane = buildInsightLane(
    [
      card("2026-06-01", ["abra"], "Abra shipped the registry spec", "inferred"),
      card("2026-06-08", ["teesql", "abra"], "TeeSQL onboarded teams", "declared"),
      card("2026-06-08", [], "untagged session note"), // no teams -> skipped
    ],
    names,
    win,
  );
  assert.equal(lane.trackKey, "insights");
  assert.equal(lane.items.length, 2, "the unattributed card is dropped");
  assert.equal(lane.items[0].team, "abra");
  assert.equal(lane.items[0].basis, "inferred");
  assert.ok(lane.items[0].fraction > 0 && lane.items[0].fraction < 1);
  assert.equal(lane.items[1].detail, "TeeSQL +1", "multi-team card notes the extra");
});

test("buildDefaultTimeline adds the insights lane only when there's attributed evidence", () => {
  const base = buildDefaultTimeline({ whatsNew: [], standingWeekly: null, people: [] }, win);
  assert.deepEqual(base.lanes.map((l) => l.trackKey), ["activity", "standing", "presence"]);

  const withInsights = buildDefaultTimeline(
    { whatsNew: [], standingWeekly: null, people: [], evidenceCards: [card("2026-06-01", ["abra"], "x")], teamNameById: names },
    win,
  );
  assert.deepEqual(withInsights.lanes.map((l) => l.trackKey), ["activity", "insights", "standing", "presence"]);
});

test("renderTimelineLanesHtml emits positioned, categorized markers + the now line", () => {
  const timeline = buildDefaultTimeline(
    {
      whatsNew: [{ date: "2026-06-02", kind: "release", label: "v1", meta: "Abra", nav: { mode: "shapes", recordId: "abra" } }],
      standingWeekly: null,
      people: [],
      evidenceCards: [card("2026-06-05", ["abra"], 'has "quotes" & <tags>', "inferred")],
      teamNameById: names,
    },
    win,
  );
  const html = renderTimelineLanesHtml(timeline);
  assert.match(html, /class="ctl"/);
  assert.match(html, /data-cat="release"/);
  assert.match(html, /data-cat="insight"/);
  assert.match(html, /data-basis="inferred"/);
  assert.match(html, /class="ctl-now"/);
  assert.match(html, /left:\d/); // positioned by fraction
  assert.match(html, /data-const-team="abra"/); // navigable
  // title is HTML-escaped (no raw < or " breaking the attribute)
  assert.match(html, /&quot;quotes&quot; &amp; &lt;tags&gt;/);
  assert.ok(!/<tags>/.test(html));
});

test("renderTimelineLanesHtml degrades gracefully on a bad axis", () => {
  assert.match(renderTimelineLanesHtml({ axis: {}, lanes: [] }), /ctl-empty/);
  assert.match(renderTimelineLanesHtml(null), /ctl-empty/);
});

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

// ── interactive (follow-board) mode ──────────────────────────────────────────
// The follow-board feeds renderTimelineLanesHtml a { axis, lanes } whose lanes
// carry { id, kind, render, count, items/points/samples }. We build that shape
// directly here (not via buildFollowedTimeline) so this slice's renderer is
// tested in isolation of the model.
const axisOf = (tl) => tl.axis;
const fbAxis = axisOf(buildDefaultTimeline({ whatsNew: [], standingWeekly: null, people: [] }, win));

const fbTimeline = {
  axis: fbAxis,
  lanes: [
    {
      id: "lane-releases", kind: "releases", subjectId: null, label: "releases",
      render: "points", removable: true, count: 1,
      items: [{ id: "i1", fraction: 0.4, category: "release", title: "shipped the registry spec", detail: "Abra", date: "2026-06-12", team: "abra", basis: "inferred", isFuture: false, tier: "public" }],
    },
    {
      id: "lane-standing", kind: "standing", subjectId: null, label: "standing",
      render: "standing", removable: true, count: 1, stageMax: 8,
      points: [{ fraction: 0.3, stage: 4, label: "week 4", teamsWithData: 3 }],
    },
    {
      id: "lane-presence", kind: "presence", subjectId: null, label: "in town",
      render: "presence", removable: true, count: 1,
      samples: [{ fraction: 0.2, present: 5, total: 9, occupancy: 0.55, isFuture: false }],
    },
  ],
};

test("renderTimelineLanesHtml (interactive) renders controllable lanes with subrow ids + remove", () => {
  const html = renderTimelineLanesHtml(fbTimeline, { interactive: true });
  // each lane is a followed, reorderable row tagged with its subscription id + kind
  assert.match(html, /class="ctl-lane is-followed"/);
  assert.match(html, /data-c2-subrow-id="lane-releases"/);
  assert.match(html, /data-row-kind="releases"/);
  // drag handle + ▴▾ move keys + remove ✕
  assert.match(html, /class="ctl-lane-label rr-frowlab"[^>]*draggable="true"/);
  assert.match(html, /data-c2-subrow-move="up"/);
  assert.match(html, /data-c2-subrow-move="down"/);
  assert.match(html, /data-c2-subrow-remove="lane-releases"/);
  // a glyph + ellipsis label text + count
  assert.match(html, /class="ctl-lane-ico rr-rowlab-ico"[^>]*><svg/);
  assert.match(html, /class="ctl-lane-tx">releases</);
  assert.match(html, /class="ctl-lane-count">1</);
});

test("renderTimelineLanesHtml (interactive) makes point markers revealable with hover tip", () => {
  const html = renderTimelineLanesHtml(fbTimeline, { interactive: true });
  // the release point is a revealable marker carrying its full payload
  assert.match(html, /class="ctl-dot[^"]*"[^>]*data-c2-timeline-item/);
  assert.match(html, /data-kind="release"/);
  assert.match(html, /data-title="shipped the registry spec"/);
  assert.match(html, /data-detail="Abra"/);
  assert.match(html, /data-date="2026-06-12"/);
  assert.match(html, /data-team="abra"/);
  assert.match(html, /data-basis="inferred"/);
  // tip text: "jun 12 · release · <title>"
  assert.match(html, /data-tip="jun 12 · release · shipped the registry spec"/);
  // the old direct-to-dossier hook is gone in interactive mode
  assert.ok(!/data-const-team/.test(html));
});

test("renderTimelineLanesHtml (interactive) leaves standing bars + presence bands non-revealable", () => {
  const html = renderTimelineLanesHtml(fbTimeline, { interactive: true });
  assert.match(html, /class="ctl-bar"/);
  assert.match(html, /class="ctl-band/);
  // only .ctl-dot points reveal — bars/bands carry no data-c2-timeline-item
  assert.ok(!/ctl-bar[^>]*data-c2-timeline-item/.test(html));
  assert.ok(!/ctl-band[^>]*data-c2-timeline-item/.test(html));
});

test("renderTimelineLanesHtml (interactive) shows a friendly empty board with no lanes", () => {
  const html = renderTimelineLanesHtml({ axis: fbAxis, lanes: [] }, { interactive: true });
  assert.match(html, /class="ctl-empty">no lanes followed — add one</);
});

test("renderTimelineLanesHtml read-only output is unchanged by the options arg default", () => {
  const tl = buildDefaultTimeline(
    { whatsNew: [{ date: "2026-06-02", kind: "release", label: "v1", meta: "Abra", nav: { mode: "shapes", recordId: "abra" } }], standingWeekly: null, people: [] },
    win,
  );
  // no options vs explicit interactive:false must be identical, and still legacy
  assert.equal(renderTimelineLanesHtml(tl), renderTimelineLanesHtml(tl, { interactive: false }));
  assert.match(renderTimelineLanesHtml(tl), /data-const-team="abra"/);
  assert.ok(!/data-c2-timeline-item/.test(renderTimelineLanesHtml(tl)));
});

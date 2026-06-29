import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorMeta, buildViewer, buildFeedView, buildBlendedFeed, feedItemLabel,
} from "./activity-feed.mjs";
import { DEFAULT_PREFS } from "./cohort-prefs.mjs";

const NOW = Date.parse("2026-06-25T12:00:00Z");
const at = (h) => new Date(NOW - h * 3600000).toISOString();

function ev(o) {
  return {
    id: o.id, record_id: o.record_id || o.actor, actor: o.actor ?? null,
    event_type: o.event_type || "profile_edit", field: o.field ?? null,
    value: o.value || {}, weight: o.weight || "medium", created_at: o.created_at || at(1),
  };
}

const SURFACE = {
  people: [
    { record_id: "me", name: "Me", team: "t1", skill_areas: ["rust"] },
    { record_id: "ada", name: "Ada", team: "t1", skill_areas: ["ai"] },
    { record_id: "ben", name: "Ben", team: "t2", skill_areas: [] },
  ],
};

test("buildAuthorMeta indexes team + skillAreas + name by record_id", () => {
  const meta = buildAuthorMeta(SURFACE);
  assert.deepEqual(meta.ada, { team: "t1", skillAreas: ["ai"], name: "Ada" });
  assert.equal(meta.ben.team, "t2");
});

test("buildViewer derives the viewer bundle + connectionIds from own with_whom events", () => {
  const surface = {
    ...SURFACE,
    cohort_events: [
      ev({ id: "1", actor: "me", event_type: "transcript", value: { with_whom: ["ben"] } }),
      ev({ id: "2", actor: "ada", event_type: "transcript", value: { with_whom: ["ben"] } }), // not mine
    ],
  };
  const v = buildViewer(surface, { record_id: "me" });
  assert.equal(v.recordId, "me");
  assert.equal(v.team, "t1");
  assert.deepEqual(v.skillAreas, ["rust"]);
  assert.deepEqual(v.connectionIds, ["ben"]); // only from my own event
});

test("buildFeedView peels own events, rolls up quiet, and ranks the rest (for_you)", () => {
  const events = [
    ev({ id: "mine", actor: "me", weight: "loud", event_type: "transcript" }),
    ev({ id: "quiet1", actor: "ada", weight: "quiet", event_type: "profile_edit" }),
    ev({ id: "quiet2", actor: "ben", weight: "quiet", event_type: "profile_edit" }),
    ev({ id: "loud", actor: "ben", weight: "loud", event_type: "transcript", created_at: at(1) }),
    ev({ id: "med", actor: "ada", weight: "medium", event_type: "profile_edit", field: "skills", created_at: at(2) }),
  ];
  const viewer = buildViewer(SURFACE, { record_id: "me" });
  const view = buildFeedView(events, viewer, DEFAULT_PREFS, { now: NOW, authorMeta: buildAuthorMeta(SURFACE) });
  assert.equal(view.mine.length, 1);
  assert.equal(view.mine[0].id, "mine");
  assert.equal(view.quietCount, 2);
  assert.equal(view.items.length, 2); // loud + med, ranked
  assert.ok(view.items.every((e) => e.weight !== "quiet"));
});

test("global mode is raw recency (newest first), not scored", () => {
  const events = [
    ev({ id: "older", actor: "ben", weight: "loud", created_at: at(5) }),
    ev({ id: "newer", actor: "ada", weight: "medium", created_at: at(1) }),
  ];
  const prefs = { ...DEFAULT_PREFS, feed_mode: "global" };
  const view = buildFeedView(events, { recordId: "me" }, prefs, { now: NOW });
  assert.equal(view.mode, "global");
  assert.equal(view.items[0].id, "newer"); // recency wins regardless of weight
});

test("buildBlendedFeed merges asks + events: own peels, quiet rolls up, closed splits", () => {
  const events = [
    ev({ id: "ev-mine", actor: "me", weight: "loud", event_type: "transcript", created_at: at(1) }),
    ev({ id: "ev-quiet", actor: "ada", weight: "quiet", event_type: "profile_edit", created_at: at(1) }),
    ev({ id: "ev-loud", actor: "ada", weight: "loud", event_type: "transcript", created_at: at(2) }),
  ];
  // asks are pre-statused (the caller runs asksWithStatus); _expired/status drive splitting.
  const asks = [
    { record_id: "ask-open", record_type: "ask", status: "open", intent: "ask", topic: "pair on rust",
      author: "ben", posted_at: "2026-06-25", skill_areas: ["rust"], _expired: false, _lastEventAt: at(0.5) },
    { record_id: "ask-done", record_type: "ask", status: "done", topic: "old", author: "ben", _expired: false },
  ];
  const viewer = buildViewer(SURFACE, { record_id: "me" });
  const prefs = { ...DEFAULT_PREFS, feed_mode: "for_you" };
  const view = buildBlendedFeed({ events, asks, viewer, prefs, opts: { now: NOW, lastSeen: 0, authorMeta: buildAuthorMeta(SURFACE) } });

  assert.ok(view.mine.some((e) => e.id === "ev-mine"), "own event peels into mine");
  assert.equal(view.quietCount, 1, "quiet event rolled up");
  assert.equal(view.closed.length, 1, "done ask split into closed");
  assert.equal(view.closed[0].record_id, "ask-done");
  const kinds = view.items.map((i) => i._feedKind);
  assert.ok(kinds.includes("ask") && kinds.includes("event"), "feed blends both kinds");
  assert.equal(view.items.find((i) => i._feedKind === "ask")._ask.record_id, "ask-open");
});

test("muted authors/types are filtered before the view is built", () => {
  const events = [
    ev({ id: "a", actor: "ada", weight: "loud", event_type: "transcript" }),
    ev({ id: "b", actor: "ben", weight: "loud", event_type: "contest" }),
  ];
  const prefs = { ...DEFAULT_PREFS, muted_authors: ["ada"], muted_event_types: ["contest"] };
  const view = buildFeedView(events, { recordId: "me" }, prefs, { now: NOW });
  assert.equal(view.items.length, 0);
});

test("feedItemLabel renders a human line per event type", () => {
  const nameOf = (id) => ({ ada: "Ada", ben: "Ben" }[id] || id);
  assert.equal(feedItemLabel(ev({ actor: "ada", event_type: "profile_edit", field: "now", value: { fields: ["now"] } }), nameOf),
    "Ada updated their focus");
  assert.equal(feedItemLabel(ev({ actor: "ada", event_type: "profile_edit", field: "now", value: { fields: ["now", "skills"] } }), nameOf),
    "Ada updated their focus +1 more");
  assert.equal(feedItemLabel(ev({ actor: "ben", event_type: "self_report", value: { mode: "current_state_refresh" } }), nameOf),
    "Ben refreshed where they are now from recent work");
  assert.equal(feedItemLabel(ev({ actor: "ben", event_type: "self_report", value: { mode: "current_state_refresh", team_fields: ["traction"] } }), nameOf),
    "Ben refreshed where they are now and queued project evidence");
  assert.equal(feedItemLabel(ev({ actor: "ben", event_type: "transcript", value: { title: "Call" } }), nameOf),
    "Ben shared a transcript: “Call”");
  assert.equal(feedItemLabel(ev({ actor: "ada", event_type: "contest" }), nameOf), "Ada contested a claim");
  // field-phrase coverage (humanField is module-private; exercised via the label):
  assert.equal(feedItemLabel(ev({ actor: "ben", event_type: "profile_edit", field: "seeking", value: { fields: ["seeking"] } }), nameOf),
    "Ben updated what they're seeking");
});

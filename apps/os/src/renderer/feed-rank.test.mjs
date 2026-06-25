import test from "node:test";
import assert from "node:assert/strict";
import { rankFeed } from "./feed-rank.mjs";

const NOW = Date.parse("2026-06-25T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

function ev(over = {}) {
  return {
    id: over.id || Math.random().toString(36).slice(2),
    record_id: over.record_id || over.actor || "x",
    actor: over.actor ?? null,
    event_type: over.event_type || "profile_edit",
    field: over.field ?? null,
    value: over.value || {},
    weight: over.weight || "medium",
    created_at: over.created_at || hoursAgo(1),
  };
}

test("the viewer's own events peel into `mine`, not the feed", () => {
  const events = [
    ev({ actor: "me", record_id: "me", event_type: "transcript" }),
    ev({ actor: "other", record_id: "other" }),
  ];
  const { feed, mine } = rankFeed(events, { recordId: "me" }, { now: NOW });
  assert.equal(mine.length, 1);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].actor, "other");
});

test("recency decays: a fresh event outranks an old one, all else equal", () => {
  const events = [
    ev({ id: "old", actor: "a", created_at: hoursAgo(200) }),
    ev({ id: "new", actor: "b", created_at: hoursAgo(1) }),
  ];
  const { feed } = rankFeed(events, { recordId: "me" }, { now: NOW });
  assert.equal(feed[0].id, "new");
  assert.ok(feed[0]._score > feed[1]._score);
});

test("affinity boosts a connection, same-team, shared-skill, and interest-tag author", () => {
  const base = { created_at: hoursAgo(1), weight: "medium" };
  const events = [
    ev({ ...base, id: "stranger", actor: "s", record_id: "s" }),
    ev({ ...base, id: "conn", actor: "c", record_id: "c" }),
  ];
  const viewer = { recordId: "me", team: "t1", skillAreas: ["rust"], connectionIds: ["c"] };
  const { feed } = rankFeed(events, viewer, { now: NOW });
  assert.equal(feed[0].id, "conn", "the connection outranks the stranger");

  // same-team author beats an unaffiliated one
  const teamRanked = rankFeed(
    [ev({ ...base, id: "team", actor: "tm", record_id: "tm" }), ev({ ...base, id: "x", actor: "z", record_id: "z" })],
    viewer, { now: NOW, authorMeta: { tm: { team: "t1" }, z: { team: "t9" } } },
  );
  assert.equal(teamRanked.feed[0].id, "team");

  // interest-tag mention beats a no-match event
  const interestRanked = rankFeed(
    [ev({ ...base, id: "match", actor: "m", record_id: "m", value: { skill_areas: ["AI"] } }),
     ev({ ...base, id: "nomatch", actor: "n", record_id: "n" })],
    { recordId: "me" }, { now: NOW, interestTags: ["ai"] },
  );
  assert.equal(interestRanked.feed[0].id, "match");
});

test("weight amplifies: a loud event outranks a quiet one of the same age/affinity", () => {
  const events = [
    ev({ id: "quiet", actor: "a", weight: "quiet", created_at: hoursAgo(1) }),
    ev({ id: "loud", actor: "b", weight: "loud", created_at: hoursAgo(1) }),
  ];
  const { feed } = rankFeed(events, { recordId: "me" }, { now: NOW });
  assert.equal(feed[0].id, "loud");
});

test("unseen events are marked _isNew and counted", () => {
  const lastSeen = NOW - 2 * 3600000; // 2h ago
  const events = [
    ev({ id: "fresh", actor: "a", created_at: hoursAgo(1) }), // after lastSeen
    ev({ id: "stale", actor: "b", created_at: hoursAgo(5) }), // before lastSeen
  ];
  const { feed, newCount } = rankFeed(events, { recordId: "me" }, { now: NOW, lastSeen });
  assert.equal(newCount, 1);
  assert.equal(feed.find((e) => e.id === "fresh")._isNew, true);
  assert.equal(feed.find((e) => e.id === "stale")._isNew, false);
});

test("empty / non-array input is safe", () => {
  assert.deepEqual(rankFeed(null, {}, { now: NOW }), { feed: [], mine: [], newCount: 0 });
  assert.deepEqual(rankFeed([], { recordId: "me" }, { now: NOW }), { feed: [], mine: [], newCount: 0 });
});

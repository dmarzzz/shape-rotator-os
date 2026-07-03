import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTopicLabel,
  topicSlug,
  streamKey,
  parseStreamKey,
  buildStreamItems,
  groupStreamItems,
  articleTopics,
  distilledTopics,
  cardTopic,
  buildTopicIndex,
  topicPageData,
  claimsForSession,
} from "./context-lenses.mjs";

test("normalizeTopicLabel folds case, underscores, hyphens, and spacing", () => {
  assert.equal(normalizeTopicLabel("Agent_Infra"), "agent infra");
  assert.equal(normalizeTopicLabel("agent-infra"), "agent infra");
  assert.equal(normalizeTopicLabel("  Agent   Infra  "), "agent infra");
  assert.equal(normalizeTopicLabel(""), "");
  assert.equal(normalizeTopicLabel(null), "");
});

test("topicSlug makes multi-word topics one filter token", () => {
  assert.equal(topicSlug("Agent Infrastructure"), "agent-infrastructure");
});

test("stream keys round-trip, including ids that contain colons", () => {
  const key = streamKey("article", "supabase-article:abc");
  assert.equal(key, "article:supabase-article:abc");
  assert.deepEqual(parseStreamKey(key), { kind: "article", id: "supabase-article:abc" });
  assert.deepEqual(parseStreamKey(""), { kind: "", id: "" });
});

test("buildStreamItems merges species newest-first with undated last", () => {
  const items = buildStreamItems({
    articles: [
      { id: "a-old", date: "2026-06-01T10:00:00Z" },
      { id: "a-undated" },
    ],
    distilled: [
      { id: "d-new", date: "2026-07-01" },
      { id: "d-mid", created_at: "2026-06-20T09:00:00Z" },
    ],
    rawScripts: [
      { id: "r-undated" },
      { id: "r-recent", date: "2026-06-28" },
    ],
  });
  assert.deepEqual(
    items.map((i) => streamKey(i.kind, i.id)),
    [
      "readout:d-new",
      "raw:r-recent",
      "readout:d-mid",
      "article:a-old",
      "article:a-undated",
      "raw:r-undated",
    ],
  );
});

test("groupStreamItems buckets this week / last week / month / undated", () => {
  const now = new Date("2026-07-03T12:00:00"); // Friday; week starts Mon Jun 29
  const items = buildStreamItems({
    distilled: [
      { id: "wk", date: "2026-07-01" },
      { id: "lastwk", date: "2026-06-26" },
      { id: "june", date: "2026-06-10" },
    ],
    rawScripts: [{ id: "undated" }],
  });
  const groups = groupStreamItems(items, now);
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.length]),
    [["this week", 1], ["last week", 1], ["june 2026", 1], ["undated", 1]],
  );
});

test("topic extractors read skill_areas+tags, themes, and topic_label", () => {
  assert.deepEqual(
    articleTopics({ skill_areas: ["Agent_Infra"], tags: ["memory", "agent infra"] }),
    ["agent infra", "memory"],
  );
  assert.deepEqual(distilledTopics({ themes: ["Memory", "memory"] }), ["memory"]);
  assert.equal(cardTopic({ content_json: { topic_label: "Social-Routing" } }), "social routing");
  assert.equal(cardTopic({}), "");
});

test("buildTopicIndex unions the three sources with per-species counts", () => {
  const topics = buildTopicIndex({
    articles: [{ id: "a1", skill_areas: ["memory"] }],
    distilled: [
      { id: "d1", themes: ["memory", "handoffs"] },
      { id: "d2", themes: ["Memory"] },
    ],
    cards: [{ id: "c1", content_json: { topic_label: "memory" } }],
  });
  assert.deepEqual(
    topics.map((t) => [t.label, t.hints, t.claims, t.sessions, t.total]),
    [["memory", 1, 1, 2, 4], ["handoffs", 0, 0, 1, 1]],
  );
});

test("topicPageData orders hints, confidence-ranked claims, newest sessions", () => {
  const data = topicPageData("Memory", {
    articles: [
      { id: "a1", skill_areas: ["memory"] },
      { id: "a2", skill_areas: ["routing"] },
    ],
    distilled: [
      { id: "d-old", themes: ["memory"], date: "2026-06-01" },
      { id: "d-new", themes: ["memory"], date: "2026-07-01" },
    ],
    cards: [
      { id: "c-low", confidence: 0.4, content_json: { topic_label: "memory" } },
      { id: "c-high", confidence: 0.9, content_json: { topic_label: "memory" } },
      { id: "c-other", confidence: 0.99, content_json: { topic_label: "routing" } },
    ],
  });
  assert.deepEqual(data.hints.map((h) => h.id), ["a1"]);
  assert.deepEqual(data.claims.map((c) => c.id), ["c-high", "c-low"]);
  assert.deepEqual(data.sessions.map((s) => s.id), ["d-new", "d-old"]);
});

test("claimsForSession matches same week + shared team", () => {
  const session = { id: "d1", week_start: "2026-06-29", teams: ["Loom"], themes: ["memory"] };
  const cards = [
    { id: "hit", content_json: { week_start: "2026-06-29", teams: ["loom"] } },
    { id: "other-team", content_json: { week_start: "2026-06-29", teams: ["fern"] } },
    { id: "other-week", content_json: { week_start: "2026-06-22", teams: ["loom"] } },
  ];
  assert.deepEqual(claimsForSession(cards, session).map((c) => c.id), ["hit"]);
});

test("claimsForSession falls back to topic∈themes when teams are stripped", () => {
  const session = { id: "d1", date: "2026-07-01", teams: [], themes: ["memory"] };
  const cards = [
    { id: "topical", created_at: "2026-07-01T15:00:00Z", content_json: { topic_label: "Memory" } },
    { id: "off-topic", created_at: "2026-07-01T15:00:00Z", content_json: { topic_label: "routing" } },
  ];
  assert.deepEqual(claimsForSession(cards, session).map((c) => c.id), ["topical"]);
});

test("claimsForSession returns nothing for undated sessions or null", () => {
  assert.deepEqual(claimsForSession([{ id: "c" }], { id: "d" }), []);
  assert.deepEqual(claimsForSession([{ id: "c" }], null), []);
});

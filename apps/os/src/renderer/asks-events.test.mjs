import test from "node:test";
import assert from "node:assert/strict";
import { buildAskEventValue, reduceAsks, reduceAskGroup } from "./asks-events.mjs";

const at = (iso) => `2026-06-${iso}T12:00:00Z`;

function ev(record_id, action, extra = {}) {
  const { actor = null, created_at = at("20"), id = `${record_id}:${action}`, ...value } = extra;
  return { id, record_id, actor, event_type: "ask", value: { action, ...value }, created_at };
}

test("buildAskEventValue(post) whitelists + bounds fields", () => {
  const v = buildAskEventValue("post", {
    intent: "ask", verb: "pair on", topic: "help with dstack",
    skill_areas: ["DStack", "dstack", "TEE"], body: "x".repeat(5000),
    author: "ada", junk: "nope",
  });
  assert.equal(v.action, "post");
  assert.equal(v.topic, "help with dstack");
  assert.deepEqual(v.skill_areas, ["dstack", "tee"]); // lowercased + deduped
  assert.equal(v.body.length, 2000);                   // capped
  assert.equal(v.junk, undefined);                     // not whitelisted
});

test("buildAskEventValue lifecycle actions carry only what they change", () => {
  assert.deepEqual(buildAskEventValue("claim", { actor: "ben" }), { action: "claim", claimed_by: "ben" });
  assert.deepEqual(buildAskEventValue("join", { actor: "ben" }), { action: "join", joined_by: ["ben"] });
  assert.deepEqual(buildAskEventValue("done", {}), { action: "done" });
  assert.deepEqual(buildAskEventValue("cancel", {}), { action: "cancel" });
});

test("reduceAsks: a post creates an open ask", () => {
  const asks = reduceAsks([ev("a1", "post", { actor: "ada", topic: "pair on x", intent: "ask" })]);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].record_id, "a1");
  assert.equal(asks[0].status, "open");
  assert.equal(asks[0].topic, "pair on x");
  assert.equal(asks[0].author, "ada");
});

test("reduceAsks: come_join post seeds joined_by with the author", () => {
  const [ask] = reduceAsks([ev("a1", "post", { actor: "ada", intent: "come_join", topic: "food run" })]);
  assert.deepEqual(ask.joined_by, ["ada"]);
});

test("reduceAsks: claim -> claimed, join -> unioned, done -> done (any order)", () => {
  const asks = reduceAsks([
    ev("a1", "done", { actor: "ben", created_at: at("23") }),
    ev("a1", "post", { actor: "ada", intent: "ask", topic: "t", created_at: at("20") }),
    ev("a1", "join", { actor: "cat", created_at: at("21") }),
    ev("a1", "join", { actor: "cat", created_at: at("21") }), // dup
    ev("a1", "claim", { actor: "ben", claimed_by: "ben", created_at: at("22") }),
  ]);
  const ask = asks[0];
  assert.equal(ask.status, "done");          // last lifecycle wins after sort
  assert.equal(ask.claimed_by, "ben");
  assert.deepEqual(ask.joined_by, ["cat"]);  // deduped
  assert.equal(ask._lastEventAt, at("23"));  // newest event timestamp
});

test("reduceAsks: edit overlays fields on the posted ask", () => {
  const asks = reduceAsks([
    ev("a1", "post", { actor: "ada", topic: "old", location: "online", created_at: at("20") }),
    ev("a1", "edit", { actor: "ada", topic: "new topic", created_at: at("21") }),
  ]);
  assert.equal(asks[0].topic, "new topic");
  assert.equal(asks[0].location, "online"); // untouched field survives
});

test("reduceAsks: an orphan mutation with no post and no baseline is dropped", () => {
  const asks = reduceAsks([ev("ghost", "claim", { actor: "ben" })]);
  assert.deepEqual(asks, []);
});

test("reduceAsks: markdown baseline survives with no events, and events mutate it", () => {
  const base = [
    { record_id: "seed1", record_type: "ask", topic: "seed", status: "open", posted_at: "2026-06-10", joined_by: [] },
    { record_id: "seed2", record_type: "ask", topic: "other", status: "open", posted_at: "2026-06-11", joined_by: [] },
  ];
  const asks = reduceAsks([ev("seed1", "claim", { actor: "ben", claimed_by: "ben", created_at: at("20") })], base);
  const byId = Object.fromEntries(asks.map((a) => [a.record_id, a]));
  assert.equal(byId.seed1.status, "claimed");          // baseline ask, mutated by event
  assert.equal(byId.seed1.claimed_by, "ben");
  assert.equal(byId.seed2.status, "open");             // baseline ask, untouched
  assert.equal(byId.seed1._lastEventAt, at("20"));     // claim bumped recency past posted_at
});

test("reduceAskGroup folds a single group; null when unbuildable", () => {
  assert.equal(reduceAskGroup([ev("x", "join", { actor: "a" })]), null);
  const built = reduceAskGroup([ev("x", "post", { actor: "a", topic: "t" })]);
  assert.equal(built.topic, "t");
});

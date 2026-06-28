import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("apps/os/src/renderer/whats-new.js");
const source = fs.readFileSync(sourcePath, "utf8");
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { markModeSeen, unreadCounts, unreadRecordsForMode } = mod;

function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
  return store;
}

function surface(overrides = {}) {
  return {
    teams: [{ record_id: "team-a", name: "Team A" }],
    people: [],
    clusters: [],
    asks: [],
    program: [{ record_id: "program-a", title: "Program" }],
    ...overrides,
  };
}

test("unreadCounts primes valid empty modes so the first later record is unread", () => {
  installLocalStorage();

  assert.deepEqual(unreadCounts(surface()), {});
  assert.deepEqual(unreadCounts(surface({
    asks: [{ record_id: "ask-a", title: "Need help" }],
  })), { activity: 1 });
});

test("markModeSeen clears an unread mode by storing the current fingerprints", () => {
  installLocalStorage();
  const next = surface({ asks: [{ record_id: "ask-a", title: "Need help" }] });

  unreadCounts(surface());
  assert.deepEqual(unreadCounts(next), { activity: 1 });
  markModeSeen("activity", next);
  assert.deepEqual(unreadCounts(next), {});
});

test("unreadRecordsForMode returns unread activity records without priming", () => {
  installLocalStorage();
  const next = surface({ asks: [{ record_id: "join-a", intent: "come_join", topic: "Rock climbing" }] });

  assert.deepEqual(unreadRecordsForMode("activity", next), []);
  unreadCounts(surface());
  const rows = unreadRecordsForMode("activity", next);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record.record_id, "join-a");
  markModeSeen("activity", next);
  assert.deepEqual(unreadRecordsForMode("activity", next), []);
});

test("legacy asks mode marks the merged activity source seen", () => {
  installLocalStorage();
  const next = surface({ asks: [{ record_id: "ask-a", title: "Need help" }] });

  unreadCounts(surface());
  assert.deepEqual(unreadCounts(next), { activity: 1 });
  markModeSeen("asks", next);
  assert.deepEqual(unreadCounts(next), {});
});

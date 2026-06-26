import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeEvents, digestFromEvents, scanGithubActivity } from "./gh-self-report.mjs";

const events = [
  { type: "PushEvent", repo: { name: "lsdan/teesql" }, payload: { commits: [{ message: "add distiller" }] } },
  { type: "PushEvent", repo: { name: "lsdan/side-hobby" }, payload: { commits: [{ message: "unrelated tinkering" }] } },
  { type: "ReleaseEvent", repo: { name: "lsdan/teesql" }, payload: { release: { tag_name: "v0.3" } } },
];

test("summarizeEvents with no scope includes everything (back-compat)", () => {
  const s = summarizeEvents(events);
  assert.equal(s.commits.length, 2);
  assert.deepEqual(s.repos.sort(), ["lsdan/side-hobby", "lsdan/teesql"]);
});

test("summarizeEvents scoped to the focus repo drops unrelated work", () => {
  const s = summarizeEvents(events, { repos: ["lsdan/teesql"] });
  assert.equal(s.commits.length, 1);
  assert.equal(s.commits[0].message, "add distiller");
  assert.deepEqual(s.repos, ["lsdan/teesql"]);
  assert.equal(s.releases.length, 1);
  const digest = digestFromEvents("lsdan", s);
  assert.ok(digest.includes("add distiller"));
  assert.ok(!digest.includes("side-hobby")); // the off-project repo never appears
});

test("scanGithubActivity caches per repo-scope so scoped ≠ unscoped", async () => {
  const calls = [];
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    return { status: 200, json: async () => events };
  };
  const unscoped = await scanGithubActivity("lsdan", { fetchImpl });
  const scoped = await scanGithubActivity("lsdan", { fetchImpl, repos: ["lsdan/teesql"] });
  assert.ok(unscoped.digest.includes("side-hobby"));
  assert.ok(!scoped.digest.includes("side-hobby"));
  assert.equal(calls.length, 2); // distinct cache keys ⇒ two fetches, not one reused
  // a repeat scoped call is served from cache (no third fetch)
  await scanGithubActivity("lsdan", { fetchImpl, repos: ["lsdan/teesql"] });
  assert.equal(calls.length, 2);
  delete global.localStorage;
});

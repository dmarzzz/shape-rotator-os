import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHandle,
  resolvePersonHandle,
  summarizeEvents,
  digestFromEvents,
  scanGithubActivity,
} from "./gh-self-report.mjs";

test("normalizeHandle strips @, github URLs, and trailing segments", () => {
  assert.equal(normalizeHandle("@amiller"), "amiller");
  assert.equal(normalizeHandle("https://github.com/amiller"), "amiller");
  assert.equal(normalizeHandle("github.com/amiller/"), "amiller");
  assert.equal(normalizeHandle("amiller?tab=repos"), "amiller");
  assert.equal(normalizeHandle("  "), "");
});

test("resolvePersonHandle prefers links.github, then gh_handle, then github", () => {
  assert.equal(resolvePersonHandle({ links: { github: "https://github.com/a" } }), "a");
  assert.equal(resolvePersonHandle({ gh_handle: "@b" }), "b");
  assert.equal(resolvePersonHandle({ github: "c" }), "c");
  assert.equal(resolvePersonHandle({}), "");
  assert.equal(resolvePersonHandle(null), "");
});

const SAMPLE = [
  { type: "PushEvent", repo: { name: "o/repo-a" }, payload: { commits: [
    { message: "feat: wire mirror into shipped view\n\nbody" },
    { message: "Merge branch 'main'" },           // merge → dropped
    { message: "fix: dedupe events" },
  ] } },
  { type: "PullRequestEvent", repo: { name: "o/repo-a" }, payload: { action: "closed", pull_request: { number: 214, title: "Public cohort connections", merged: true } } },
  { type: "PullRequestEvent", repo: { name: "o/repo-b" }, payload: { action: "opened", pull_request: { number: 9, title: "WIP draft" } } },
  { type: "ReleaseEvent", repo: { name: "o/repo-b" }, payload: { release: { tag_name: "v0.2.0" } } },
  { type: "CreateEvent", repo: { name: "o/side" }, payload: { ref_type: "repository" } },
  { type: "WatchEvent", repo: { name: "o/ignored" }, payload: {} }, // ignored type
];

test("summarizeEvents extracts commits (non-merge), PRs, releases, new repos, repo set", () => {
  const s = summarizeEvents(SAMPLE);
  assert.deepEqual(s.commits.map((c) => c.message), ["feat: wire mirror into shipped view", "fix: dedupe events"]);
  assert.equal(s.pushCount, 1);
  assert.deepEqual(s.prs.map((p) => `${p.action}:${p.number}`), ["merged:214", "opened:9"]);
  assert.deepEqual(s.releases, [{ repo: "o/repo-b", tag: "v0.2.0" }]);
  assert.equal(s.created.filter((c) => c.refType === "repository").length, 1);
  assert.ok(s.repos.includes("o/repo-a") && s.repos.includes("o/side") && s.repos.includes("o/ignored"));
});

test("digestFromEvents renders a compact, bounded, prompt-ready string", () => {
  const d = digestFromEvents("amiller", summarizeEvents(SAMPLE));
  assert.ok(d.includes("handle: amiller"));
  assert.ok(d.includes("1 push (2 commits)"));
  assert.ok(d.includes("1 PR merged"));
  assert.ok(d.includes("1 release"));
  assert.ok(d.includes("1 new repo"));
  assert.ok(d.includes("- o/repo-a: feat: wire mirror into shipped view"));
  assert.ok(!d.includes("Merge branch"));            // merge commit dropped
  assert.ok(d.includes("releases: o/repo-b v0.2.0"));
  assert.ok(d.includes("repos touched: o/repo-a"));
});

test("digestFromEvents is empty when there's no useful activity", () => {
  assert.equal(digestFromEvents("x", summarizeEvents([{ type: "WatchEvent", repo: { name: "o/r" }, payload: {} }])), "");
  assert.equal(digestFromEvents("x", summarizeEvents([])), "");
});

test("scanGithubActivity: empty handle short-circuits without fetching", async () => {
  let called = false;
  const r = await scanGithubActivity("", { fetchImpl: async () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("scanGithubActivity: 200 → ok with a digest; sends the public username only", async () => {
  let seenUrl = "";
  const fetchImpl = async (url) => { seenUrl = url; return { status: 200, json: async () => SAMPLE }; };
  const r = await scanGithubActivity("@amiller", { fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(r.digest.includes("handle: amiller"));
  assert.ok(seenUrl.startsWith("https://api.github.com/users/amiller/events/public"));
});

test("scanGithubActivity: non-200 and network throw resolve to ok:false", async () => {
  const r403 = await scanGithubActivity("a", { fetchImpl: async () => ({ status: 403 }) });
  assert.deepEqual({ ok: r403.ok, status: r403.status }, { ok: false, status: 403 });
  const rNet = await scanGithubActivity("b", { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(rNet.ok, false);
});

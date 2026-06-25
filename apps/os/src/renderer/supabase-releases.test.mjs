import test from "node:test";
import assert from "node:assert/strict";
import { fetchReleasesFeed, normalizeReleasesPayload, publicReleasesFeedUrl } from "./supabase-releases.mjs";

const CONFIG = { url: "https://db.example", anonKey: "anon-key" };
const okRow = { payload: { whats_new: [{ date: "2026-06-01", label: "v1" }], github_releases: [] } };

test("normalizeReleasesPayload keeps well-formed items, nulls when both lists empty", () => {
  assert.deepEqual(normalizeReleasesPayload(okRow).whatsNew, [{ date: "2026-06-01", label: "v1" }]);
  assert.equal(normalizeReleasesPayload({ payload: { whats_new: [{ label: "no date" }] } }), null);
  assert.equal(normalizeReleasesPayload(null), null);
});

test("publicReleasesFeedUrl targets the public_releases_feed row", () => {
  assert.match(publicReleasesFeedUrl("https://db.example"), /\/rest\/v1\/public_releases_feed\?.*id=eq\.current/);
});

test("fetchReleasesFeed: supabase / unconfigured / empty / error", async () => {
  // supabase
  const ok = await fetchReleasesFeed({ config: CONFIG, fetchImpl: async () => ({ ok: true, json: async () => [okRow] }) });
  assert.equal(ok.source, "supabase");
  assert.deepEqual(ok.whatsNew, [{ date: "2026-06-01", label: "v1" }]);
  // unconfigured (no anon key) — no fetch
  let called = false;
  const r1 = await fetchReleasesFeed({ config: {}, fetchImpl: async () => { called = true; return { ok: true, json: async () => [] }; } });
  assert.equal(r1.source, "unconfigured");
  assert.equal(called, false);
  // empty (row present but payload has no usable items)
  const r2 = await fetchReleasesFeed({ config: CONFIG, fetchImpl: async () => ({ ok: true, json: async () => [{ payload: {} }] }) });
  assert.equal(r2.source, "empty");
  // error (non-ok + network throw), with error string
  const r3 = await fetchReleasesFeed({ config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(r3.source, "error");
  assert.match(r3.error, /500/);
  const r4 = await fetchReleasesFeed({ config: CONFIG, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(r4.source, "error");
  assert.match(r4.error, /offline/);
});

test("fetchReleasesFeed sends the anon apikey + bearer", async () => {
  let headers = null;
  await fetchReleasesFeed({ config: CONFIG, fetchImpl: async (_u, init) => { headers = init.headers; return { ok: true, json: async () => [okRow] }; } });
  assert.equal(headers.apikey, "anon-key");
  assert.equal(headers.authorization, "Bearer anon-key");
});

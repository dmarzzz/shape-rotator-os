import test from "node:test";
import assert from "node:assert/strict";
import { buildUpsertRequest, publishConnections } from "./publish-connections-to-supabase.mjs";

test("buildUpsertRequest targets the right row with merge-on-id and a bumped updated_at", () => {
  const { url, body } = buildUpsertRequest({
    url: "https://x.supabase.co/",
    payload: { schema_version: 1, edges: [{ from: "a", to: "b", score: 0.5 }] },
    now: "2026-06-24T00:00:00.000Z",
  });
  assert.equal(url, "https://x.supabase.co/rest/v1/public_cohort_connections?on_conflict=id");
  assert.equal(body.id, "current");
  assert.equal(body.updated_at, "2026-06-24T00:00:00.000Z");
  assert.equal(body.payload.edges.length, 1);
});

test("buildUpsertRequest rejects a malformed payload", () => {
  assert.throws(() => buildUpsertRequest({ url: "https://x", payload: {} }), /edges/);
  assert.throws(() => buildUpsertRequest({ url: "", payload: { edges: [] } }), /SUPABASE_URL/);
});

test("publishConnections skips cleanly when Supabase env is absent", async () => {
  const r = await publishConnections({ url: "", key: "", payload: { edges: [{ from: "a", to: "b" }] } });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /SUPABASE_URL/);
});

test("publishConnections POSTs the payload with service-role headers", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201 };
  };
  const r = await publishConnections({
    url: "https://x.supabase.co",
    key: "service-role-key",
    payload: { schema_version: 1, edges: [{ from: "a", to: "b", score: 0.5 }, { from: "c", to: "d", score: 0.3 }] },
    fetchImpl,
    now: "2026-06-24T00:00:00.000Z",
  });
  assert.equal(r.skipped, false);
  assert.equal(r.edges, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.apikey, "service-role-key");
  assert.match(calls[0].opts.headers.prefer, /merge-duplicates/);
});

test("publishConnections skips when neither payload nor artifact is available", async () => {
  const r = await publishConnections({ url: "https://x", key: "k", payload: null, artifactPath: "/no/such/connections.json" });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no connections artifact/);
});

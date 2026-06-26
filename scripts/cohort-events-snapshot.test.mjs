import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, fetchAllEvents } from "./publish-cohort-events-snapshot.mjs";

test("buildSnapshot strips claim_token_hash, sorts oldest-first, and counts", () => {
  const rows = [
    { id: "2", record_id: "p1", created_at: "2026-06-25T05:00:00Z", value: {}, claim_token_hash: "SECRET" },
    { id: "1", record_id: "p1", created_at: "2026-06-25T01:00:00Z", value: {}, claim_token_hash: "SECRET2" },
    { id: null }, // dropped (no id)
  ];
  const snap = buildSnapshot(rows, { dateStr: "2026-06-25", generatedAt: "2026-06-25T12:00:00Z" });
  assert.equal(snap.count, 2);
  assert.equal(snap.date, "2026-06-25");
  assert.equal(snap.events[0].id, "1"); // oldest first
  assert.equal(snap.events[1].id, "2");
  assert.ok(!("claim_token_hash" in snap.events[0]), "hash is stripped from the committed file");
  assert.ok(!("claim_token_hash" in snap.events[1]));
});

test("buildSnapshot is safe on empty/garbage input", () => {
  assert.deepEqual(buildSnapshot(null, {}), { generated_at: null, date: null, count: 0, events: [] });
});

test("fetchAllEvents pages via Range until a short page, and sends service_role auth", async () => {
  const pages = {
    "0-1": [{ id: "1", created_at: "a" }, { id: "2", created_at: "b" }], // full page ⇒ continue
    "2-3": [{ id: "3", created_at: "c" }],                               // short page ⇒ stop
  };
  const seenAuth = [];
  const fetchImpl = async (_url, init) => {
    seenAuth.push(init.headers.authorization);
    const key = init.headers.range;
    return { ok: true, json: async () => pages[key] || [] };
  };
  const rows = await fetchAllEvents({ url: "https://db", serviceRoleKey: "svc", fetchImpl, pageSize: 2 });
  assert.deepEqual(rows.map((r) => r.id), ["1", "2", "3"]);
  assert.ok(seenAuth.every((a) => a === "Bearer svc"));
});

test("fetchAllEvents treats a 416 (row count an exact multiple of pageSize) as end-of-data", async () => {
  // pageSize 2, exactly 2 rows: first page is full ⇒ a second request is made,
  // whose offset is past the end ⇒ PostgREST returns 416. Must stop, not throw.
  const pages = { "0-1": [{ id: "1", created_at: "a" }, { id: "2", created_at: "b" }] };
  const fetchImpl = async (_url, init) => {
    const page = pages[init.headers.range];
    return page ? { ok: true, json: async () => page } : { ok: false, status: 416 };
  };
  const rows = await fetchAllEvents({ url: "https://db", serviceRoleKey: "svc", fetchImpl, pageSize: 2 });
  assert.deepEqual(rows.map((r) => r.id), ["1", "2"]);
});

test("fetchAllEvents throws on missing config and on a non-ok read", async () => {
  await assert.rejects(() => fetchAllEvents({}), /unconfigured/);
  await assert.rejects(
    () => fetchAllEvents({ url: "https://db", serviceRoleKey: "svc", fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /HTTP 500/,
  );
});

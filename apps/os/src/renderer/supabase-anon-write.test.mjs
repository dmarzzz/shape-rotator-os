import test from "node:test";
import assert from "node:assert/strict";
import { clampField, postAnonRow, getAnonRows } from "./supabase-anon-write.mjs";

const CONFIG = { url: "https://db.example", anonKey: "anon123" };

test("clampField trims, bounds, and nulls empties", () => {
  assert.equal(clampField("  hi  "), "hi");
  assert.equal(clampField(""), null);
  assert.equal(clampField("   "), null);
  assert.equal(clampField(null), null);
  assert.equal(clampField("abcdef", 3), "abc");
  assert.equal(clampField(42), "42");
});

test("postAnonRow returns unconfigured when url/anonKey/table missing", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true }; };
  assert.deepEqual(await postAnonRow("t", {}, { config: {}, fetchImpl }), { ok: false, error: "unconfigured" });
  assert.deepEqual(await postAnonRow("", {}, { config: CONFIG, fetchImpl }), { ok: false, error: "unconfigured" });
  assert.equal(called, false);
});

test("postAnonRow POSTs with the anon write headers + Prefer minimal", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true }; };
  const res = await postAnonRow("cohort_events", { a: 1 }, { config: CONFIG, fetchImpl });
  assert.deepEqual(res, { ok: true });
  assert.equal(seen.url, "https://db.example/rest/v1/cohort_events");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.apikey, "anon123");
  assert.equal(seen.init.headers.authorization, "Bearer anon123");
  assert.equal(seen.init.headers.prefer, "return=minimal");
  assert.deepEqual(JSON.parse(seen.init.body), { a: 1 });
});

test("postAnonRow reports a non-ok HTTP status and never throws on network error", async () => {
  assert.deepEqual(
    await postAnonRow("t", {}, { config: CONFIG, fetchImpl: async () => ({ ok: false, status: 403 }) }),
    { ok: false, error: "HTTP 403" },
  );
  const thrown = await postAnonRow("t", {}, { config: CONFIG, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /offline/);
});

test("getAnonRows returns rows on a clean read, and source none on outage/bad shape", async () => {
  const ok = await getAnonRows("app_cohort_feed?select=*", {
    config: CONFIG, fetchImpl: async () => ({ ok: true, json: async () => [{ id: "1" }] }),
  });
  assert.deepEqual(ok, { rows: [{ id: "1" }], source: "supabase" });

  assert.deepEqual(
    await getAnonRows("v", { config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500 }) }),
    { rows: [], source: "none" },
  );
  assert.deepEqual(
    await getAnonRows("v", { config: CONFIG, fetchImpl: async () => { throw new Error("x"); } }),
    { rows: [], source: "none" },
  );
  // Non-array JSON ⇒ empty rows, still "supabase" (the read itself succeeded).
  assert.deepEqual(
    await getAnonRows("v", { config: CONFIG, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    { rows: [], source: "supabase" },
  );
  // Unconfigured ⇒ none, no fetch.
  assert.deepEqual(await getAnonRows("v", { config: {} }), { rows: [], source: "none" });
});

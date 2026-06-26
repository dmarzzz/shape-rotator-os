import test from "node:test";
import assert from "node:assert/strict";

import { saveSelfReportUpdate, fetchApprovedProfileUpdates } from "./supabase-self-report.mjs";

const CONFIG = { url: "https://example.supabase.co", anonKey: "anon-123" };

function captureFetch(response = { ok: true, status: 201 }) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return response; };
  fn.calls = calls;
  return fn;
}

test("rejects a bad record_id without calling fetch", async () => {
  const fetchImpl = captureFetch();
  const r = await saveSelfReportUpdate("", { now: "x" }, {}, { config: CONFIG, fetchImpl });
  assert.deepEqual(r, { ok: false, error: "bad_record_id" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("rejects an empty/whitelist-stripped delta without calling fetch", async () => {
  const fetchImpl = captureFetch();
  // Only disallowed keys → sanitize strips to {} → empty_delta.
  const r = await saveSelfReportUpdate("dmarz", { team: "x", record_id: "y" }, {}, { config: CONFIG, fetchImpl });
  assert.deepEqual(r, { ok: false, error: "empty_delta" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("returns unconfigured when url/anonKey missing", async () => {
  const r = await saveSelfReportUpdate("dmarz", { now: "x" }, {}, { config: { url: "", anonKey: "" }, fetchImpl: captureFetch() });
  assert.deepEqual(r, { ok: false, error: "unconfigured" });
});

test("posts a whitelisted, pending delta with anon headers", async () => {
  const fetchImpl = captureFetch();
  const r = await saveSelfReportUpdate(
    "  dmarz  ",
    { now: "building the receive loop", skills: ["supabase"], team: "HIJACK", status: "approved" },
    { question: "emphasize what?", sourceKinds: ["sessions", "github"] },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://example.supabase.co/rest/v1/os_profile_updates");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, "anon-123");
  assert.equal(init.headers.prefer, "return=minimal");
  const body = JSON.parse(init.body);
  assert.equal(body.record_id, "dmarz");                 // trimmed
  assert.deepEqual(body.delta, { now: "building the receive loop", skills: ["supabase"] }); // team/status stripped
  assert.ok(!("status" in body));                        // can't preset status — DB defaults pending
  assert.equal(body.question, "emphasize what?");
  assert.deepEqual(body.source_kinds, ["sessions", "github"]);
});

test("a non-ok HTTP response is reported as a failure", async () => {
  const r = await saveSelfReportUpdate("dmarz", { now: "x" }, {}, { config: CONFIG, fetchImpl: captureFetch({ ok: false, status: 403 }) });
  assert.deepEqual(r, { ok: false, error: "HTTP 403" });
});

test("fetchApprovedProfileUpdates maps newest-per-record and only the GET view", async () => {
  const rows = [
    { record_id: "dmarz", delta: { now: "older" }, created_at: "2026-06-24T00:00:00Z" },
    { record_id: "dmarz", delta: { now: "newer" }, created_at: "2026-06-25T00:00:00Z" }, // asc ⇒ wins
    { record_id: "albiona", delta: { skills: ["x"] }, created_at: "2026-06-25T00:00:00Z" },
    { record_id: "", delta: { now: "junk" }, created_at: "2026-06-25T00:00:00Z" },         // dropped
  ];
  let seenUrl = "";
  const fetchImpl = async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => rows }; };
  const { updates, source } = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl });
  assert.equal(source, "supabase");
  assert.ok(seenUrl.includes("/rest/v1/app_profile_updates")); // reads the APPROVED view, not the raw inbox
  assert.deepEqual(updates.dmarz, { now: "newer" });
  assert.deepEqual(updates.albiona, { skills: ["x"] });
  assert.ok(!("" in updates));
});

test("fetchApprovedProfileUpdates bounds the read and stays newest-per-record regardless of order", async () => {
  // Rows delivered NEWEST-FIRST (the production order=created_at.desc) — the
  // dedup must still pick the newest delta per record, not the first row seen.
  const rows = [
    { record_id: "dmarz", delta: { now: "newest" }, created_at: "2026-06-26T00:00:00Z" },
    { record_id: "dmarz", delta: { now: "stale" }, created_at: "2026-06-20T00:00:00Z" },
  ];
  let seenUrl = "";
  const fetchImpl = async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => rows }; };
  const { updates } = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl });
  assert.ok(seenUrl.includes("limit="), "approved read must be bounded by a limit");
  assert.ok(seenUrl.includes("order=created_at.desc"), "approved read should request newest-first");
  assert.deepEqual(updates.dmarz, { now: "newest" });
});

test("fetchApprovedProfileUpdates is resilient: outage ⇒ source none, no throw", async () => {
  const r1 = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual(r1, { updates: {}, source: "none" });
  const r2 = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(r2, { updates: {}, source: "none" });
});

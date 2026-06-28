import test from "node:test";
import assert from "node:assert/strict";

import { saveSelfReportUpdate, saveProfileProposal, fetchApprovedProfileUpdates } from "./supabase-self-report.mjs";

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

test("saveProfileProposal (person) posts ONLY the granted columns — no record_type", async () => {
  const fetchImpl = captureFetch();
  const r = await saveProfileProposal(
    "albiona",
    { now: "shipping", skills: ["zk"], team: "x" },
    { proposerRecordId: "dmarz", proposerClaimHash: "h", rationale: "saw it in their work" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(r, { ok: true });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  // The os_profile_updates anon INSERT grant is column-scoped; a person proposal must
  // NOT carry record_type (the column isn't granted yet) or PostgREST 400s the row.
  assert.ok(!("record_type" in body), "person body must not include record_type");
  assert.equal(body.record_id, "albiona");
  assert.deepEqual(body.delta, { now: "shipping", skills: ["zk"] }); // team stripped
  assert.equal(body.proposer_record_id, "dmarz");
});

test("saveProfileProposal (team) carries record_type:team + the team whitelist", async () => {
  const fetchImpl = captureFetch();
  const r = await saveProfileProposal(
    "teesql",
    { journey: { stage: 5, primary_bottleneck: "GTM" }, traction: "2 pilots", now: "drop me" },
    { proposerRecordId: "dmarz", subjectType: "team" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(r, { ok: true });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.record_type, "team");
  assert.equal(body.delta.journey.stage, 5);
  assert.equal(body.delta.traction, "2 pilots");
  assert.ok(!("now" in body.delta), "personal field stripped on a team proposal");
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
    { record_type: "team", record_id: "teesql", delta: { traction: "2 pilots" }, created_at: "2026-06-25T00:00:00Z" },
    { record_id: "", delta: { now: "junk" }, created_at: "2026-06-25T00:00:00Z" },         // dropped
  ];
  let seenUrl = "";
  const fetchImpl = async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => rows }; };
  const { updates, teamUpdates, source } = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl });
  assert.equal(source, "supabase");
  assert.ok(seenUrl.includes("/rest/v1/app_profile_updates")); // reads the APPROVED view, not the raw inbox
  assert.ok(seenUrl.includes("record_type"), "new-schema read requests record_type for team overlays");
  assert.deepEqual(updates.dmarz, { now: "newer" });
  assert.deepEqual(updates.albiona, { skills: ["x"] });
  assert.deepEqual(teamUpdates.teesql, { traction: "2 pilots" });
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
  assert.deepEqual(r1, { updates: {}, teamUpdates: {}, source: "none" });
  const r2 = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(r2, { updates: {}, teamUpdates: {}, source: "none" });
});

test("fetchApprovedProfileUpdates falls back to the deployed person-only view while record_type is absent", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 400, text: async () => "record_type missing" };
    return {
      ok: true,
      status: 200,
      json: async () => [{ record_id: "mikeishiring", delta: { now: "fresh" }, created_at: "2026-06-28T00:00:00Z" }],
    };
  };
  const { updates, teamUpdates, source } = await fetchApprovedProfileUpdates({ config: CONFIG, fetchImpl });
  assert.equal(source, "supabase");
  assert.ok(urls[0].includes("record_type"), "first tries the new team-aware view");
  assert.ok(!urls[1].includes("record_type"), "fallback keeps current live DB working");
  assert.deepEqual(updates.mikeishiring, { now: "fresh" });
  assert.deepEqual(teamUpdates, {});
});

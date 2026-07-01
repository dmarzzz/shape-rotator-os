import test from "node:test";
import assert from "node:assert/strict";

import {
  cohortTranscriptRoutingUrl,
  fetchCohortTranscriptRouting,
  normalizeRoutingRow,
  relevantTranscriptsFor,
} from "../apps/os/src/renderer/supabase-transcript-routing.mjs";

const DEFAULT_URL = "https://txjntzwksiluvqcpccpc.supabase.co";

function okResponse(rows) {
  return { ok: true, status: 200, json: async () => rows };
}

test("cohortTranscriptRoutingUrl targets the gated view with the exact column set", () => {
  const url = cohortTranscriptRoutingUrl(DEFAULT_URL);
  assert.match(url, /\/rest\/v1\/cohort_app_transcript_routing\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("order"), "score.desc");
  const cols = (parsed.searchParams.get("select") || "").split(",");
  assert.deepEqual(cols, [
    "record_id", "session_title", "session_type", "score", "basis", "reason", "generated_at",
  ]);
  // Must NOT request org/provenance/review columns — the gated view drops them.
  for (const gated of ["org_id", "id", "content_json", "review_status", "created_at"]) {
    assert.ok(!cols.includes(gated), `select must not include gated column ${gated}`);
  }
});

test("fetchCohortTranscriptRouting no-ops (unconfigured) without a cohort key", async () => {
  let called = false;
  const res = await fetchCohortTranscriptRouting({
    config: { url: DEFAULT_URL, anonKey: "anon", cohortKey: "" },
    fetchImpl: async () => { called = true; return okResponse([]); },
  });
  assert.equal(res.source, "unconfigured");
  assert.deepEqual(res.rows, []);
  assert.equal(called, false, "must not hit the network without a cohort key (public web / un-provisioned)");
});

test("fetchCohortTranscriptRouting reads the gated view: apikey is anon, the cohort_app JWT rides in Bearer", async () => {
  let headers = null;
  const res = await fetchCohortTranscriptRouting({
    config: { url: DEFAULT_URL, anonKey: "ANON", cohortKey: "COHORT_JWT" },
    fetchImpl: async (_url, opts) => { headers = opts.headers; return okResponse([{ record_id: "dmarz", session_title: "T", score: 0.9 }]); },
  });
  assert.equal(res.source, "supabase-cohort");
  assert.equal(res.rows.length, 1);
  // Kong validates apikey BEFORE PostgREST, so apikey MUST be the anon key; the
  // role=cohort_app JWT is only valid in Authorization.
  assert.equal(headers.apikey, "ANON");
  assert.equal(headers.authorization, "Bearer COHORT_JWT");
});

test("fetchCohortTranscriptRouting degrades to source:error on a non-ok response", async () => {
  const res = await fetchCohortTranscriptRouting({
    config: { url: DEFAULT_URL, anonKey: "anon", cohortKey: "k" },
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(res.source, "error");
  assert.deepEqual(res.rows, []);
});

test("normalizeRoutingRow shapes a routing row and rejects rows missing key fields", () => {
  const out = normalizeRoutingRow({
    record_id: "mikeishiring",
    session_title: "Salon: companies as end-to-end software",
    session_type: "salon",
    score: 0.916,
    basis: "own_team_discussed",
    reason: "Your team shape-rotator-os was discussed.",
    generated_at: "2026-06-30T00:00:00Z",
  });
  assert.equal(out.record_id, "mikeishiring");
  assert.equal(out.session_title, "Salon: companies as end-to-end software");
  assert.equal(out.score, 0.916);
  assert.equal(out.basis, "own_team_discussed");
  assert.equal(out.source, "supabase-cohort");
  // missing record_id or session_title -> null
  assert.equal(normalizeRoutingRow({ session_title: "x" }), null);
  assert.equal(normalizeRoutingRow({ record_id: "x" }), null);
  assert.equal(normalizeRoutingRow(null), null);
});

test("relevantTranscriptsFor filters to the viewer's record_id and sorts by score", () => {
  const rows = [
    { record_id: "dmarz", session_title: "A", score: 0.5 },
    { record_id: "mikeishiring", session_title: "B", score: 0.4 },
    { record_id: "mikeishiring", session_title: "C", score: 0.9 },
    { record_id: "dmarz", session_title: "D", score: 0.8 },
  ];
  const mine = relevantTranscriptsFor(rows, "mikeishiring");
  assert.deepEqual(mine.map((r) => r.session_title), ["C", "B"]);
  assert.deepEqual(relevantTranscriptsFor(rows, ""), []);
  assert.deepEqual(relevantTranscriptsFor(null, "dmarz"), []);
});

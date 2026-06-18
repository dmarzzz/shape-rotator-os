import test from "node:test";
import assert from "node:assert/strict";

import {
  cohortDistillationsUrl,
  fetchCohortDistillations,
  normalizeDistillation,
} from "../apps/os/src/renderer/supabase-distillations.mjs";

const DEFAULT_URL = "https://txjntzwksiluvqcpccpc.supabase.co";

function okResponse(rows) {
  return { ok: true, status: 200, json: async () => rows };
}

test("cohortDistillationsUrl targets the gated view with the exact column set", () => {
  const url = cohortDistillationsUrl(DEFAULT_URL);
  assert.match(url, /\/rest\/v1\/cohort_app_transcript_distillations\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("order"), "created_at.desc");
  const cols = (parsed.searchParams.get("select") || "").split(",");
  assert.deepEqual(cols, [
    "id", "artifact_kind", "surface_tier", "confidence", "content_json", "content_md", "created_at",
  ]);
  // Must NOT request org/session/provenance columns — the gated view drops them.
  for (const gated of ["org_id", "session_id", "source_artifact_id", "approval_state", "review_status"]) {
    assert.ok(!cols.includes(gated), `select must not include gated column ${gated}`);
  }
});

test("fetchCohortDistillations no-ops (unconfigured) without a cohort key", async () => {
  let called = false;
  const res = await fetchCohortDistillations({
    config: { url: DEFAULT_URL, anonKey: "anon", cohortKey: "" },
    fetchImpl: async () => { called = true; return okResponse([]); },
  });
  assert.equal(res.source, "unconfigured");
  assert.deepEqual(res.artifacts, []);
  assert.equal(called, false, "must not hit the network without a cohort key (public web / un-provisioned)");
});

test("fetchCohortDistillations reads the gated view: apikey is anon, the cohort_app JWT rides in Bearer", async () => {
  let headers = null;
  const res = await fetchCohortDistillations({
    config: { url: DEFAULT_URL, anonKey: "ANON", cohortKey: "COHORT_JWT" },
    fetchImpl: async (_url, opts) => { headers = opts.headers; return okResponse([]); },
  });
  assert.equal(res.source, "supabase-cohort");
  // The #438 gateway discipline: Kong validates apikey BEFORE PostgREST, so apikey
  // MUST be the anon key; the role=cohort_app JWT is only valid in Authorization.
  assert.equal(headers.apikey, "ANON");
  assert.equal(headers.authorization, "Bearer COHORT_JWT");
});

test("fetchCohortDistillations degrades to source:error on a non-ok response", async () => {
  const res = await fetchCohortDistillations({
    config: { url: DEFAULT_URL, anonKey: "anon", cohortKey: "k" },
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(res.source, "error");
  assert.deepEqual(res.artifacts, []);
});

test("normalizeDistillation shapes a derived_artifacts row defensively", () => {
  const out = normalizeDistillation({
    id: "art-1",
    artifact_kind: "readout",
    surface_tier: "T2",
    confidence: 0.8,
    content_md: "# Week 3\n\nThe gist of the session.",
    content_json: { title: "Week 3 Readout", date: "2026-06-10", themes: ["pmf", "clustering"], teams: ["teesql"] },
    created_at: "2026-06-10T00:00:00Z",
  });
  assert.equal(out.id, "art-1");
  assert.equal(out.kind, "readout");
  assert.equal(out.surface_tier, "T2");
  assert.equal(out.title, "Week 3 Readout");
  assert.equal(out.date, "2026-06-10");
  assert.deepEqual(out.themes, ["pmf", "clustering"]);
  assert.deepEqual(out.teams, ["teesql"]);
  assert.match(out.body_md, /The gist/);
  assert.equal(out.source, "supabase-cohort");
});

test("normalizeDistillation falls back to created_at for the date and leaves a sparse title empty", () => {
  // The reader returns the raw shaped row; the render layer (distilledTranscriptTitle)
  // supplies the "Distilled <kind>" display fallback, so an absent title stays "".
  const out = normalizeDistillation({ id: "art-2", artifact_kind: "qa", content_md: "body", content_json: {}, created_at: "2026-06-11T00:00:00Z" });
  assert.equal(out.title, "");
  assert.equal(out.kind, "qa");
  assert.equal(out.date, "2026-06-11T00:00:00Z");
  assert.deepEqual(out.themes, []);
});

test("normalizeDistillation reads the engine's nested distillation shape + body-heading title", () => {
  // Real shape: title lives in the content_md heading (content_json carries policy
  // metadata), themes/summary are nested under content_json.distillation, summary
  // is an array of bullets.
  const out = normalizeDistillation({
    id: "art-3", artifact_kind: "readout", surface_tier: "T2",
    content_md: "# WDYDLW with Shaw @ the auditorium\n\nType: office_hours\n\n## Summary\n- the gist of it",
    content_json: { session_type: "office_hours", distillation: { themes: ["a", "b", "c"], summary: ["first bullet", "second bullet"] } },
    created_at: "2026-06-13T00:00:00Z",
  });
  assert.equal(out.title, "WDYDLW with Shaw @ the auditorium");
  assert.equal(out.session_type, "office_hours");
  assert.deepEqual(out.themes, ["a", "b", "c"]);
  assert.equal(out.summary, "first bullet");
});

test("normalizeDistillation rejects rows without an id", () => {
  assert.equal(normalizeDistillation({ content_md: "x" }), null);
  assert.equal(normalizeDistillation(null), null);
});

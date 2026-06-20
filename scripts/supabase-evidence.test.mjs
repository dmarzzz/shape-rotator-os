import test from "node:test";
import assert from "node:assert/strict";

import {
  readSupabaseConfig,
  persistCohortKeyOverride,
  publicEvidenceCardsUrl,
  fetchPublicEvidenceCards,
  cohortEvidenceCardsUrl,
  fetchCohortEvidenceCards,
} from "../apps/os/src/renderer/supabase-evidence.mjs";

const DEFAULT_URL = "https://txjntzwksiluvqcpccpc.supabase.co";
const CONFIG_KEY = "srfg:calendar_ingress_config";

function fakeStorage(obj = {}) {
  return { getItem: (k) => (k in obj ? obj[k] : null) };
}

// A read/write localStorage mock for the persist path.
function rwStorage(obj = {}) {
  const store = { ...obj };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    _dump: () => store,
  };
}

function okResponse(rows) {
  return { ok: true, status: 200, json: async () => rows };
}

test("readSupabaseConfig falls back to the published URL and the baked anon key", () => {
  const cfg = readSupabaseConfig(fakeStorage());
  assert.equal(cfg.url, DEFAULT_URL);
  assert.match(cfg.anonKey, /^eyJ/, "baked anon JWT is the default so the read works out-of-the-box");
});

test("readSupabaseConfig reads the calendar-ingress config and strips trailing slashes", () => {
  const cfg = readSupabaseConfig(fakeStorage({
    [CONFIG_KEY]: JSON.stringify({ supabaseUrl: "https://x.supabase.co/", supabaseAnonKey: "anon-123" }),
  }));
  assert.equal(cfg.url, "https://x.supabase.co");
  assert.equal(cfg.anonKey, "anon-123");
});

test("readSupabaseConfig survives malformed config JSON", () => {
  const cfg = readSupabaseConfig(fakeStorage({ [CONFIG_KEY]: "{not json" }));
  assert.equal(cfg.url, DEFAULT_URL);
  assert.match(cfg.anonKey, /^eyJ/, "malformed config falls back to the baked anon key");
});

test("publicEvidenceCardsUrl targets the anon view with the exact column set", () => {
  const url = publicEvidenceCardsUrl(DEFAULT_URL);
  assert.match(url, /\/rest\/v1\/public_transcript_evidence_cards\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("order"), "created_at.desc");
  const cols = (parsed.searchParams.get("select") || "").split(",");
  assert.deepEqual(cols, [
    "id", "claim_type", "title", "claim_text", "summary",
    "evidence_level", "confidence", "attribution_scope", "content_json", "created_at",
  ]);
  // Must NOT request gated/private columns.
  for (const gated of ["org_id", "session_id", "source_artifact_id", "reviewed_by"]) {
    assert.ok(!cols.includes(gated), `select must not include gated column ${gated}`);
  }
});

test("fetchPublicEvidenceCards no-ops (unconfigured) when the key is explicitly blank", async () => {
  let called = false;
  const out = await fetchPublicEvidenceCards({
    config: { url: DEFAULT_URL, anonKey: "" },
    fetchImpl: () => { called = true; },
  });
  assert.equal(out.source, "unconfigured");
  assert.deepEqual(out.cards, []);
  assert.equal(called, false, "must not hit the network without a key");
});

test("fetchPublicEvidenceCards uses the baked key when storage is empty (works out-of-the-box)", async () => {
  let called = false;
  await fetchPublicEvidenceCards({ storage: fakeStorage(), fetchImpl: () => { called = true; return okResponse([]); } });
  assert.equal(called, true, "with the baked anon key, an empty config still reads live");
});

test("fetchPublicEvidenceCards fetches + normalizes cards and sends the anon key", async () => {
  let seenUrl = null; let seenHeaders = null;
  const storage = fakeStorage({ [CONFIG_KEY]: JSON.stringify({ supabaseUrl: DEFAULT_URL, supabaseAnonKey: "anon-xyz" }) });
  const fetchImpl = (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return okResponse([
    { id: "c1", claim_type: "insight", title: "T", claim_text: "X", summary: "S", evidence_level: "inferred", confidence: 0.8, attribution_scope: "team", content_json: { topic_label: "z" }, created_at: "2026-06-10" },
    { id: "", title: "dropped (no id)" },
    "garbage",
  ]); };
  const out = await fetchPublicEvidenceCards({ storage, fetchImpl });
  assert.equal(out.source, "supabase");
  assert.equal(out.cards.length, 1, "rows without an id (and non-objects) are dropped");
  assert.equal(out.cards[0].id, "c1");
  assert.equal(out.cards[0].surface_tier, "T3");
  assert.equal(out.cards[0].source, "supabase-live");
  assert.equal(out.cards[0].confidence, 0.8);
  assert.match(seenUrl, /public_transcript_evidence_cards/);
  assert.equal(seenHeaders.apikey, "anon-xyz");
  assert.equal(seenHeaders.authorization, "Bearer anon-xyz");
});

test("fetchPublicEvidenceCards degrades to [] on HTTP error, bad JSON, and network throw", async () => {
  const storage = fakeStorage({ [CONFIG_KEY]: JSON.stringify({ supabaseAnonKey: "k" }) });
  const httpErr = await fetchPublicEvidenceCards({ storage, fetchImpl: () => ({ ok: false, status: 503 }) });
  assert.equal(httpErr.source, "error"); assert.deepEqual(httpErr.cards, []); assert.match(httpErr.error, /503/);

  const badJson = await fetchPublicEvidenceCards({ storage, fetchImpl: () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }) });
  assert.equal(badJson.source, "error"); assert.deepEqual(badJson.cards, []);

  const threw = await fetchPublicEvidenceCards({ storage, fetchImpl: () => { throw new Error("offline"); } });
  assert.equal(threw.source, "error"); assert.match(threw.error, /offline/);
});

// ── Gated cohort (T2) reader ────────────────────────────────────────────────

test("the cohort key is NOT baked into the public source (empty by default)", () => {
  const cfg = readSupabaseConfig(fakeStorage());
  assert.equal(cfg.cohortKey, "", "cohort key must not ship in the public repo — supplied per build/config only");
});

test("readSupabaseConfig reads supabaseCohortKey from the calendar-ingress config", () => {
  const cfg = readSupabaseConfig(fakeStorage({ [CONFIG_KEY]: JSON.stringify({ supabaseCohortKey: "cohort-jwt" }) }));
  assert.equal(cfg.cohortKey, "cohort-jwt");
});

test("persistCohortKeyOverride writes a key readSupabaseConfig() then reads back (round-trip)", () => {
  const storage = rwStorage();
  assert.equal(persistCohortKeyOverride("  cohort-jwt  ", storage), true);
  // Stored trimmed, under the canonical config key.
  assert.equal(JSON.parse(storage._dump()[CONFIG_KEY]).supabaseCohortKey, "cohort-jwt");
  assert.equal(readSupabaseConfig(storage).cohortKey, "cohort-jwt");
});

test("persistCohortKeyOverride merges into existing config (keeps url/anon settings)", () => {
  const storage = rwStorage({ [CONFIG_KEY]: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon-1" }) });
  persistCohortKeyOverride("cohort-jwt", storage);
  const cfg = JSON.parse(storage._dump()[CONFIG_KEY]);
  assert.equal(cfg.supabaseUrl, "https://x.supabase.co", "existing settings survive the merge");
  assert.equal(cfg.supabaseAnonKey, "anon-1");
  assert.equal(cfg.supabaseCohortKey, "cohort-jwt");
});

test("persistCohortKeyOverride with an empty value clears the override (back to anon)", () => {
  const storage = rwStorage({ [CONFIG_KEY]: JSON.stringify({ supabaseCohortKey: "old", supabaseAnonKey: "anon-1" }) });
  persistCohortKeyOverride("   ", storage);
  const cfg = JSON.parse(storage._dump()[CONFIG_KEY]);
  assert.ok(!("supabaseCohortKey" in cfg), "blank input deletes the key rather than storing empty");
  assert.equal(cfg.supabaseAnonKey, "anon-1", "clearing the cohort key leaves other settings intact");
  assert.equal(readSupabaseConfig(storage).cohortKey, "", "reader falls back to the (empty) baked default");
});

test("persistCohortKeyOverride survives malformed stored JSON and a read-only storage", () => {
  const malformed = rwStorage({ [CONFIG_KEY]: "{not json" });
  assert.equal(persistCohortKeyOverride("cohort-jwt", malformed), true);
  assert.equal(JSON.parse(malformed._dump()[CONFIG_KEY]).supabaseCohortKey, "cohort-jwt", "malformed config is replaced, not appended to");
  // No setItem (read-only) => returns false, never throws.
  assert.equal(persistCohortKeyOverride("k", fakeStorage()), false);
});

test("cohortEvidenceCardsUrl targets the role-gated cohort view incl. surface_tier", () => {
  const url = cohortEvidenceCardsUrl(DEFAULT_URL);
  assert.match(url, /\/rest\/v1\/cohort_app_transcript_evidence_cards\?/);
  const cols = (new URL(url).searchParams.get("select") || "").split(",");
  assert.ok(cols.includes("surface_tier"), "cohort view exposes surface_tier");
  assert.ok(cols.includes("content_json"), "cohort view exposes content_json (date/week_start/teams)");
  for (const gated of ["org_id", "session_id", "source_artifact_id", "reviewed_by"]) {
    assert.ok(!cols.includes(gated), `cohort select must not include provenance column ${gated}`);
  }
});

test("fetchCohortEvidenceCards no-ops (unconfigured) without a cohort key — public-web safe", async () => {
  let called = false;
  const out = await fetchCohortEvidenceCards({ config: { url: DEFAULT_URL, cohortKey: "" }, fetchImpl: () => { called = true; } });
  assert.equal(out.source, "unconfigured");
  assert.deepEqual(out.cards, []);
  assert.equal(called, false, "no cohort key => never hits the gated view (public web stays T3-only)");
});

test("fetchCohortEvidenceCards reads the gated view with the cohort key + marks T2", async () => {
  let seenUrl = null; let seenHeaders = null;
  const fetchImpl = (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return okResponse([
    { id: "g1", claim_type: "decision", title: "T", claim_text: "X", summary: "S", evidence_level: "observed", confidence: 0.76, attribution_scope: "team", surface_tier: "T2", content_json: { week_start: "2026-06-08", teams: ["bitrouter"] }, created_at: "2026-06-08" },
  ]); };
  const out = await fetchCohortEvidenceCards({ config: { url: DEFAULT_URL, anonKey: "anon-xyz", cohortKey: "cohort-jwt" }, fetchImpl });
  assert.equal(out.source, "supabase-cohort");
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].surface_tier, "T2");
  assert.equal(out.cards[0].source, "supabase-cohort");
  assert.match(seenUrl, /cohort_app_transcript_evidence_cards/);
  // apikey is the ANON key (gateway-recognized); the cohort_app role rides in Bearer.
  // Sending the cohort JWT as apikey is rejected by Kong with 401 "Invalid API key".
  assert.equal(seenHeaders.apikey, "anon-xyz");
  assert.equal(seenHeaders.authorization, "Bearer cohort-jwt");
});

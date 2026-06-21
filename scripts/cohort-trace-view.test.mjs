import test from "node:test";
import assert from "node:assert/strict";
import { traceViewHtml, traceBodyHtml, cardTraceHtml, cardTraceBodyHtml } from "../apps/os/src/renderer/cohort-trace-view.mjs";

test("traceViewHtml returns empty for a missing/invalid trace", () => {
  assert.equal(traceViewHtml(null), "");
  assert.equal(traceViewHtml({}), "");
  assert.equal(traceViewHtml({ basis: "inferred" }), ""); // no method -> not a trace
});

test("traceViewHtml renders basis, confidence, signals, contributions, refs, recompute", () => {
  const trace = {
    method: "latent_overlap_idf", version: 2, basis: "inferred",
    confidence: "low-medium", confidence_basis: "inferred structural similarity 62/100",
    signals: [
      { name: "shared_skill_areas", value: ["attestation", "tee"], contribution: 44, of: 100,
        source_refs: [{ kind: "team_record", record_id: "alpha", path: "cohort-data/teams/alpha.md" }] },
      { name: "shared_terms_idf", value: [{ term: "holography", idf_weight: 1 }], contribution: 6, of: 100 },
    ],
    recompute: "buildLatentOverlapCards over committed teams",
  };
  const html = traceViewHtml(trace);
  assert.match(html, /trace-basis-inferred/);
  assert.match(html, /low–medium confidence/);            // en-dashed for display
  assert.match(html, /inferred structural similarity 62\/100/);
  assert.match(html, /shared skill areas/);               // underscores humanised
  assert.match(html, /44<span class="trace-sig-of">\/100/); // contribution out of total
  assert.match(html, /team record: alpha/);               // a resolvable source ref
  assert.match(html, /holography \(1\)/);                  // term with its idf weight
  assert.match(html, /latent_overlap_idf@2/);              // method + version stamp
  assert.match(html, /recompute/);
});

test("observed_with_inferred_identity is toned as inferred (never read as an observed fact)", () => {
  const html = traceViewHtml({ method: "collaboration_edge_github", version: 1, basis: "observed_with_inferred_identity", confidence: "low" });
  assert.match(html, /trace-basis-inferred/);
  assert.match(html, /observed · inferred identity/);
});

test("cardTraceHtml reads content_json.trace and is empty when absent", () => {
  const card = { content_json: { trace: { method: "say_did_shipped", version: 1, basis: "declared", confidence: "low" } } };
  assert.match(cardTraceHtml(card), /declared/);
  assert.equal(cardTraceHtml({ content_json: {} }), "");
});

test("traceBodyHtml is a bare embeddable form (no disclosure) with the same parts", () => {
  const trace = { method: "say_did_shipped", version: 1, basis: "observed", confidence: "medium",
    confidence_basis: "did from github progress", signals: [{ name: "did", value: "shipped v1" }], recompute: "buildSayDidShippedCards" };
  const body = traceBodyHtml(trace);
  assert.doesNotMatch(body, /<details/);     // bare: no disclosure wrapper
  assert.match(body, /trace-bare/);
  assert.match(body, /trace-basis-observed/);
  assert.match(body, /did from github progress/);
  assert.equal(traceBodyHtml(null), "");
  assert.equal(cardTraceBodyHtml({ content_json: { trace } }).includes("trace-bare"), true);
});

test("escapes hostile content", () => {
  const html = traceViewHtml({ method: "x", version: 1, basis: "declared", confidence_basis: "<script>alert(1)</script>" });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

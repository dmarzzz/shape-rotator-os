import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, recordSignals, scoreEdge, buildContext, deterministicEdges, mergeEdges, parseLlmEdges,
} from "./lib/cohort-connections-engine.mjs";
import { connectionsByRecord, sanitizeEdges, normalizeConnectionsPayload } from "../apps/os/src/renderer/supabase-connections.mjs";

// ── fixtures ──────────────────────────────────────────────────────────────
const abra = {
  record_id: "abra", record_type: "team", name: "Abra",
  focus: "formal verification · dstack TEE Postgres", domain: "tee",
  seeking: ["TEE Postgres beta access for the verification registry", "Rust pair on Kani proof certificates"],
  offering: ["formal-verification office hours", "bounded model checking primer"],
  skill_areas: ["formal-verification", "tee", "dstack", "attestation"],
};
const teesql = {
  record_id: "teesql", record_type: "team", name: "TeeSQL",
  focus: "TEE Postgres on dstack",
  offering: ["free TeeSQL service to cohort teams during the accelerator", "TEE Postgres onboarding"],
  skill_areas: ["tee", "postgres", "dstack"],
};
const tinycloud = {
  record_id: "tinycloud", record_type: "team", name: "TinyCloud",
  offering: ["TEE Postgres hosting for cohort teams"],
  skill_areas: ["tee", "hosting", "infra"],
};
const elocute = {
  record_id: "elocute", record_type: "team", name: "Elocute",
  focus: "AI speech practice", offering: ["consumer GTM playbook"], skill_areas: ["generative-media", "design"],
};
const albiona = {
  record_id: "albiona-hoti", record_type: "person", name: "Albiona Hoti", team: "elocute",
  now: "compressing user conversations into one executable product plan",
  go_to_them_for: ["speech-practice tools", "tight feedback loops"],
  skill_areas: ["agentic", "generative-media", "design"],
};

const dependencies = [
  { record_id: "abra-teesql", source: "abra", target: "teesql", relation: "depends_on",
    reason: "Abra asks for TEE Postgres beta access; TeeSQL offers the matching service." },
];
const clusters = [{ record_id: "confidential", teams: ["abra", "teesql", "tinycloud"] }];

// ── tokenize ────────────────────────────────────────────────────────────────
test("tokenize drops stopwords + short noise but keeps domain tokens", () => {
  const t = tokenize("Building a TEE Postgres for the cohort with RL");
  assert.ok(t.has("postgres"));
  assert.ok(t.has("tee"), "3-char domain token kept");
  assert.ok(t.has("rl"), "2-char allowlisted token kept");
  assert.ok(!t.has("the"), "stopword dropped");
  assert.ok(!t.has("building"), "generic verb dropped");
  assert.ok(!t.has("cohort"), "domain-noise word dropped");
});

// ── recordSignals ─────────────────────────────────────────────────────────
test("recordSignals reads team seeking/offering and person go_to_them_for/now", () => {
  const a = recordSignals(abra);
  assert.equal(a.type, "team");
  assert.ok(a.seeks.has("postgres"));
  assert.ok(a.offers.has("verification"), "focus folds into offers vocabulary");
  const p = recordSignals(albiona);
  assert.equal(p.type, "person");
  assert.ok(p.offers.has("speech"), "go_to_them_for -> offers");
  assert.ok(p.seeks.has("conversations"), "now -> implied seeks");
});

// ── scoreEdge ─────────────────────────────────────────────────────────────
test("scoreEdge: a declared dependency dominates and uses its reason", () => {
  const ctx = buildContext({ dependencies, clusters });
  const e = scoreEdge(recordSignals(abra), recordSignals(teesql), ctx);
  assert.ok(e);
  assert.equal(e.kind, "dependency");
  assert.equal(e.basis, "declared");
  assert.ok(e.score >= 0.9);
  assert.match(e.reason, /beta access/);
});

test("scoreEdge: seeking↔offering match without a dep cites the actual phrases", () => {
  const ctx = buildContext({ dependencies, clusters }); // no abra->tinycloud dep
  const e = scoreEdge(recordSignals(abra), recordSignals(tinycloud), ctx);
  assert.ok(e, "abra seeks TEE Postgres; tinycloud offers TEE Postgres hosting");
  assert.equal(e.kind, "seeking-offering");
  assert.match(e.reason, /Abra is seeking/);
  assert.match(e.reason, /TinyCloud offers/);
});

test("scoreEdge: no shared need/skill/cluster -> null (no noise edges)", () => {
  const ctx = buildContext({ dependencies: [], clusters: [] });
  const e = scoreEdge(recordSignals(abra), recordSignals(elocute), ctx);
  assert.equal(e, null);
});

test("scoreEdge: self-loop is null", () => {
  const ctx = buildContext({});
  assert.equal(scoreEdge(recordSignals(abra), recordSignals(abra), ctx), null);
});

// ── deterministicEdges ────────────────────────────────────────────────────
test("deterministicEdges produces a graph, caps per source, includes the dependency edge", () => {
  const edges = deterministicEdges([abra, teesql, tinycloud, elocute, albiona], { dependencies, clusters, perRecord: 3 });
  assert.ok(edges.length > 0);
  const dep = edges.find((e) => e.from === "abra" && e.to === "teesql");
  assert.ok(dep && dep.kind === "dependency");
  // per-source cap respected
  const fromAbra = edges.filter((e) => e.from === "abra");
  assert.ok(fromAbra.length <= 3);
  // every edge references real ids and is directional
  for (const e of edges) {
    assert.notEqual(e.from, e.to);
    assert.ok(typeof e.score === "number" && e.score >= 0 && e.score <= 1);
  }
});

// ── mergeEdges ────────────────────────────────────────────────────────────
test("mergeEdges: LLM wins on collision, fills new, drops unknown ids, caps per source", () => {
  const validIds = new Set(["abra", "teesql", "tinycloud"]);
  const deterministic = [
    { from: "abra", to: "teesql", score: 0.9, kind: "dependency", reason: "dep", basis: "declared" },
    { from: "abra", to: "tinycloud", score: 0.4, kind: "seeking-offering", reason: "det", basis: "declared" },
  ];
  const llm = [
    { from: "abra", to: "teesql", score: 0.95, kind: "shared-problem", reason: "LLM richer reason" },
    { from: "abra", to: "ghost", score: 0.8, reason: "hallucinated id" },
    { from: "tinycloud", to: "abra", score: 0.6, reason: "new edge" },
  ];
  const merged = mergeEdges(llm, deterministic, { validIds, perRecord: 5 });
  const ab = merged.find((e) => e.from === "abra" && e.to === "teesql");
  assert.equal(ab.reason, "LLM richer reason", "LLM overrides on collision");
  assert.equal(ab.basis, "llm");
  assert.ok(!merged.some((e) => e.to === "ghost"), "unknown id dropped");
  assert.ok(merged.some((e) => e.from === "tinycloud" && e.to === "abra"), "new LLM edge kept");
  assert.ok(merged.some((e) => e.from === "abra" && e.to === "tinycloud"), "deterministic gap-fill kept");
});

// ── parseLlmEdges ─────────────────────────────────────────────────────────
test("parseLlmEdges extracts edges from fenced / wrapped / bare output, [] on junk", () => {
  const fenced = "blah\n```json\n{\"edges\":[{\"from\":\"a\",\"to\":\"b\",\"score\":0.5}]}\n```\nbye";
  assert.equal(parseLlmEdges(fenced).length, 1);
  const wrapped = 'Here you go: {"edges":[{"from":"x","to":"y"}]} done';
  assert.equal(parseLlmEdges(wrapped)[0].to, "y");
  const bareArray = '[{"from":"m","to":"n","score":0.3}]';
  assert.equal(parseLlmEdges(bareArray).length, 1);
  assert.deepEqual(parseLlmEdges("no json here"), []);
  assert.deepEqual(parseLlmEdges(""), []);
});

// ── reader: sanitize + normalize + adjacency ──────────────────────────────
test("sanitizeEdges clamps scores and drops malformed/self edges", () => {
  const out = sanitizeEdges([
    { from: "a", to: "b", score: 5 },
    { from: "a", to: "a", score: 1 },
    { from: "", to: "b" },
    { from: "c", to: "d", score: "x", reason: "ok" },
    "garbage",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].score, 1, "score clamped to 1");
  assert.equal(out[1].score, 0, "non-numeric score -> 0");
});

test("normalizeConnectionsPayload returns null when no usable edges", () => {
  assert.equal(normalizeConnectionsPayload({ payload: { edges: [] } }), null);
  assert.equal(normalizeConnectionsPayload({ payload: {} }), null);
  assert.equal(normalizeConnectionsPayload(null), null);
  const ok = normalizeConnectionsPayload({ payload: { edges: [{ from: "a", to: "b", score: 0.5 }], generated_at: "2026-06-24" } });
  assert.equal(ok.edges.length, 1);
  assert.equal(ok.generatedAt, "2026-06-24");
});

test("connectionsByRecord groups by source, resolves names, sorts by score, caps", () => {
  const edges = [
    { from: "abra", to: "teesql", score: 0.9, reason: "r1" },
    { from: "abra", to: "tinycloud", score: 0.5, reason: "r2" },
    { from: "teesql", to: "abra", score: 0.7, reason: "r3" },
  ];
  const names = new Map([["abra", "Abra"], ["teesql", "TeeSQL"], ["tinycloud", "TinyCloud"]]);
  const by = connectionsByRecord(edges, names, { perRecord: 5 });
  const fromAbra = by.get("abra");
  assert.equal(fromAbra.length, 2);
  assert.equal(fromAbra[0].to, "teesql", "highest score first");
  assert.equal(fromAbra[0].toName, "TeeSQL", "name resolved");
  assert.equal(by.get("teesql").length, 1);
});

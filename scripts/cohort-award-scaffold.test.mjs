import test from "node:test";
import assert from "node:assert/strict";
import engine from "./lib/cohort-insight-engine.cjs";

const teams = [
  { record_id: "alpha", name: "Alpha Lab", domain: "tee", skill_areas: ["tee"], dependencies: [] },
  { record_id: "beta", name: "Beta Works", domain: "tee", skill_areas: ["tee"], dependencies: [] },
  { record_id: "gamma", name: "Gamma Studio", domain: "design", skill_areas: ["design"], dependencies: ["alpha"] },
  { record_id: "delta", name: "Delta Systems", domain: "design", skill_areas: ["design"], dependencies: [] },
];

// One edge gamma->alpha, encoded BOTH as a dependency record and inline on gamma,
// to prove degree dedupes it to a single undirected edge.
const dependencies = [
  { record_id: "gamma-alpha", record_type: "dependency", source: "gamma", target: "alpha", relation: "depends_on" },
];

const progress = [
  {
    artifact_id: "github-progress:alpha:demo:2026-06-01",
    artifact_kind: "github_progress_weekly_summary",
    record_type: "team",
    record_id: "alpha",
    date: "2026-06-01",
    week_start: "2026-06-01",
    summary: "feature - attestation flow",
    source_repo: "alpha/demo",
    evidence: { useful_commit_count: 3, examples: ["attestation flow"] },
  },
];

const releases = [
  {
    artifact_id: "github-releases:alpha:demo",
    artifact_kind: "github_release_list",
    record_type: "team",
    record_id: "alpha",
    source_repo: "alpha/demo",
    releases: [{ tag_name: "v0.1.0", name: "alpha demo", published_at: "2026-06-02T00:00:00Z" }],
  },
];

const editorialCategories = [
  { id: "best-shape-rotation", label: "Best Shape Rotation", description: "Most substantiated pivot toward PMF." },
];

function buildAwards() {
  return engine.buildAwardCards({
    teams,
    dependencies,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
    editorialCategories,
  });
}

test("award scaffold emits a data nomination per public-signal category plus an editorial slot", () => {
  const cards = buildAwards();
  const byId = new Map(cards.map(card => [card.id, card]));

  assert.equal(cards.length, 4); // 3 data categories + 1 editorial slot
  assert.ok(byId.has("cohort-insight:award:shipped-most"));
  assert.ok(byId.has("cohort-insight:award:most-active-build"));
  assert.ok(byId.has("cohort-insight:award:most-connected"));
  assert.ok(byId.has("cohort-insight:award:editorial:best-shape-rotation"));
});

test("every award scaffold card is cohort-tier, generated, and never names a winner", () => {
  for (const card of buildAwards()) {
    assert.equal(card.kind, "award");
    assert.equal(card.subject_type, "cohort");
    assert.equal(card.surface_tier, "cohort");
    assert.equal(card.source_boundary, "public_bundle");
    assert.equal(card.review_status, "generated");
    assert.equal(card.approval_state, "not_reviewed");
    assert.equal(card.raw_allowed, false);
    assert.ok(card.subject_ids.length >= 1, "subject_ids must be non-empty (DB cardinality check)");
    assert.equal(card.content_json.verdict, null, "scaffold never carries a verdict");
  }
});

test("data nominations rank by public signal and dedupe dependency degree", () => {
  const byId = new Map(buildAwards().map(card => [card.id, card]));

  const shipped = byId.get("cohort-insight:award:shipped-most").content_json;
  assert.equal(shipped.award_kind, "data_nomination");
  assert.equal(shipped.status, "awaiting_review");
  assert.deepEqual(shipped.candidates.map(c => c.record_id), ["alpha"]);
  assert.equal(shipped.candidates[0].value, 1);

  const build = byId.get("cohort-insight:award:most-active-build").content_json;
  assert.deepEqual(build.candidates.map(c => c.record_id), ["alpha"]);
  assert.equal(build.candidates[0].value, 3);

  // gamma->alpha counted once: each endpoint has degree 1, not 2.
  const connectedCard = byId.get("cohort-insight:award:most-connected");
  const connected = connectedCard.content_json;
  const degreeByTeam = new Map(connected.candidates.map(c => [c.record_id, c.value]));
  assert.equal(degreeByTeam.get("alpha"), 1);
  assert.equal(degreeByTeam.get("gamma"), 1);
  assert.equal(degreeByTeam.has("beta"), false, "teams with no edges are not nominated");

  // H3: the basis follows the METRIC. release/commit counts are observed GitHub artifacts;
  // dependency degree is summed from DECLARED dependency records, so most-connected must NOT
  // claim observed_public_metadata — and its github-metric peers must.
  assert.equal(byId.get("cohort-insight:award:shipped-most").evidence_level, "observed_public_metadata");
  assert.equal(byId.get("cohort-insight:award:most-active-build").evidence_level, "observed_public_metadata");
  assert.equal(connectedCard.evidence_level, "declared_only");
  assert.equal(connected.basis, "declared_dependency_graph");
  assert.equal(connected.trace.basis, "declared");
  assert.doesNotMatch(connectedCard.claim_text, /public data only/);
  // TI-3/TI-4: an observed candidate's value resolves to the github artifact it was summed
  // from, and trace.inputs equals the card's source_refs.
  const buildCard = byId.get("cohort-insight:award:most-active-build");
  assert.ok(buildCard.content_json.trace.signals[0].source_refs.some(r => r.kind === "github_progress_artifact"));
  assert.deepEqual(buildCard.content_json.trace.inputs, buildCard.source_refs);
});

test("editorial slot is empty and routed to private judgment", () => {
  const slot = buildAwards().find(card => card.id === "cohort-insight:award:editorial:best-shape-rotation").content_json;
  assert.equal(slot.award_kind, "editorial_slot");
  assert.deepEqual(slot.candidates, []);
  assert.equal(slot.verdict, null);
  assert.equal(slot.status, "awaiting_private_judgment");
  assert.equal(slot.fill_source, "private_transcript_engine_then_human_review");
});

test("a category with no public signal nominates nobody but still emits a slot", () => {
  const cards = engine.buildAwardCards({ teams, dependencies: [], githubProgressArtifacts: [], githubReleaseArtifacts: [], editorialCategories: [] });
  const shipped = cards.find(card => card.id === "cohort-insight:award:shipped-most").content_json;
  assert.deepEqual(shipped.candidates, []);
  assert.equal(shipped.status, "awaiting_review");
  const card = cards.find(c => c.id === "cohort-insight:award:shipped-most");
  assert.deepEqual(card.subject_ids, ["cohort"]); // fallback subject when no candidates
  assert.equal(card.evidence_level, "declared_only");
});

test("award scaffolds flow into the bundle and stay out of the public slice", () => {
  const bundle = engine.buildCohortInsightBundle({
    teams,
    clusters: [],
    dependencies,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
    editorialCategories,
  });

  assert.equal(bundle.quality.kind_counts.award, 4);
  assert.equal(bundle.read_models.awards.length, 4);
  assert.ok(bundle.indices.by_kind.award.length === 4);

  // The whole point: a transcript-free scaffold is still gated out of public web.
  const publicBundle = engine.publicCohortInsights(bundle);
  assert.equal(publicBundle.cards.filter(card => card.kind === "award").length, 0);
});

test("award scaffolds carry no transcript/private-source markers", () => {
  const serialized = JSON.stringify(buildAwards());
  assert.doesNotMatch(serialized, /private-vault:/);
  assert.doesNotMatch(serialized, /transcript-evidence:/);
  assert.doesNotMatch(serialized, /drive:\/\//);
  assert.doesNotMatch(serialized, /do_not_publish/);
});

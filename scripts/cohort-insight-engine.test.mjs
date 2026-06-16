import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import engine from "./lib/cohort-insight-engine.cjs";

const teams = [
  {
    record_id: "alpha",
    name: "Alpha Lab",
    domain: "tee",
    focus: "TEE contract runtime",
    now: "shipping attestation-backed agent contract flow",
    weekly_goals: "demo attestation flow",
    skill_areas: ["tee", "attestation", "agentic"],
    dependencies: [],
    paper_basis: ["NDAI Agreements"],
    traction: "public demo shipped",
    prior_shipping: ["agent contract prototype"],
    offering: ["TEE attestation review"],
    journey: {
      stage: 3,
      evidence_quality: 2,
      market_upside: 4,
      primary_bottleneck: "Solution Quality",
      company_type: "Infra",
      confidence: "Medium",
      icp: "agent builders that need verifiable contract execution",
      problem: "agent contract execution is hard to trust without attestations",
      solution: "an attestation-backed contract runtime for agent workflows",
      next_milestone: "validate the flow with one integration partner",
    },
  },
  {
    record_id: "beta",
    name: "Beta Works",
    domain: "tee",
    focus: "agent attestation SDK",
    now: "building attestation SDK for agent workflows",
    skill_areas: ["tee", "attestation", "agent-runtime"],
    dependencies: [],
    seeking: ["TEE attestation integration partner"],
  },
  {
    record_id: "gamma",
    name: "Gamma Studio",
    domain: "design",
    focus: "consumer interface",
    skill_areas: ["design"],
    dependencies: ["alpha"],
  },
  {
    record_id: "delta",
    name: "Delta Systems",
    domain: "design",
    focus: "interaction design",
    skill_areas: ["design"],
  },
];

const clusters = [
  { record_id: "cluster-a", label: "Infrastructure", teams: ["alpha", "gamma"] },
  { record_id: "cluster-b", label: "Agents", teams: ["beta"] },
  { record_id: "cluster-c", label: "Interfaces", teams: ["delta"] },
];

const dependencies = [
  {
    record_id: "gamma-alpha",
    record_type: "dependency",
    source: "gamma",
    target: "alpha",
    relation: "depends_on",
  },
];

const progress = [
  {
    artifact_id: "github-progress:alpha:demo:2026-06-01",
    artifact_kind: "github_progress_weekly_summary",
    record_type: "team",
    record_id: "alpha",
    date: "2026-06-01",
    week_start: "2026-06-01",
    summary: "feature - attestation contract flow",
    source_repo: "alpha/demo",
    evidence: {
      useful_commit_count: 3,
      examples: ["attestation flow", "agent contract route"],
    },
  },
];

const releases = [
  {
    artifact_id: "github-releases:alpha:demo",
    artifact_kind: "github_release_list",
    record_type: "team",
    record_id: "alpha",
    source_repo: "alpha/demo",
    releases: [
      { tag_name: "v0.1.0", name: "alpha demo", published_at: "2026-06-02T00:00:00Z" },
    ],
  },
];

test("cohort insight bundle separates deterministic cards from gated rotation", () => {
  const bundle = engine.buildCohortInsightBundle({
    teams,
    clusters,
    dependencies,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
  });

  assert.equal(bundle.artifact_kind, "cohort_insight_bundle");
  assert.equal(bundle.raw_allowed, false);
  // project_identity has been consolidated into say_did_shipped — the kind is gone.
  assert.equal(bundle.quality.kind_counts.project_identity, undefined);
  assert.equal(bundle.read_models.project_identity, undefined);
  assert.equal(bundle.quality.kind_counts.say_did_shipped, teams.length);
  assert.ok(bundle.quality.kind_counts.latent_overlap >= 1);
  assert.equal(bundle.quality.kind_counts.rotation, 0);
  assert.equal(bundle.read_models.say_did_shipped.length, teams.length);
  assert.equal(bundle.read_models.rotation.status, "not_generated");
  assert.match(bundle.read_models.rotation.reason, /reviewed semantic-distance/);
});

test("say/did/shipped cards carry a grammar-correct identity lead", () => {
  const cards = engine.buildSayDidShippedCards({
    teams,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
  });
  const bySubject = new Map(cards.map(card => [card.subject_ids[0], card]));
  const alpha = bySubject.get("alpha");

  assert.equal(cards.length, teams.length);
  assert.equal(alpha.kind, "say_did_shipped");
  assert.equal(alpha.subject_type, "team");
  assert.equal(alpha.evidence_level, "observed_public_metadata");
  // article + lowercase company type + first focus clause — no "Infra", no "·", no "it does"
  assert.equal(alpha.content_json.what_it_is, "an infra project in trusted compute focused on TEE contract runtime");
  assert.equal(alpha.content_json.what_it_does, "provides an attestation-backed contract runtime for agent workflows");
  assert.equal(alpha.content_json.who_it_serves, "agent builders that need verifiable contract execution");
  assert.match(alpha.claim_text, /^Alpha Lab is an infra project in trusted compute focused on TEE contract runtime; it provides an attestation-backed contract runtime for agent workflows\.$/);
});

test("identity text normalizes company type, focus delimiters, and imperative verbs", () => {
  const sample = [
    { record_id: "dot", name: "Dot", domain: "tee", focus: "formal verification · dstack TEE Postgres",
      journey: { company_type: "Infra", solution: "a registry and proof workflow" } },
    { record_id: "imp", name: "Imp", domain: "crypto", focus: "anonymity network",
      journey: { company_type: "Protocol", solution: "productize anonymous broadcast and explore relays" } },
    { record_id: "acr", name: "Acr", domain: "ai", focus: "context engine",
      journey: { company_type: "AI", solution: "an episode-based context engine" } },
  ];
  const cards = engine.buildSayDidShippedCards({ teams: sample });
  const by = new Map(cards.map(card => [card.subject_ids[0], card]));
  // "·" secondary clause stripped from the focus
  assert.equal(by.get("dot").content_json.what_it_is, "an infra project in trusted compute focused on formal verification");
  // imperative lead AND compound "and <verb>" both conjugated to third person
  assert.equal(by.get("imp").content_json.what_it_does, "productizes anonymous broadcast and explores relays");
  // all-caps acronym company type preserved (not lowercased to "ai")
  assert.equal(by.get("acr").content_json.what_it_is, "an AI project in agent infrastructure focused on context engine");
});

test("say/did/shipped cards distinguish observed public movement from unobserved state", () => {
  const cards = engine.buildSayDidShippedCards({
    teams,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
  });
  const bySubject = new Map(cards.map(card => [card.subject_ids[0], card]));

  assert.equal(bySubject.get("alpha").content_json.observed_status, "public_signal_observed");
  assert.equal(bySubject.get("alpha").content_json.public_activity.useful_commit_count, 3);
  assert.equal(bySubject.get("alpha").content_json.public_activity.release_count, 1);
  assert.equal(bySubject.get("beta").content_json.observed_status, "unobserved");
  assert.equal(bySubject.get("beta").evidence_level, "declared_only");
});

test("github progress loader deduplicates generated/reviewed team-week copies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-insight-progress-"));
  const generatedDir = path.join(root, "cohort-data", "artifacts", "github-progress", "generated");
  const reviewedDir = path.join(root, "cohort-data", "artifacts", "github-progress", "reviewed");
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(reviewedDir, { recursive: true });

  const base = {
    artifact_kind: "github_progress_weekly_summary",
    record_type: "team",
    record_id: "alpha",
    date: "2026-06-01",
    week_start: "2026-06-01",
  };
  fs.writeFileSync(path.join(generatedDir, "alpha-generated.json"), JSON.stringify({
    ...base,
    artifact_id: "github-progress:alpha:generated:2026-06-01",
    review_status: "generated",
    evidence: { useful_commit_count: 3 },
  }));
  fs.writeFileSync(path.join(reviewedDir, "alpha-reviewed.json"), JSON.stringify({
    ...base,
    artifact_id: "github-progress:alpha:reviewed:2026-06-01",
    review_status: "reviewed",
    evidence: { useful_commit_count: 5 },
  }));

  const artifacts = engine.loadGithubProgressArtifacts(root);

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifact_id, "github-progress:alpha:reviewed:2026-06-01");
  assert.equal(artifacts[0].evidence.useful_commit_count, 5);
});

test("latent overlap cards skip declared dependencies and same-cluster pairs", () => {
  const cards = engine.buildLatentOverlapCards({ teams, clusters, dependencies });
  const pairIds = cards.map(card => card.subject_ids.slice().sort().join("|"));

  assert.ok(pairIds.includes("alpha|beta"), "alpha/beta should be proposed as an undeclared cross-cluster overlap");
  assert.equal(pairIds.includes("alpha|gamma"), false, "declared dependency pair should not become latent overlap");
  assert.equal(pairIds.includes("alpha|delta"), false, "weak cross-domain pair should not become latent overlap");
  const alphaBeta = cards.find(card => card.subject_ids.includes("alpha") && card.subject_ids.includes("beta"));
  assert.deepEqual(alphaBeta.content_json.shared_skill_areas, ["attestation", "tee"]);
  assert.equal(alphaBeta.content_json.existing_dependency, false);
});

test("public cohort insights exclude generated cohort cards unless explicitly approved", () => {
  const bundle = engine.buildCohortInsightBundle({
    teams,
    clusters,
    dependencies,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
  });
  const publicBundle = engine.publicCohortInsights(bundle);

  assert.equal(publicBundle.raw_allowed, false);
  assert.equal(publicBundle.cards.length, 0);
  assert.equal(publicBundle.read_models.say_did_shipped.length, 0);
  assert.equal(publicBundle.read_models.latent_overlaps.length, 0);
});

test("public cohort insights require published approval, not approval alone", () => {
  const bundle = {
    schema_version: 1,
    artifact_kind: "cohort_insight_bundle",
    cards: [
      {
        id: "reviewed-public",
        kind: "say_did_shipped",
        subject_type: "team",
        subject_ids: ["alpha"],
        surface_tier: "public",
        review_status: "reviewed",
        approval_state: "approved",
      },
      {
        id: "published-public",
        kind: "say_did_shipped",
        subject_type: "team",
        subject_ids: ["beta"],
        surface_tier: "public",
        review_status: "published",
        approval_state: "approved",
      },
      {
        id: "published-unapproved",
        kind: "say_did_shipped",
        subject_type: "team",
        subject_ids: ["gamma"],
        surface_tier: "public",
        review_status: "published",
        approval_state: "pending",
      },
    ],
  };

  const publicBundle = engine.publicCohortInsights(bundle);

  assert.deepEqual(publicBundle.cards.map(card => card.id), ["published-public"]);
  assert.equal(publicBundle.quality.card_count, 1);
});

test("cohort insight cards do not carry transcript/private-source markers", () => {
  const bundle = engine.buildCohortInsightBundle({
    teams,
    clusters,
    dependencies,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
  });
  const serialized = JSON.stringify(bundle);

  assert.doesNotMatch(serialized, /private-vault:/);
  assert.doesNotMatch(serialized, /transcript-evidence:/);
  assert.doesNotMatch(serialized, /drive:\/\//);
  assert.doesNotMatch(serialized, /"source_artifact_id"/);
});

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
    offering: ["TEE attestation review"],
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
  assert.equal(bundle.quality.kind_counts.say_did_shipped, teams.length);
  assert.ok(bundle.quality.kind_counts.latent_overlap >= 1);
  assert.equal(bundle.quality.kind_counts.rotation, 0);
  assert.equal(bundle.read_models.rotation.status, "not_generated");
  assert.match(bundle.read_models.rotation.reason, /reviewed semantic-distance/);
});

test("say/did/shipped cards distinguish observed public movement from unobserved state", () => {
  const cards = engine.buildSayDidShippedCards({
    teams,
    githubProgressArtifacts: progress,
    githubReleaseArtifacts: releases,
  });
  const bySubject = new Map(cards.map(card => [card.subject_ids[0], card]));

  assert.equal(bySubject.get("alpha").content_json.observed_status, "public_signal_observed");
  assert.equal(bySubject.get("alpha").content_json.useful_commit_count, 3);
  assert.equal(bySubject.get("alpha").content_json.release_count, 1);
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

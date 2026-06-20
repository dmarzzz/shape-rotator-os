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

// A weekly-summary artifact carrying the top-level `collaboration` snapshot that
// scripts/check-github-progress.mjs now threads through: Ada (on team `delta`)
// committed to team `alpha`'s public repo, which is a cross-team contribution.
const crossTeamProgress = [
  {
    artifact_id: "github-progress:alpha:demo:2026-06-01",
    artifact_kind: "github_progress_weekly_summary",
    record_type: "team",
    record_id: "alpha",
    date: "2026-06-01",
    week_start: "2026-06-01",
    source_repo: "alpha/demo",
    evidence: { useful_commit_count: 9 },
    collaboration: {
      matched_cohort_people: [
        { person_id: "ada", person_name: "Ada Stone", person_team_ids: ["delta"], confidence: "high", commit_count: 4 },
      ],
      possible_cross_team_contributions: [
        {
          person_id: "ada",
          person_name: "Ada Stone",
          person_team_ids: ["delta"],
          repo_team_ids: ["alpha"],
          confidence: "medium",
          commit_count: 4,
          examples: [{ date: "2026-06-01", sha: "abc123def456", subject: "feat: wire attestation into delta flow" }],
        },
      ],
    },
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
  // The default progress fixture carries no collaboration snapshot, so no edges.
  assert.equal(bundle.quality.kind_counts.collaboration_edge, 0);
  assert.equal(bundle.read_models.collaboration_edges.length, 0);
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
    source_repo: "owner/alpha",
    review_status: "generated",
    evidence: { useful_commit_count: 3 },
  }));
  fs.writeFileSync(path.join(reviewedDir, "alpha-reviewed.json"), JSON.stringify({
    ...base,
    artifact_id: "github-progress:alpha:reviewed:2026-06-01",
    source_repo: "owner/alpha",
    review_status: "reviewed",
    evidence: { useful_commit_count: 5 },
  }));
  fs.writeFileSync(path.join(generatedDir, "alpha-other-repo.json"), JSON.stringify({
    ...base,
    artifact_id: "github-progress:alpha:other:2026-06-01",
    source_repo: "owner/other",
    review_status: "generated",
    evidence: { useful_commit_count: 7 },
  }));

  const artifacts = engine.loadGithubProgressArtifacts(root);

  assert.equal(artifacts.length, 2);
  const byRepo = new Map(artifacts.map((artifact) => [artifact.source_repo, artifact]));
  assert.equal(byRepo.get("owner/alpha").artifact_id, "github-progress:alpha:reviewed:2026-06-01");
  assert.equal(byRepo.get("owner/alpha").evidence.useful_commit_count, 5);
  assert.equal(byRepo.get("owner/other").evidence.useful_commit_count, 7);
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

test("say/did/shipped collapses the focus stutter and enriches did/shipped from declared fields", () => {
  const sample = [
    // solution leads with the exact focus -> identity drops the duplicate "focused on" clause
    { record_id: "stut", name: "Stut", domain: "ai", focus: "P2P LLM router",
      journey: { company_type: "Infra", solution: "a P2P LLM router plus agent payments" } },
    // no GitHub artifact, but declared traction + prior shipping fill did/shipped (marked declared)
    { record_id: "decl", name: "Decl", domain: "tee", focus: "attestation tooling",
      traction: "first design partner signed", prior_shipping: ["attestation CLI", "policy SDK"],
      journey: { company_type: "Infra", solution: "an attestation toolkit", next_milestone: "ship the hosted beta" } },
  ];
  const cards = engine.buildSayDidShippedCards({ teams: sample });
  const by = new Map(cards.map((card) => [card.subject_ids[0], card]));

  // stutter collapsed: no "focused on P2P LLM router ... provides a P2P LLM router"
  assert.equal(by.get("stut").content_json.what_it_is, "an infra project in agent infrastructure");
  assert.doesNotMatch(by.get("stut").claim_text, /focused on .*; it provides a P2P LLM router/i);

  // declared enrichment: did/shipped come from declared fields, clearly labelled, still declared_only
  const decl = by.get("decl");
  assert.equal(decl.evidence_level, "declared_only");
  assert.equal(decl.content_json.did_basis, "declared");
  assert.equal(decl.content_json.shipped_basis, "declared");
  assert.match(decl.content_json.did, /^Declared \(no public artifact yet\): first design partner signed/);
  assert.match(decl.content_json.shipped, /^Declared: attestation CLI; policy SDK/);
});

test("latent overlap signal dedupes the shared-skill / shared-domain token", () => {
  const alphaBeta = engine.buildLatentOverlapCards({ teams, clusters, dependencies })
    .find((card) => card.subject_ids.includes("alpha") && card.subject_ids.includes("beta"));
  // "tee" is both a shared skill and the shared domain — it must appear once, not "tee, tee"
  assert.doesNotMatch(alphaBeta.claim_text, /\btee,\s*tee\b/i);
  assert.match(alphaBeta.claim_text, /\btee\b/i);
});

test("latent overlap weights shared terms by rarity (idf), not a hardcoded stopword list", () => {
  // A distinctive vocabulary shared by exactly one pair is a real signal; the SAME
  // vocabulary, once it is cohort-ubiquitous, must stop fabricating an overlap — and
  // without anyone hand-adding it to a stopword list. pp/qq share a weak domain (+18)
  // plus seven distinctive terms; nothing else links them.
  const distinctive = "holography metamaterial photonics interferometry birefringence diffraction polarimetry";
  const pair = [
    { record_id: "pp", name: "PP", domain: "qx", focus: distinctive, skill_areas: ["skill-pp"], dependencies: [] },
    { record_id: "qq", name: "QQ", domain: "qx", focus: distinctive, skill_areas: ["skill-qq"], dependencies: [] },
  ];
  // Filler teams have unique domain/skill so no OTHER pair ever clears the bar; their
  // focus is the only knob we turn between the two scenarios.
  const filler = (id, focus = "") => ({ record_id: id, name: id, domain: `dom-${id}`, focus, skill_areas: [`skill-${id}`], dependencies: [] });
  const fillerIds = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"];
  // Each team in its OWN cluster so nothing is skipped as a same-cluster pair.
  const clustersOf = (list) => list.map((t) => ({ record_id: `c-${t.record_id}`, label: t.record_id, teams: [t.record_id] }));

  // Scenario A: the distinctive terms live ONLY in the pair (df = 2).
  const rareTeams = [...pair, ...fillerIds.map((id) => filler(id))];
  const rareCards = engine.buildLatentOverlapCards({ teams: rareTeams, clusters: clustersOf(rareTeams), dependencies: [] });
  const rarePQ = rareCards.find((c) => c.subject_ids.includes("pp") && c.subject_ids.includes("qq"));
  assert.ok(rarePQ, "a pair sharing RARE distinctive terms IS proposed as a latent overlap");

  // Scenario B: identical pair, but now the same terms are everywhere in the cohort.
  const ubiqTeams = [...pair, ...fillerIds.map((id) => filler(id, distinctive))];
  const ubiqCards = engine.buildLatentOverlapCards({ teams: ubiqTeams, clusters: clustersOf(ubiqTeams), dependencies: [] });
  const ubiqPQ = ubiqCards.find((c) => c.subject_ids.includes("pp") && c.subject_ids.includes("qq"));

  if (ubiqPQ) {
    assert.ok(ubiqPQ.content_json.score < rarePQ.content_json.score,
      "ubiquitous shared vocabulary must score strictly lower than the same terms when rare");
  }
  // The headline: cohort-ubiquitous buzzwords no longer clear the bar on their own —
  // and no maintainer ever had to add them to a list.
  assert.equal(Boolean(ubiqPQ), false,
    "cohort-ubiquitous shared vocabulary must NOT fabricate a latent overlap by itself");
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

test("collaboration edges turn cross-team commit attribution into team-pair cards", () => {
  const cards = engine.buildCollaborationEdgeCards({ teams, githubProgressArtifacts: crossTeamProgress });

  assert.equal(cards.length, 1);
  const edge = cards[0];
  assert.equal(edge.kind, "collaboration_edge");
  assert.equal(edge.subject_type, "team_pair");
  // unordered, sorted by record_id: alpha < delta
  assert.deepEqual(edge.subject_ids, ["alpha", "delta"]);
  // observed public commit authorship, but the author->person match keeps it medium
  assert.equal(edge.evidence_level, "observed_public_metadata");
  assert.equal(edge.confidence, "medium");
  // generated + cohort-tier so the app shows review status and the public web excludes it
  assert.equal(edge.review_status, "generated");
  assert.equal(edge.surface_tier, "cohort");

  assert.equal(edge.content_json.total_commit_count, 4);
  assert.equal(edge.content_json.contributor_count, 1);
  assert.deepEqual(edge.content_json.contributors, ["Ada Stone"]);
  assert.deepEqual(edge.content_json.repos, ["alpha/demo"]);
  assert.equal(edge.content_json.directions.length, 1);
  assert.equal(edge.content_json.directions[0].from_team, "delta");
  assert.equal(edge.content_json.directions[0].to_team, "alpha");
  assert.match(edge.claim_text, /Ada Stone/);
  assert.match(edge.claim_text, /Alpha Lab/);
  // source refs point at both team records plus the backing progress artifact
  const refKinds = edge.source_refs.map(ref => ref.kind);
  assert.ok(refKinds.includes("team_record"));
  assert.ok(refKinds.includes("github_progress_artifact"));
});

test("collaboration edges dedupe the replicated repo snapshot and skip same/unknown teams", () => {
  const adaContribution = {
    person_id: "ada",
    person_name: "Ada Stone",
    person_team_ids: ["delta"],
    repo_team_ids: ["alpha"],
    confidence: "medium",
    commit_count: 4,
    examples: [],
  };
  const base = {
    artifact_kind: "github_progress_weekly_summary",
    record_type: "team",
    record_id: "alpha",
    source_repo: "alpha/demo",
    evidence: { useful_commit_count: 4 },
  };
  const artifacts = [
    // Same repo-level snapshot replicated across two weekly artifacts — must count once.
    { ...base, artifact_id: "github-progress:alpha:demo:2026-06-01", date: "2026-06-01", week_start: "2026-06-01",
      collaboration: { matched_cohort_people: [], possible_cross_team_contributions: [adaContribution] } },
    { ...base, artifact_id: "github-progress:alpha:demo:2026-06-08", date: "2026-06-08", week_start: "2026-06-08",
      collaboration: { matched_cohort_people: [], possible_cross_team_contributions: [adaContribution] } },
    // Same-team contribution (delta member on a delta repo) — not a cross-team edge.
    { ...base, artifact_id: "github-progress:delta:repo:2026-06-01", record_id: "delta", source_repo: "delta/repo",
      date: "2026-06-01", week_start: "2026-06-01",
      collaboration: { matched_cohort_people: [], possible_cross_team_contributions: [
        { person_id: "dee", person_name: "Dee", person_team_ids: ["delta"], repo_team_ids: ["delta"], confidence: "low", commit_count: 2 },
      ] } },
    // Contribution involving a team id that is not in the cohort — dropped.
    { ...base, artifact_id: "github-progress:alpha:demo2:2026-06-01", source_repo: "alpha/demo2",
      date: "2026-06-01", week_start: "2026-06-01",
      collaboration: { matched_cohort_people: [], possible_cross_team_contributions: [
        { person_id: "ext", person_name: "Ext", person_team_ids: ["not-a-team"], repo_team_ids: ["alpha"], confidence: "low", commit_count: 9 },
      ] } },
  ];

  const cards = engine.buildCollaborationEdgeCards({ teams, githubProgressArtifacts: artifacts });

  assert.equal(cards.length, 1, "only the real alpha/delta cross-team edge should survive");
  assert.deepEqual(cards[0].subject_ids, ["alpha", "delta"]);
  // 4, not 8 — the replicated week-2 snapshot is deduped, not summed.
  assert.equal(cards[0].content_json.total_commit_count, 4);
  assert.equal(cards[0].content_json.contributor_count, 1);
});

test("cohort insight bundle surfaces collaboration edges keyed by team pair", () => {
  const bundle = engine.buildCohortInsightBundle({
    teams,
    clusters,
    dependencies,
    githubProgressArtifacts: crossTeamProgress,
    githubReleaseArtifacts: releases,
  });

  assert.equal(bundle.quality.kind_counts.collaboration_edge, 1);
  assert.equal(bundle.read_models.collaboration_edges.length, 1);
  assert.equal(bundle.indices.by_kind.collaboration_edge.length, 1);
  const edgeId = bundle.read_models.collaboration_edges[0].id;
  assert.ok(bundle.cards.some(card => card.id === edgeId));
  // edge is indexed under both of its team subjects
  assert.ok(bundle.indices.by_subject.alpha.includes(edgeId));
  assert.ok(bundle.indices.by_subject.delta.includes(edgeId));
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

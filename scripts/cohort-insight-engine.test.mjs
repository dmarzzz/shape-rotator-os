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
  // The capability lead is ALWAYS declared mood (observed activity != observed capability),
  // so even an observed team reads "aims to provide", with the observed proof in did/shipped.
  assert.equal(alpha.content_json.what_it_does, "aims to provide an attestation-backed contract runtime for agent workflows");
  assert.equal(alpha.content_json.what_it_does_basis, "declared");
  assert.equal(alpha.content_json.who_it_serves, "agent builders that need verifiable contract execution");
  assert.match(alpha.claim_text, /^Alpha Lab is an infra project in trusted compute focused on TEE contract runtime; it aims to provide an attestation-backed contract runtime for agent workflows\.$/);
});

test("identity text normalizes company type, focus delimiters, and conjugates verbs by mood", () => {
  const sample = [
    { record_id: "dot", name: "Dot", domain: "tee", focus: "formal verification · dstack TEE Postgres",
      journey: { company_type: "Infra", solution: "a registry and proof workflow" } },
    { record_id: "imp", name: "Imp", domain: "crypto", focus: "anonymity network",
      journey: { company_type: "Protocol", solution: "productize anonymous broadcast and explore relays" } },
    { record_id: "acr", name: "Acr", domain: "ai", focus: "context engine",
      journey: { company_type: "AI", solution: "an episode-based context engine" } },
  ];
  // imp has an OBSERVED public artifact -> present-tense operating claim; dot/acr are
  // declared-only -> aspirational mood, so an unbuilt plan never reads as a shipped product.
  const observed = [{
    artifact_kind: "github_progress_weekly_summary", record_type: "team", record_id: "imp",
    date: "2026-06-01", week_start: "2026-06-01", source_repo: "imp/net",
    evidence: { useful_commit_count: 4 },
  }];
  const cards = engine.buildSayDidShippedCards({ teams: sample, githubProgressArtifacts: observed });
  const by = new Map(cards.map(card => [card.subject_ids[0], card]));
  // "·" secondary clause stripped from the focus
  assert.equal(by.get("dot").content_json.what_it_is, "an infra project in trusted compute focused on formal verification");
  // The capability lead is ALWAYS declared mood, so an imperative lead + compound "and <verb>"
  // base-form under "plans to ..." even for the OBSERVED team (its did/shipped carry the proof).
  assert.equal(by.get("imp").content_json.what_it_does, "plans to productize anonymous broadcast and explore relays");
  assert.equal(by.get("imp").content_json.claim_basis, "observed"); // card-level basis still tracks the observed did/shipped
  assert.equal(by.get("imp").content_json.what_it_does_basis, "declared");
  // declared-only -> a noun-phrase solution reads "aims to provide ..."
  assert.equal(by.get("dot").content_json.what_it_does, "aims to provide a registry and proof workflow");
  assert.equal(by.get("dot").content_json.claim_basis, "declared");
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

test("declared mood base-forms a conjugated verb lead and compound (plans to build/power, not builds/powers)", () => {
  const sample = [
    { record_id: "cv", name: "Cv", domain: "ai", focus: "router",
      journey: { company_type: "Infra", solution: "builds a P2P router and powers agent payments" } },
  ];
  const card = engine.buildSayDidShippedCards({ teams: sample }).find(c => c.subject_ids[0] === "cv");
  assert.equal(card.content_json.what_it_does, "plans to build a P2P router and power agent payments");
  assert.doesNotMatch(card.content_json.what_it_does, /plans to builds|and powers/);
});

test("say/did/shipped recovers matched_cohort_people as a contributor roster", () => {
  const progressWithPeople = [{
    artifact_kind: "github_progress_weekly_summary", record_type: "team", record_id: "alpha",
    date: "2026-06-01", week_start: "2026-06-01", source_repo: "alpha/demo",
    evidence: { useful_commit_count: 9 },
    collaboration: {
      matched_cohort_people: [
        { person_id: "ada", person_name: "Ada Stone", confidence: "high", reason: "github_noreply_email", commit_count: 7 },
        { person_id: "ben", person_name: "Ben Lee", confidence: "medium", reason: "exact_author_name", commit_count: 2 },
      ],
      possible_cross_team_contributions: [],
    },
  }];
  const card = engine.buildSayDidShippedCards({ teams, githubProgressArtifacts: progressWithPeople })
    .find(c => c.subject_ids[0] === "alpha");
  const roster = card.content_json.contributors;
  // PRIV-3: only the reliable github-noreply email match NAMES a person; the exact-name
  // namesake (Ben) is excluded so a possible-namesake match never attributes named authorship.
  assert.equal(roster.length, 1);
  assert.equal(roster[0].person_name, "Ada Stone");
  assert.equal(roster[0].match_quality, "github-noreply email match");
  assert.ok(roster.every(p => p.match_quality === "github-noreply email match"));
  // and it travels in the trace as a contributors signal, citing the progress artifacts
  const sig = card.content_json.trace.signals.find(s => s.name === "contributors");
  assert.ok(sig && sig.value.length === 1, "named contributors ride the trace");
});

test("public_activity aggregates change-type / topic / author mix across weeks and filters bot authors", () => {
  const sample = [{ record_id: "agg", name: "Agg", domain: "ai", focus: "x", journey: {} }];
  const mk = (week, evidence) => ({ record_id: "agg", artifact_kind: "github_progress_weekly_summary", week_start: week, date: week, evidence });
  const progressAgg = [
    mk("2026-05-18", { useful_commit_count: 5,
      categories: [{ key: "feature", count: 3 }, { key: "other", count: 2 }],
      topics: [{ key: "agent", count: 2 }],
      authors: [{ key: "Ada", count: 4 }, { key: "github-actions[bot]", count: 10 }] }),
    mk("2026-05-25", { useful_commit_count: 4,
      categories: [{ key: "feature", count: 1 }, { key: "fix", count: 4 }],
      topics: [{ key: "agent", count: 1 }, { key: "auth", count: 3 }],
      authors: [{ key: "Ada", count: 2 }, { key: "dependabot[bot]", count: 7 }] }),
  ];
  const card = engine.buildSayDidShippedCards({ teams: sample, githubProgressArtifacts: progressAgg })[0];
  const pa = card.content_json.public_activity;
  // change types summed across weeks, sorted desc (feature 4, fix 4, other 2)
  assert.equal(pa.change_types[0].key, "feature");
  assert.equal(pa.change_types.find(c => c.key === "fix").count, 4);
  // topics merged (agent 3, auth 3)
  assert.equal(pa.topics[0].key, "agent");
  assert.ok(pa.topics.some(t => t.key === "auth"));
  // authors: bots dropped, the human survives with the summed count
  assert.equal(pa.authors[0].key, "Ada");
  assert.equal(pa.authors[0].count, 6);
  assert.ok(!pa.authors.some(a => /\[bot\]/.test(a.key)), "bot authors must be filtered out");
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

test("cards carry a recomputable reasoning trace with an honest basis", () => {
  const bundle = engine.buildCohortInsightBundle({
    teams, clusters, dependencies,
    githubProgressArtifacts: progress, githubReleaseArtifacts: releases,
  });
  const sds = bundle.read_models.say_did_shipped.find(c => c.subject_ids[0] === "alpha");
  const lo = bundle.read_models.latent_overlaps.find(c => c.subject_ids.includes("alpha") && c.subject_ids.includes("beta"));

  // say/did/shipped: observed basis, one signal per line, each citing its own source refs
  const st = sds.content_json.trace;
  assert.equal(st.basis, "observed");
  assert.equal(st.version, 1);
  assert.deepEqual(st.signals.map(s => s.name), ["say", "did", "shipped"]);
  assert.ok(st.signals.every(s => Array.isArray(s.source_refs) && s.source_refs.length), "each line cites its source");
  assert.match(st.confidence_basis, /github-progress/);
  assert.ok(st.recompute, "records how to recompute");

  // latent_overlap: inferred basis, and the score breakdown SUMS to the published score
  const lt = lo.content_json.trace;
  assert.equal(lt.basis, "inferred");
  assert.equal(lt.version, 3);
  // every contributing latent-overlap signal cites the two team records it came from
  assert.ok(lt.signals.filter(s => s.contribution > 0).every(s => Array.isArray(s.source_refs) && s.source_refs.length));
  const bd = lo.content_json.score_breakdown;
  const sum = bd.shared_skills.subtotal + bd.domain_match.subtotal + bd.common_dependencies.subtotal + bd.shared_terms_idf.subtotal;
  assert.equal(Math.min(100, sum), lo.content_json.score, "score is explained by its component breakdown");
  assert.equal(lo.content_json.idf_basis.cohort_team_count, teams.length);
  // every shared term carries its cohort document frequency + idf weight (recomputable)
  assert.ok(lo.content_json.shared_terms_weighted.every(t => typeof t.idf_weight === "number" && typeof t.doc_freq === "number"));
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

test("collaboration edge confidence is signal-weighted and carries the identity-match basis", () => {
  const base = {
    artifact_kind: "github_progress_weekly_summary", record_type: "team",
    record_id: "alpha", source_repo: "alpha/demo", date: "2026-06-01", week_start: "2026-06-01",
    evidence: { useful_commit_count: 1 },
  };
  // A single one-commit, exact-name (low) match is the weakest possible signal -> low,
  // and the person->team identity is inferred (no github-noreply email match).
  const weak = engine.buildCollaborationEdgeCards({ teams, githubProgressArtifacts: [{
    ...base, artifact_id: "a:1",
    collaboration: { matched_cohort_people: [], possible_cross_team_contributions: [
      { person_id: "ada", person_name: "Ada Stone", person_team_ids: ["delta"], repo_team_ids: ["alpha"], confidence: "low", commit_count: 1 },
    ] },
  }] })[0];
  assert.equal(weak.confidence, "low");
  assert.equal(weak.content_json.identity_inferred, true);
  assert.equal(weak.content_json.trace.basis, "observed_with_inferred_identity");
  assert.equal(weak.content_json.directions[0].contributions[0].match_quality, "exact-name match (possible namesake)");

  // A github-noreply (medium) match with several commits -> medium, identity observed.
  const strong = engine.buildCollaborationEdgeCards({ teams, githubProgressArtifacts: [{
    ...base, artifact_id: "a:2",
    collaboration: { matched_cohort_people: [], possible_cross_team_contributions: [
      { person_id: "ada", person_name: "Ada Stone", person_team_ids: ["delta"], repo_team_ids: ["alpha"], confidence: "medium", commit_count: 6 },
    ] },
  }] })[0];
  assert.equal(strong.confidence, "medium");
  assert.equal(strong.content_json.identity_inferred, false);
  assert.equal(strong.content_json.trace.basis, "observed");
  assert.equal(strong.content_json.directions[0].contributions[0].match_quality, "github-noreply email match");
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

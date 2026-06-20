// cohort-award-scaffold.cjs — the PUBLIC, deterministic half of cohort awards.
//
// An award is a reviewed model judgment (the same species as the gated `rotation`
// kind), so the real verdict is produced by the PRIVATE transcript engine and
// written straight to Supabase as a needs_review card (source_boundary
// `derived_model_judgment`), then approved by a coordinator. This module never
// reads a transcript and never names a winner. It only emits two safe things:
//
//   • data nominations — candidate lists ranked by PUBLIC signal (releases,
//                         useful commits, dependency-graph degree). A candidate
//                         list, explicitly NOT a verdict (verdict: null).
//   • editorial slots   — one empty placeholder per category Tina declares in
//                         cohort-data/awards.yml, awaiting the private engine +
//                         human review to fill.
//
// Every card it returns is cohort-tier / generated / not_reviewed with the
// public_bundle source boundary, so it can never reach the public web slice and
// is safe to commit to the generated manifest. makeInsightCard + the small text
// helpers are INJECTED by the engine to avoid a circular require and any drift in
// the canonical card shape.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const COHORT_SUBJECT = "cohort";
const MAX_CANDIDATES = 5;

// Categories the public bundle can back with public data only.
const DATA_CATEGORIES = [
  { id: "shipped-most", label: "Shipped the Most (public releases)", metric: "public_release_count" },
  { id: "most-active-build", label: "Most Active Build (useful public commits)", metric: "useful_commit_count" },
  { id: "most-connected", label: "Most Connected (dependency-graph degree)", metric: "dependency_degree" },
];

function teamName(team) {
  return (team && (team.name || team.record_id)) || "";
}

function rankCandidates(teams, valueFn) {
  return teams
    .map((team) => ({ record_id: team.record_id, name: teamName(team), value: valueFn(team) }))
    .filter((row) => row.record_id && row.value > 0)
    .sort((a, b) => b.value - a.value || String(a.record_id).localeCompare(String(b.record_id)))
    .slice(0, MAX_CANDIDATES);
}

// Undirected dependency degree, deduped across BOTH the dependency records and the
// inline team.dependencies arrays so a single edge encoded in both places counts
// once.
function dependencyDegree(teams, dependencies, asArray) {
  const edges = new Set();
  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    edges.add(String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);
  };
  for (const dep of asArray(dependencies)) if (dep) addEdge(dep.source, dep.target);
  for (const team of asArray(teams)) for (const target of asArray(team.dependencies)) addEdge(team.record_id, target);
  const degree = new Map();
  for (const key of edges) {
    const [a, b] = key.split("|");
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
  }
  return degree;
}

function buildDataNominationCard({ category, candidates, makeInsightCard, sourceRef, helpers = {} }) {
  const observed = candidates.length > 0;
  const lead = observed
    ? candidates.slice(0, 3).map((c) => `${c.name} (${c.value})`).join(", ")
    : "no public signal yet";
  const { makeTrace, traceSignal, EVIDENCE_BASIS = {}, ALGORITHM_VERSIONS = {} } = helpers;
  // A nomination, never a verdict: the trace records the ranking metric and each
  // candidate's value with a ref to the team it came from, so the list is verifiable.
  const trace = typeof makeTrace === "function"
    ? makeTrace({
      method: "award_scaffold_public_signal",
      version: ALGORITHM_VERSIONS.award,
      basis: observed ? EVIDENCE_BASIS.OBSERVED : EVIDENCE_BASIS.DECLARED,
      confidence: "low",
      confidenceBasis: `candidate list ranked by ${category.metric} from public metadata — a nomination, never a verdict`,
      signals: candidates.map((c) => traceSignal({
        name: c.record_id,
        value: c.value,
        detail: category.metric,
        sourceRefs: [sourceRef("team_record", { record_id: c.record_id, path: `cohort-data/teams/${c.record_id}.md` })],
      })),
      inputs: [sourceRef("award_category", { category_id: category.id, basis: "public_signal" })],
      recompute: `rank teams by ${category.metric} over committed github/dependency artifacts`,
    })
    : null;
  return makeInsightCard({
    id: `cohort-insight:award:${category.id}`,
    kind: "award",
    subjectType: COHORT_SUBJECT,
    subjectIds: observed ? candidates.map((c) => c.record_id) : [COHORT_SUBJECT],
    title: `Award nomination — ${category.label}`,
    claimText: `Public-signal candidates for "${category.label}": ${lead}. Candidate list from public data only, not a verdict.`,
    summary: observed
      ? `Ranked by ${category.metric} from public GitHub/cohort metadata. Awaiting reviewed judgment before any winner is named.`
      : `No public ${category.metric} signal is available yet; this category needs reviewed judgment to nominate.`,
    evidenceLevel: observed ? "observed_public_metadata" : "declared_only",
    confidence: "low",
    sourceRefs: [
      sourceRef("award_category", { category_id: category.id, basis: "public_signal" }),
      ...candidates.map((c) => sourceRef("team_record", { record_id: c.record_id, path: `cohort-data/teams/${c.record_id}.md` })),
    ],
    contentJson: {
      award_kind: "data_nomination",
      category_id: category.id,
      category_label: category.label,
      basis: "public_signal",
      metric: category.metric,
      candidates,
      verdict: null,
      status: "awaiting_review",
      note: "Candidate list from public data only. The winner is a reviewed judgment, not produced by this deterministic public bundle.",
      ...(trace ? { trace } : {}),
    },
  });
}

function buildEditorialSlotCard({ category, makeInsightCard, sourceRef, compactText, helpers = {} }) {
  const label = compactText(category.label || category.id, 80);
  const { makeTrace, EVIDENCE_BASIS = {}, ALGORITHM_VERSIONS = {} } = helpers;
  // An empty placeholder; the trace says plainly that the verdict is filled elsewhere
  // (private engine + human review) so a reader never mistakes it for a generated winner.
  const trace = typeof makeTrace === "function"
    ? makeTrace({
      method: "award_editorial_slot",
      version: ALGORITHM_VERSIONS.award,
      basis: EVIDENCE_BASIS.DECLARED,
      confidence: "low",
      confidenceBasis: "empty editorial placeholder; the verdict is a reviewed model judgment filled in Supabase, never here",
      signals: [],
      inputs: [sourceRef("award_category_config", { path: "cohort-data/awards.yml", category_id: category.id })],
      recompute: "declared editorial category from cohort-data/awards.yml",
    })
    : null;
  return makeInsightCard({
    id: `cohort-insight:award:editorial:${category.id}`,
    kind: "award",
    subjectType: COHORT_SUBJECT,
    subjectIds: [COHORT_SUBJECT],
    title: `Award slot — ${label}`,
    claimText: `Editorial award "${label}" awaits a reviewed judgment over public and private information.`,
    summary: compactText(
      category.description
        || "Editorial award category. Nominees and rationale are filled by the private transcript engine and human review, never by this public bundle.",
      320,
    ),
    evidenceLevel: "declared_only",
    confidence: "low",
    sourceRefs: [sourceRef("award_category_config", { path: "cohort-data/awards.yml", category_id: category.id })],
    contentJson: {
      award_kind: "editorial_slot",
      category_id: category.id,
      category_label: label,
      description: compactText(category.description || "", 280),
      basis: "editorial",
      candidates: [],
      verdict: null,
      status: "awaiting_private_judgment",
      fill_source: "private_transcript_engine_then_human_review",
      note: "Filled in Supabase as a needs_review card (source_boundary derived_model_judgment); never written into the public bundle.",
      ...(trace ? { trace } : {}),
    },
  });
}

function buildAwardCards({
  teams = [],
  dependencies = [],
  githubProgressArtifacts = [],
  githubReleaseArtifacts = [],
  editorialCategories = [],
  makeInsightCard,
  helpers = {},
} = {}) {
  const { asArray, compactText, sourceRef, groupBy, usefulCommitCount, releaseRows } = helpers;
  if (typeof makeInsightCard !== "function") throw new Error("buildAwardCards requires an injected makeInsightCard");

  const teamList = asArray(teams).filter((team) => team && team.record_id);
  const progressByTeam = groupBy(githubProgressArtifacts, (artifact) => artifact.record_id);
  const releasesByTeam = groupBy(githubReleaseArtifacts, (artifact) => artifact.record_id);
  const degree = dependencyDegree(teamList, dependencies, asArray);

  const metricFns = {
    public_release_count: (team) => asArray(releasesByTeam.get(team.record_id)).flatMap(releaseRows).length,
    useful_commit_count: (team) => asArray(progressByTeam.get(team.record_id)).reduce((sum, artifact) => sum + usefulCommitCount(artifact), 0),
    dependency_degree: (team) => degree.get(team.record_id) || 0,
  };

  const dataCards = DATA_CATEGORIES.map((category) => buildDataNominationCard({
    category,
    candidates: rankCandidates(teamList, metricFns[category.metric]),
    makeInsightCard,
    sourceRef,
    helpers,
  }));

  const editorialCards = asArray(editorialCategories)
    .filter((category) => category && category.id)
    .map((category) => buildEditorialSlotCard({ category, makeInsightCard, sourceRef, compactText, helpers }));

  return [...dataCards, ...editorialCards];
}

// Editorial categories Tina declares in cohort-data/awards.yml. Missing file →
// no editorial slots (the data nominations still build), so this never hard-fails
// a calendar/insight build on a fresh checkout.
function loadEditorialAwardCategories(root = path.resolve(__dirname, "..", "..")) {
  const file = path.join(root, "cohort-data", "awards.yml");
  if (!fs.existsSync(file)) return [];
  const doc = yaml.load(fs.readFileSync(file, "utf8")) || {};
  const list = Array.isArray(doc.editorial_categories) ? doc.editorial_categories : [];
  return list
    .filter((category) => category && category.id)
    .map((category) => ({
      id: String(category.id),
      label: category.label || String(category.id),
      description: category.description || "",
    }));
}

module.exports = { buildAwardCards, loadEditorialAwardCategories, DATA_CATEGORIES };

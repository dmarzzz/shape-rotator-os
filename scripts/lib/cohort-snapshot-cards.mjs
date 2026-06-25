// cohort-snapshot-cards.mjs — the WRITE side of the LLM-computation snapshot.
//
// The daily local-AI routine produces three things — connection edges, a frozen
// card->team attribution, and per-cluster summaries. Instead of a parallel
// public_cohort_connections table, this shapes them into cohort_insight_cards in
// the EXISTING cohort_insight_bundle manifest shape, so scripts/publish-cohort-
// insights-supabase.mjs upserts them unchanged and the renderer reads them via
// fetchCohortInsightCards (shapers: connectionEdgesFromInsightCards /
// frozenAttributionFromInsightCards in cohort-evidence-index.mjs).
//
// PRIVACY CONTRACT (mirrors the cohort_insight_cards CHECKs + boundary trigger):
//   - surface_tier 'cohort' (NOT 'public') — these sit behind the cohort-key
//     gated app view, never the anon public view.
//   - source_boundary 'public_bundle', raw_allowed false, evidence_level
//     'inferred_public_metadata'.
//   - content_json NEVER carries the five private provenance keys
//     (source_artifact_id / processing_job_id / derived_artifact_id /
//     storage_ref / drive_file_id) — assertNoPrivateContent throws if it would.
//   - source_refs point ONLY at public paths (cohort-data/teams,
//     cohort-data/artifacts) — assertPublicSourceRefs throws otherwise.
// Pure + deterministic (generated_at nulled by the caller for byte-stable
// --check), so it is unit-tested without a live Supabase or any LLM.

const PRIVATE_CONTENT_KEYS = [
  "source_artifact_id", "processing_job_id", "derived_artifact_id", "storage_ref", "drive_file_id",
];
const PUBLIC_SOURCE_PREFIXES = ["cohort-data/teams/", "cohort-data/people/", "cohort-data/clusters/", "cohort-data/artifacts/"];

export function assertNoPrivateContent(contentJson) {
  for (const k of PRIVATE_CONTENT_KEYS) {
    if (contentJson && Object.prototype.hasOwnProperty.call(contentJson, k)) {
      throw new Error(`snapshot card content_json must not contain private key '${k}'`);
    }
  }
}
export function assertPublicSourceRefs(refs) {
  for (const r of (Array.isArray(refs) ? refs : [])) {
    const p = String((r && r.path) || "");
    if (p && !PUBLIC_SOURCE_PREFIXES.some((pre) => p.startsWith(pre))) {
      throw new Error(`snapshot card source_ref path '${p}' is not under a public cohort-data path`);
    }
  }
}

const BASE = {
  evidence_level: "inferred_public_metadata",
  confidence: "low",
  surface_tier: "cohort",
  source_boundary: "public_bundle",
  review_status: "generated",
  approval_state: "not_reviewed",
  raw_allowed: false,
  generated_by: "scripts/build-cohort-connections.mjs",
  generated_at: null,
};

function teamRef(id) {
  return { kind: "team_record", record_id: id, path: `cohort-data/teams/${id}.md` };
}

// One connection_edge card: directional "from should talk to `to`".
export function connectionEdgeCard(edge, { nameById = new Map() } = {}) {
  const from = String(edge.from || "").trim();
  const to = String(edge.to || "").trim();
  if (!from || !to) throw new Error("connection edge needs from + to");
  const name = (id) => (nameById instanceof Map ? nameById.get(id) : nameById?.[id]) || id;
  const content_json = {
    from_team: from,
    to_team: to,
    reason: String(edge.reason || ""),
    basis: edge.basis === "declared" ? "declared" : "inferred",
    score: Number.isFinite(Number(edge.score)) ? Math.max(0, Math.min(1, Number(edge.score))) : 0.5,
    ...(edge.kind ? { kind: String(edge.kind) } : {}),
  };
  assertNoPrivateContent(content_json);
  const source_refs = [teamRef(from), teamRef(to)];
  assertPublicSourceRefs(source_refs);
  return {
    ...BASE,
    id: `connection_edge:${from}->${to}`,
    kind: "connection_edge",
    subject_type: "team_pair",
    subject_ids: [from, to],
    title: `${name(from)} → ${name(to)}`,
    claim_text: String(edge.reason || ""),
    summary: null,
    source_refs,
    content_json,
  };
}

// One card_attribution card: the frozen team(s) inferred for a live insight card.
export function cardAttributionCard(attr) {
  const cardId = String(attr.card_id || "").trim();
  const teams = (Array.isArray(attr.teams) ? attr.teams : []).map(String).filter(Boolean);
  if (!cardId || !teams.length) throw new Error("attribution needs card_id + teams");
  const content_json = { card_id: cardId, teams, teams_basis: attr.teams_basis === "declared" ? "declared" : "inferred" };
  assertNoPrivateContent(content_json);
  const source_refs = teams.map(teamRef);
  assertPublicSourceRefs(source_refs);
  return {
    ...BASE,
    id: `card_attribution:${cardId}`,
    kind: "card_attribution",
    subject_type: "team",
    subject_ids: teams,
    title: `attribution · ${cardId}`,
    claim_text: `Session insight attributed to ${teams.join(", ")} (inferred from public team vocabulary).`,
    summary: null,
    source_refs,
    content_json,
  };
}

// One cluster_summary card.
export function clusterSummaryCard(summary) {
  const clusterId = String(summary.cluster_id || "").trim();
  if (!clusterId) throw new Error("cluster summary needs cluster_id");
  const members = (Array.isArray(summary.member_teams) ? summary.member_teams : []).map(String).filter(Boolean);
  const content_json = { cluster_id: clusterId, summary: String(summary.summary || ""), member_teams: members };
  assertNoPrivateContent(content_json);
  const source_refs = [{ kind: "cluster_record", record_id: clusterId, path: `cohort-data/clusters/${clusterId}.md` }, ...members.map(teamRef)];
  assertPublicSourceRefs(source_refs);
  return {
    ...BASE,
    id: `cluster_summary:${clusterId}`,
    kind: "cluster_summary",
    subject_type: "cluster",
    subject_ids: [clusterId],
    title: `${clusterId} · summary`,
    claim_text: String(summary.summary || ""),
    summary: String(summary.summary || ""),
    source_refs,
    content_json,
  };
}

// Assemble the full cohort_insight_bundle manifest the publisher consumes.
export function buildSnapshotManifest({ edges = [], attributions = [], summaries = [], nameById = new Map() } = {}) {
  const cards = [
    ...edges.map((e) => connectionEdgeCard(e, { nameById })),
    ...attributions.map(cardAttributionCard),
    ...summaries.map(clusterSummaryCard),
  ];
  return {
    schema_version: 1,
    artifact_kind: "cohort_insight_bundle",
    generated_by: "scripts/build-cohort-connections.mjs",
    generated_at: null,
    raw_allowed: false,
    source_boundary: "public_bundle",
    cards,
  };
}

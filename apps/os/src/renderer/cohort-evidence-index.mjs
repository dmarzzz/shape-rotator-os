// cohort-evidence-index.js — the data layer the cohort VIEWS consume.
//
// Turns the flat transcript_evidence_cards (state.cohort.transcript_evidence_cards,
// loaded live from Supabase by cohort-source.js — T2 cohort ∪ T3 public) into a
// per-team, per-week, per-claim-type index so PMF / relationship / say-did-shipped
// / timeline can enrich themselves at runtime, keyed by WHEN it happened.
//
// Pure + side-effect-free so it's unit-testable without the app or live data. Every
// view guards on emptiness: no evidence ⇒ the index is empty ⇒ views render exactly
// as before (the channel is a runtime overlay, never a committed-bundle dependency).

// claim_type → which view bucket it feeds.
const DID = new Set(["decision", "action_item"]);
const PMF = new Set(["product_signal", "market_signal"]);
const ASK = new Set(["ask"]);
const RISK = new Set(["risk"]);
const EDGE = new Set(["collaboration_edge"]);

function cardTeams(card) {
  const cj = card && card.content_json && typeof card.content_json === "object" ? card.content_json : {};
  const teams = Array.isArray(cj.teams) ? cj.teams : [];
  return teams.map((t) => String(t || "").trim()).filter(Boolean);
}
function cardWeek(card) {
  const cj = card && card.content_json ? card.content_json : {};
  return String(cj.week_start || cj.date || "").slice(0, 10) || "undated";
}
function unorderedPair(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// claim_type → the lane the timeline groups/colours it under. Mirrors the bucket
// sets above so the dossier timeline and the per-view enrichers agree on meaning.
export function claimLane(type) {
  if (DID.has(type)) return "did";
  if (PMF.has(type)) return "pmf";
  if (ASK.has(type)) return "ask";
  if (RISK.has(type)) return "risk";
  if (EDGE.has(type)) return "edge";
  return "other";
}

function emptyBucket() {
  return { did: [], shipped: [], pmf: [], asks: [], risks: [], all: [], weeks: new Map() };
}

// Build the index. Returns:
//   byTeam: Map<teamId, { did, pmf, asks, risks, all, weeks: Map<week,count> }>
//   edges:  [{ pairKey, a, b, week, card }]  (collaboration_edge claims spanning >=2 teams)
//   byWeek: Map<week, card[]>                (all claims, time-ordered key)
//   teams:  Set<teamId>                      (teams referenced by >=1 claim)
export function indexCohortEvidence(cards = []) {
  const byTeam = new Map();
  const byWeek = new Map();
  const edges = [];
  const teams = new Set();
  const ensure = (t) => { if (!byTeam.has(t)) byTeam.set(t, emptyBucket()); return byTeam.get(t); };

  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== "object") continue;
    const type = String(card.claim_type || "");
    const week = cardWeek(card);
    const teamsOf = cardTeams(card);

    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(card);

    for (const t of teamsOf) {
      teams.add(t);
      const b = ensure(t);
      b.all.push(card);
      if (DID.has(type)) b.did.push(card);
      if (PMF.has(type)) b.pmf.push(card);
      if (ASK.has(type)) b.asks.push(card);
      if (RISK.has(type)) b.risks.push(card);
      b.weeks.set(week, (b.weeks.get(week) || 0) + 1);
    }

    // Collaboration edges: a collaboration_edge claim spanning >=2 teams links them.
    if (EDGE.has(type) && teamsOf.length >= 2) {
      for (let i = 0; i < teamsOf.length; i += 1) {
        for (let j = i + 1; j < teamsOf.length; j += 1) {
          edges.push({ pairKey: unorderedPair(teamsOf[i], teamsOf[j]), a: teamsOf[i], b: teamsOf[j], week, card });
        }
      }
    }
  }
  return { byTeam, byWeek, edges, teams };
}

// A team's evidence slice (safe on a missing team).
export function teamEvidence(index, teamId) {
  return (index && index.byTeam && index.byTeam.get(teamId)) || emptyBucket();
}

// Most-recent N claim texts of a kind for a team — what a view actually renders.
export function recentClaims(bucket, kind, limit = 3) {
  const list = (bucket && bucket[kind]) || [];
  return list
    .slice()
    .sort((a, b) => String(cardWeek(b)).localeCompare(cardWeek(a)))
    .slice(0, limit)
    .map((card) => ({ text: String(card.claim_text || ""), week: cardWeek(card), title: String(card.title || ""), evidence_level: String(card.evidence_level || "") }));
}

// A team's evidence as an ascending-by-week TIMELINE — the longitudinal "events
// over time" the dossier renders. Each entry groups one week's claims, lane-tagged
// (did / pmf / ask / risk / edge) for colour. Collaboration edges count as the
// team's events too (they live in the team's `all` bucket). Undated claims have no
// place on the axis and are dropped. Safe on a missing team / empty index ⇒ [].
export function teamTimeline(index, teamId) {
  const bucket = teamEvidence(index, teamId);
  const byWeek = new Map();
  for (const card of bucket.all) {
    const week = cardWeek(card);
    if (week === "undated") continue;
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push({
      type: String(card.claim_type || ""),
      lane: claimLane(String(card.claim_type || "")),
      text: String(card.claim_text || ""),
      title: String(card.title || ""),
      evidence_level: String(card.evidence_level || ""),
    });
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, claims]) => ({ week, claims }));
}

// Distinct collaboration edges (deduped by team pair), newest week kept.
export function edgePairs(index) {
  const seen = new Map();
  for (const e of (index && index.edges) || []) {
    const prev = seen.get(e.pairKey);
    if (!prev || String(e.week).localeCompare(String(prev.week)) > 0) seen.set(e.pairKey, e);
  }
  return [...seen.values()];
}

// Cohort-wide week histogram for the timeline (sorted week → count).
export function weekHistogram(index) {
  const out = [];
  for (const [week, cards] of (index && index.byWeek ? index.byWeek : new Map())) out.push({ week, count: cards.length });
  return out.filter((w) => w.week !== "undated").sort((a, b) => a.week.localeCompare(b.week));
}

function confidenceLabel(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n)) return n >= 0.85 ? "high" : n >= 0.6 ? "medium" : "low";
  return "medium";
}

// Collaboration-edge evidence → dependency RECORDS the relationship map renders
// natively (cohort-relations.js normalizeDependencyRecord → constellationDependencyEdges).
// This is the "shape it into an existing contract" move: NO relationship-view code.
//   - deduped by team-pair, newest week kept;
//   - SKIPPED where a declared dependency already links the pair (no restating);
//   - provenance rides status="session_observed" + confidence + reason (the claim) +
//     evidence (session+week) + updated_at, so evidence edges stay distinguishable
//     from declared deps in the map's edge inspector.
export function evidenceDependencyRecords(cards = [], existingDeps = []) {
  const declaredPairs = new Set();
  for (const d of Array.isArray(existingDeps) ? existingDeps : []) {
    const a = String((d && d.source) || "").trim();
    const b = String((d && d.target) || "").trim();
    if (a && b) declaredPairs.add(unorderedPair(a, b));
  }
  const byPair = new Map();
  for (const e of indexCohortEvidence(cards).edges) {
    if (declaredPairs.has(e.pairKey)) continue;
    const prev = byPair.get(e.pairKey);
    if (!prev || String(e.week).localeCompare(String(prev.week)) > 0) byPair.set(e.pairKey, e);
  }
  return [...byPair.values()].map((e) => ({
    record_type: "dependency",
    record_id: `evidence-edge:${e.pairKey}`,
    source: e.a,
    target: e.b,
    relation: "shares_substrate",
    status: "session_observed",
    confidence: confidenceLabel(e.card && e.card.confidence),
    reason: String((e.card && e.card.claim_text) || "").slice(0, 200),
    evidence: [`reviewed session · ${e.week}`],
    updated_at: e.week,
  }));
}

// GitHub collaboration-contribution cards → dependency RECORDS the ecosystem /
// relationship map renders natively (same contract as evidenceDependencyRecords).
// The engine emits one card per (contributing team → repo); the map is TEAM↔TEAM, so
// a person-owned target (e.g. dmarzzz/voxterm) is expressed as a CO-CONTRIBUTION
// CLIQUE: teams that contributed to the SAME repo are linked to each other. Deduped
// by pair, skipped where a declared dep already links the pair; provenance rides
// status="insight_derived" + the repo so these stay distinct from declared/session edges.
export function collaborationContributionDependencyRecords(cards = [], existingDeps = []) {
  const declaredPairs = new Set();
  for (const d of Array.isArray(existingDeps) ? existingDeps : []) {
    const a = String((d && d.source) || "").trim();
    const b = String((d && d.target) || "").trim();
    if (a && b) declaredPairs.add(unorderedPair(a, b));
  }
  // repo -> Map(contributorTeam -> card) ; first card per team kept for provenance.
  const byRepo = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.kind !== "collaboration_contribution") continue;
    const subj = Array.isArray(card.subject_ids) ? card.subject_ids : [];
    const contributor = String(subj[0] || "").trim();
    if (!contributor || subj.length < 2) continue; // need a contributor + a target
    const cj = card.content_json && typeof card.content_json === "object" ? card.content_json : {};
    const repo = String(cj.repo || cj.target_repo || subj[1] || "").trim();
    if (!repo) continue;
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    const teams = byRepo.get(repo);
    if (!teams.has(contributor)) teams.set(contributor, card);
  }
  const out = [];
  const emitted = new Set();
  for (const [repo, teams] of byRepo) {
    const ids = [...teams.keys()];
    if (ids.length < 2) continue; // a co-contribution clique needs ≥2 teams
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pair = unorderedPair(ids[i], ids[j]);
        if (declaredPairs.has(pair) || emitted.has(pair)) continue;
        emitted.add(pair);
        const card = teams.get(ids[i]) || teams.get(ids[j]);
        out.push({
          record_type: "dependency",
          record_id: `collab-edge:${pair}`,
          source: ids[i],
          target: ids[j],
          relation: "contributed_to",
          status: "insight_derived",
          confidence: confidenceLabel(card && card.confidence),
          reason: `both contributed to ${repo}`,
          evidence: [`github-observed · ${repo}`],
          updated_at: String((card && (card.generated_at || card.created_at)) || "").slice(0, 10),
        });
      }
    }
  }
  return out;
}

export const __claimBuckets = { DID, PMF, ASK, RISK, EDGE };

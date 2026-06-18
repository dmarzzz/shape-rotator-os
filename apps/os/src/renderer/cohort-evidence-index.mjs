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

// collaboration_contribution insight cards (committed bundle) → dependency RECORDS
// the relationship map draws natively. The map is team↔team only, so we emit
// team↔team edges:
//   - target is a TEAM   → contributorTeam ↔ targetTeam
//   - target is a PERSON / shared tool (e.g. voxterm owned by a coordinator) →
//     co-contribution clique: any two contributor teams that touched the SAME repo
//     are linked (that's the real "these teams collaborate" signal).
// Deduped vs declared/evidence deps and among ourselves; relation "contributed_to",
// status "insight_derived"; provenance (repo + confidence + claim) rides along so
// the edge inspector can distinguish it from a declared dependency.
export function collaborationContributionDependencyRecords(insightCards = [], existingDeps = []) {
  const blocked = new Set();
  for (const d of Array.isArray(existingDeps) ? existingDeps : []) {
    const a = String((d && d.source) || "").trim();
    const b = String((d && d.target) || "").trim();
    if (a && b) blocked.add(unorderedPair(a, b));
  }
  const cards = (Array.isArray(insightCards) ? insightCards : []).filter((c) => c && c.kind === "collaboration_contribution");
  const out = new Map();
  const addEdge = (a, b, card, repo) => {
    if (!a || !b || a === b) return;
    const key = unorderedPair(a, b);
    if (blocked.has(key) || out.has(key)) return;
    out.set(key, {
      record_type: "dependency",
      record_id: `contrib-edge:${key}`,
      source: a,
      target: b,
      relation: "contributed_to",
      status: "insight_derived",
      confidence: String((card && card.confidence) || "medium").toLowerCase(),
      reason: String((card && (card.claim_text || card.title)) || `co-contribution via ${repo || "a shared repo"}`).slice(0, 200),
      evidence: [`github contribution · ${repo || ""}`.trim()],
      updated_at: String((card && card.content_json && card.content_json.week_start) || ""),
    });
  };
  const byRepoTeams = new Map();
  for (const card of cards) {
    const cj = card.content_json || {};
    const cTeam = (Array.isArray(cj.contributor_team_ids) ? cj.contributor_team_ids : [])
      .map((t) => String(t || "").trim()).filter(Boolean)[0] || "";
    const target = String(cj.target || "");
    const repo = String(cj.repo || "");
    if (target.startsWith("team:")) {
      addEdge(cTeam, target.slice("team:".length), card, repo);
    } else if (cTeam && repo) {
      if (!byRepoTeams.has(repo)) byRepoTeams.set(repo, new Map());
      byRepoTeams.get(repo).set(cTeam, card);
    }
  }
  for (const [repo, teamMap] of byRepoTeams) {
    const teams = [...teamMap.keys()];
    for (let i = 0; i < teams.length; i += 1) {
      for (let j = i + 1; j < teams.length; j += 1) {
        addEdge(teams[i], teams[j], teamMap.get(teams[i]), repo);
      }
    }
  }
  return [...out.values()];
}

export const __claimBuckets = { DID, PMF, ASK, RISK, EDGE };

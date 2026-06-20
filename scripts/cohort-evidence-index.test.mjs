import test from "node:test";
import assert from "node:assert/strict";
import {
  indexCohortEvidence, teamEvidence, recentClaims, edgePairs, weekHistogram,
  evidenceDependencyRecords, teamTimeline, claimLane,
  collaborationContributionDependencyRecords,
} from "../apps/os/src/renderer/cohort-evidence-index.mjs";

const card = (claim_type, teams, week, claim_text = "x", extra = {}) => ({
  id: `${claim_type}-${teams.join("-")}-${week}`,
  claim_type, claim_text, title: "Session", evidence_level: "observed",
  content_json: { teams, week_start: week, ...extra },
});

const cards = [
  card("decision", ["bitrouter"], "2026-05-25", "repositioned around reliability"),
  card("action_item", ["bitrouter"], "2026-06-08", "ship x402-kit"),
  card("product_signal", ["bitrouter"], "2026-06-08", "coding-agent workloads"),
  card("ask", ["elizaos"], "2026-06-08", "needs intros"),
  card("risk", ["elizaos"], "2026-06-08", "legal exposure"),
  card("collaboration_edge", ["bitrouter", "teleport-router"], "2026-06-08", "shared router"),
  card("collaboration_edge", ["bitrouter", "teleport-router"], "2026-05-25", "earlier overlap"),
  card("market_signal", ["conclave"], "2026-06-01", "enterprise wedge"),
  card("claim", [], "2026-02-23", "external lecture insight (no team)"),
];

test("indexCohortEvidence buckets claims by team + type, with week counts", () => {
  const idx = indexCohortEvidence(cards);
  const bit = teamEvidence(idx, "bitrouter");
  assert.equal(bit.did.length, 2, "decision + action_item are the observed 'did'");
  assert.equal(bit.pmf.length, 1, "product_signal feeds PMF");
  assert.equal(bit.all.length, 5, "all bitrouter claims: 2 did + 1 pmf + 2 collaboration edges");
  assert.equal(bit.weeks.get("2026-06-08"), 3, "action_item + product_signal + one edge");
  assert.equal(bit.weeks.get("2026-05-25"), 2, "decision + the earlier edge");
  const eliza = teamEvidence(idx, "elizaos");
  assert.equal(eliza.asks.length, 1);
  assert.equal(eliza.risks.length, 1);
});

test("collaboration_edge claims become deduped team-pair edges (newest week kept)", () => {
  const idx = indexCohortEvidence(cards);
  const pairs = edgePairs(idx);
  assert.equal(pairs.length, 1, "the two bitrouter/teleport-router edge claims collapse to one pair");
  assert.equal(pairs[0].week, "2026-06-08", "newest week wins");
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ["bitrouter", "teleport-router"]);
});

test("weekHistogram is the time axis (sorted, drops undated)", () => {
  const idx = indexCohortEvidence(cards);
  const hist = weekHistogram(idx);
  assert.deepEqual(hist.map((h) => h.week), ["2026-02-23", "2026-05-25", "2026-06-01", "2026-06-08"]);
  assert.equal(hist.find((h) => h.week === "2026-06-08").count, 5);
});

test("recentClaims returns newest-first text/week for a view to render", () => {
  const idx = indexCohortEvidence(cards);
  const did = recentClaims(teamEvidence(idx, "bitrouter"), "did", 2);
  assert.equal(did.length, 2);
  assert.equal(did[0].week, "2026-06-08", "most recent did first");
  assert.match(did[0].text, /x402-kit/);
});

test("evidenceDependencyRecords shape collaboration edges into renderable dependency records", () => {
  const recs = evidenceDependencyRecords(cards, []);
  assert.equal(recs.length, 1, "the two bitrouter/teleport edge claims collapse to one record");
  const r = recs[0];
  assert.equal(r.record_type, "dependency", "must be a dependency record the relationship map renders");
  assert.equal(r.relation, "shares_substrate");
  assert.equal(r.status, "session_observed", "provenance: distinguishable from a declared dep");
  assert.deepEqual([r.source, r.target].sort(), ["bitrouter", "teleport-router"]);
  assert.equal(r.updated_at, "2026-06-08", "newest week");
  assert.match(r.reason, /shared router/, "the claim text rides as the edge reason");
  assert.match(r.evidence[0], /reviewed session/);
});

test("evidenceDependencyRecords does NOT restate an already-declared dependency", () => {
  const declared = [{ record_type: "dependency", source: "bitrouter", target: "teleport-router", relation: "depends_on" }];
  assert.deepEqual(evidenceDependencyRecords(cards, declared), [], "declared pair is skipped — no duplicate edge");
});

test("claimLane maps claim_type to the timeline's lane (color/group key)", () => {
  assert.equal(claimLane("decision"), "did");
  assert.equal(claimLane("action_item"), "did");
  assert.equal(claimLane("product_signal"), "pmf");
  assert.equal(claimLane("market_signal"), "pmf");
  assert.equal(claimLane("ask"), "ask");
  assert.equal(claimLane("risk"), "risk");
  assert.equal(claimLane("collaboration_edge"), "edge");
  assert.equal(claimLane("something_else"), "other");
});

test("teamTimeline groups a team's claims ascending by week, lane-tagged", () => {
  const idx = indexCohortEvidence(cards);
  const tl = teamTimeline(idx, "bitrouter");
  assert.deepEqual(tl.map((w) => w.week), ["2026-05-25", "2026-06-08"], "ascending by week");
  const wk1 = tl[0]; // 2026-05-25: decision + the earlier collaboration edge
  assert.equal(wk1.claims.length, 2);
  assert.deepEqual(wk1.claims.map((c) => c.lane).sort(), ["did", "edge"]);
  const wk2 = tl[1]; // 2026-06-08: action_item (did) + product_signal (pmf) + edge
  assert.equal(wk2.claims.length, 3);
  assert.deepEqual(wk2.claims.map((c) => c.lane).sort(), ["did", "edge", "pmf"]);
  const did = wk2.claims.find((c) => c.lane === "did");
  assert.match(did.text, /x402-kit/, "claim text rides along for rendering");
  assert.equal(did.evidence_level, "observed");
});

test("teamTimeline includes collaboration edges as the team's events too", () => {
  const idx = indexCohortEvidence(cards);
  const tl = teamTimeline(idx, "teleport-router"); // only ever appears via edges
  assert.equal(tl.length, 2, "both edge weeks show on the partner's timeline");
  assert.ok(tl.every((w) => w.claims.every((c) => c.lane === "edge")));
});

test("teamTimeline drops undated claims and is safe on a missing team / empty index", () => {
  const idx = indexCohortEvidence([
    card("decision", ["solo"], "2026-06-01", "shipped v1"),
    card("ask", ["solo"], "", "undated ask"), // no week_start ⇒ undated ⇒ dropped
  ]);
  const tl = teamTimeline(idx, "solo");
  assert.deepEqual(tl.map((w) => w.week), ["2026-06-01"], "undated claim excluded from the axis");
  assert.deepEqual(teamTimeline(idx, "ghost"), [], "missing team ⇒ empty timeline");
  assert.deepEqual(teamTimeline(indexCohortEvidence([]), "anyone"), [], "empty index ⇒ empty timeline");
});

test("empty / malformed evidence yields an empty index (views no-op, never throw)", () => {
  for (const input of [[], null, undefined, [null, "garbage", {}], [{ claim_type: "decision" }]]) {
    const idx = indexCohortEvidence(input);
    assert.equal(idx.teams.size, 0);
    assert.deepEqual(edgePairs(idx), []);
    assert.deepEqual(weekHistogram(idx), []);
    assert.deepEqual(teamEvidence(idx, "anyone").did, []);
  }
});

// GitHub collaboration cards → co-contribution clique edges.
const collabCard = (contributor, target, repo) => ({
  kind: "collaboration_contribution",
  subject_ids: [contributor, target],
  content_json: { repo },
  confidence: "medium",
  generated_at: "2026-06-18",
});

test("collaboration cards become a co-contribution clique per repo (team↔team)", () => {
  const cards = [
    collabCard("dealproof", "dmarz", "dmarzzz/voxterm"),
    collabCard("signalstack", "dmarz", "dmarzzz/voxterm"),
    collabCard("contexto", "dmarz", "dmarzzz/voxterm-transcript-sink"), // alone on its repo → no edge
    { kind: "collaboration_contribution", subject_ids: ["dmarz"], content_json: { repo: "dmarzzz/voxterm" } }, // no contributor pair → skip
  ];
  const recs = collaborationContributionDependencyRecords(cards, []);
  assert.equal(recs.length, 1, "voxterm's two contributor teams form one edge; the solo repo none");
  const e = recs[0];
  assert.deepEqual([e.source, e.target].sort(), ["dealproof", "signalstack"]);
  assert.equal(e.relation, "contributed_to");
  assert.equal(e.status, "insight_derived");
  assert.match(e.reason, /dmarzzz\/voxterm/);
  assert.equal(e.record_id, "collab-edge:dealproof|signalstack");
});

test("collaboration edges skip a pair already declared + ignore non-collab cards", () => {
  const cards = [
    collabCard("dealproof", "dmarz", "dmarzzz/voxterm"),
    collabCard("signalstack", "dmarz", "dmarzzz/voxterm"),
    { kind: "say_did_shipped", subject_ids: ["dealproof", "signalstack"], content_json: { repo: "x" } },
  ];
  const declared = [{ source: "dealproof", target: "signalstack", record_id: "dep:1" }];
  assert.deepEqual(collaborationContributionDependencyRecords(cards, declared), [], "declared pair not restated");
  assert.deepEqual(collaborationContributionDependencyRecords([], []), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { attributeInsightCards, teamTimeline, indexCohortEvidence } from "./cohort-evidence-index.mjs";

const TEAMS = [
  { record_id: "conclave", name: "Conclave", skill_areas: ["dstack", "phala"], focus: "transcript distillation", domain: "tee" },
  { record_id: "teesql", name: "TeeSQL", skill_areas: ["attestation", "postgres"], focus: "verifiable postgres in a tee", domain: "tee" },
];

const card = (text, extra = {}) => ({
  id: "c1", claim_type: "insight", claim_text: text, content_json: { date: "2026-06-20" }, ...extra,
});

test("a name match attributes to named teams only — token matches can't ride along", () => {
  // Mentions Conclave BY NAME while sharing generic domain tokens with TeeSQL:
  // the second slot must not leak to TeeSQL ("gather of mentions" bug).
  const [out] = attributeInsightCards(
    [card("The Conclave pivot to transcript distillation ran on attestation-heavy postgres infrastructure")],
    TEAMS,
  );
  assert.deepEqual(out.content_json.teams, ["conclave"]);
  assert.equal(out.content_json.teams_basis, "inferred");
});

test("token-only attribution still works when no team is named", () => {
  const [out] = attributeInsightCards(
    [card("verifiable postgres with remote attestation for query proofs")],
    TEAMS,
  );
  assert.deepEqual(out.content_json.teams, ["teesql"]);
});

test("two named teams stay a genuinely cross-team card", () => {
  const [out] = attributeInsightCards(
    [card("Conclave and TeeSQL compared notes on their pipelines")],
    TEAMS,
  );
  assert.deepEqual(new Set(out.content_json.teams), new Set(["conclave", "teesql"]));
});

test("declared teams pass through untouched; timeline carries the basis", () => {
  const declared = card("about something", { content_json: { date: "2026-06-20", teams: ["teesql"] } });
  const [out] = attributeInsightCards([declared], TEAMS);
  assert.deepEqual(out.content_json.teams, ["teesql"]);
  assert.equal(out.content_json.teams_basis, undefined);
  const idx = indexCohortEvidence(attributeInsightCards(
    [declared, card("The Conclave pivot to transcript distillation")], TEAMS));
  const declaredTl = teamTimeline(idx, "teesql");
  const inferredTl = teamTimeline(idx, "conclave");
  assert.equal(declaredTl[0].claims[0].basis, "declared");
  assert.equal(inferredTl[0].claims[0].basis, "inferred");
});

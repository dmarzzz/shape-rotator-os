import test from "node:test";
import assert from "node:assert/strict";
import { attributeInsightCards, buildTeamMatchers, indexCohortEvidence, teamEvidence } from "../apps/os/src/renderer/cohort-evidence-index.mjs";

const teams = [
  { record_id: "teesql", name: "TeeSQL", skill_areas: ["tee", "postgres", "dstack"], focus: "TEE Postgres on dstack" },
  { record_id: "tinycloud", name: "TinyCloud", skill_areas: ["tee", "hosting"], focus: "TEE hosting" },
  { record_id: "abra", name: "Abra", skill_areas: ["tee", "formal-verification", "attestation"], focus: "formal verification" },
];

const insight = (id, claim_text, extra = {}) => ({ id, claim_type: "insight", claim_text, content_json: { week_start: "2026-06-14", ...extra } });

test("buildTeamMatchers computes inverse-document-frequency: rare tokens weigh more", () => {
  const { idf } = buildTeamMatchers(teams);
  assert.equal(idf.get("postgres"), 1, "postgres is in one team");
  assert.equal(idf.get("attestation"), 1, "attestation is in one team");
  assert.ok(Math.abs(idf.get("tee") - 1 / 3) < 1e-9, "tee is shared by all three teams");
});

test("a card naming a team is attributed to it (inferred), declared cards untouched", () => {
  const cards = [
    insight("c1", "TeeSQL onboarded three cohort teams to its managed database this week."),
    { id: "c2", claim_type: "decision", claim_text: "shipped", content_json: { teams: ["elocute"], week_start: "2026-06-14" } },
  ];
  const out = attributeInsightCards(cards, teams);
  assert.deepEqual(out[0].content_json.teams, ["teesql"]);
  assert.equal(out[0].content_json.teams_basis, "inferred");
  // declared card passes through unchanged
  assert.deepEqual(out[1].content_json.teams, ["elocute"]);
  assert.equal(out[1].content_json.teams_basis, undefined);
});

test("a card with distinctive skill/focus tokens (no name) is attributed", () => {
  const out = attributeInsightCards(
    [insight("c3", "The session dug into formal verification and attestation guarantees for the registry.")],
    teams,
  );
  assert.deepEqual(out[0].content_json.teams, ["abra"]);
  assert.equal(out[0].content_json.teams_basis, "inferred");
});

test("a card with only a widely-shared token is NOT attributed (no noise)", () => {
  const card = insight("c4", "This session covered TEE tradeoffs broadly across the cohort.");
  const out = attributeInsightCards([card], teams);
  // Unattributed -> card returned unchanged: no teams key, no inferred basis.
  assert.equal(out[0], card, "tee alone (shared by 3 teams) is too weak — card passes through untouched");
  assert.equal(out[0].content_json.teams, undefined);
  assert.equal(out[0].content_json.teams_basis, undefined);
});

test("attribution is bounded and ranks named over token-only matches", () => {
  const out = attributeInsightCards(
    [insight("c5", "TeeSQL compared notes on postgres dstack tee with another infra team.")],
    teams,
    { maxTeams: 2 },
  );
  assert.ok(out[0].content_json.teams.length <= 2);
  assert.equal(out[0].content_json.teams[0], "teesql", "the named team ranks first");
});

test("attributed cards then flow into the per-team index (the whole point)", () => {
  const attributed = attributeInsightCards(
    [
      insight("c1", "TeeSQL shipped a managed TEE Postgres onboarding flow."),
      insight("c3", "Formal verification and attestation proofs progressed."),
    ],
    teams,
  );
  const idx = indexCohortEvidence(attributed);
  assert.equal(teamEvidence(idx, "teesql").all.length, 1, "teesql now has a session insight");
  assert.equal(teamEvidence(idx, "abra").all.length, 1, "abra now has a session insight");
  assert.ok(teamEvidence(idx, "teesql").weeks.get("2026-06-14") >= 1);
});

test("empty / missing inputs never throw", () => {
  assert.deepEqual(attributeInsightCards([], teams), []);
  assert.deepEqual(attributeInsightCards(null, teams), []);
  assert.equal(attributeInsightCards([insight("x", "hello")], []).length, 1, "no teams -> cards pass through");
});

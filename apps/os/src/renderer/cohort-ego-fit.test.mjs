import { test } from "node:test";
import assert from "node:assert/strict";
import {
  egoLabelWords,
  egoSpacePool,
  egoAffinity,
  egoSpaces,
  largestRemainderPct,
  egoSpaceFits,
} from "./cohort-ego-fit.mjs";

function fixture() {
  const teams = [
    { record_id: "focal", skill_areas: ["TEE", "Attestation", "rust"] },
    { record_id: "a1", skill_areas: ["tee", "attestation", "sgx"] },
    { record_id: "a2", skill_areas: ["attestation", "enclave"] },
    { record_id: "b1", skill_areas: ["design", "ux"] },
    { record_id: "b2", skill_areas: ["frontend", "ux"] },
  ];
  const teamById = new Map(teams.map((t) => [t.record_id, t]));
  const clusters = [
    { record_id: "attestation", label: "Attestation / TEE", teams: ["focal", "a1", "a2"] },
    { record_id: "app-ux", label: "App · UX", teams: ["focal", "b1", "b2"] },
  ];
  return { teamById, clusters };
}

test("egoLabelWords keeps only specific (>3 char) words, lowercased", () => {
  assert.deepEqual(egoLabelWords("Attestation / TEE"), ["attestation"]); // "tee" is 3 chars → dropped
  assert.deepEqual(egoLabelWords("App · UX"), []); // both too short
  assert.deepEqual(egoLabelWords("agent runtime"), ["agent", "runtime"]);
});

test("egoSpacePool unions other members' skills + label words, excludes self", () => {
  const { teamById, clusters } = fixture();
  const spaceA = { allTeams: clusters[0].teams, label: clusters[0].label };
  const pool = egoSpacePool(spaceA, teamById, "focal");
  // a1 + a2 skills + "attestation" label word; focal's own skills excluded.
  assert.ok(pool.has("tee"));
  assert.ok(pool.has("attestation"));
  assert.ok(pool.has("sgx"));
  assert.ok(pool.has("enclave"));
  assert.ok(!pool.has("rust")); // rust is only the focal's skill — excluded
});

test("egoAffinity scores share of focal skills in the space pool, with trace", () => {
  const { teamById, clusters } = fixture();
  const spaceA = { allTeams: clusters[0].teams, label: clusters[0].label };
  const r = egoAffinity("focal", spaceA, teamById);
  // focal skills: tee, attestation, rust → matched tee + attestation (2 of 3)
  assert.equal(r.hits, 2);
  assert.equal(r.mineLen, 3);
  assert.deepEqual(r.matched.sort(), ["attestation", "tee"]);
  assert.ok(Math.abs(r.aff - (0.3 + 0.7 * (2 / 3))) < 1e-9);
  assert.equal(r.fallback, false);
});

test("egoAffinity falls back to a neutral score when the focal has no skills", () => {
  const teamById = new Map([["x", { record_id: "x", skill_areas: [] }]]);
  const r = egoAffinity("x", { allTeams: ["x", "y"], label: "Some Space" }, teamById);
  assert.equal(r.aff, 0.65);
  assert.equal(r.fallback, true);
  assert.equal(r.reason, "no-skills");
});

test("egoSpaces returns the clusters a team is in, in declaration order", () => {
  const { teamById, clusters } = fixture();
  const spaces = egoSpaces({ record_id: "focal" }, { teamById, clusters });
  assert.deepEqual(spaces.map((s) => s.id), ["attestation", "app-ux"]);
  assert.deepEqual(spaces[0].members, ["a1", "a2"]); // self excluded from members
});

test("largestRemainderPct sums to exactly 100 and is deterministic", () => {
  assert.equal(largestRemainderPct([1, 1, 1]).reduce((s, p) => s + p, 0), 100);
  assert.deepEqual(largestRemainderPct([1, 1]), [50, 50]);
  assert.deepEqual(largestRemainderPct([3, 1]), [75, 25]);
  // ties resolve by index order, not randomness → stable across renders
  assert.deepEqual(largestRemainderPct([1, 1, 1]), [34, 33, 33]);
});

test("egoSpaceFits: stronger fit gets the higher ~%, and percents sum to 100", () => {
  const { teamById, clusters } = fixture();
  const { N, spaces } = egoSpaceFits({ record_id: "focal" }, { teamById, clusters });
  assert.equal(N, 2);
  const [A, B] = spaces;
  assert.equal(A.id, "attestation");
  assert.ok(A.pct > B.pct, "the well-fit space should carry more of the focus");
  assert.equal(A.pct + B.pct, 100);
  assert.ok(A.focalAff > B.focalAff);
  assert.deepEqual(A.matched.sort(), ["attestation", "tee"]);
  assert.equal(B.hits, 0); // none of focal's skills run through the UX space
});

test("egoSpaceFits: single space is 100%", () => {
  const teamById = new Map([
    ["solo", { record_id: "solo", skill_areas: ["x"] }],
    ["m", { record_id: "m", skill_areas: ["y"] }],
  ]);
  const clusters = [{ record_id: "only", label: "Only Space", teams: ["solo", "m"] }];
  const { N, spaces } = egoSpaceFits({ record_id: "solo" }, { teamById, clusters });
  assert.equal(N, 1);
  assert.equal(spaces[0].pct, 100);
  assert.equal(spaces[0].focalAff, 1);
});

test("egoSpaceFits: no-skill focal splits evenly (unscored fallback)", () => {
  const teamById = new Map([
    ["f", { record_id: "f", skill_areas: [] }],
    ["a", { record_id: "a", skill_areas: ["p"] }],
    ["b", { record_id: "b", skill_areas: ["q"] }],
  ]);
  const clusters = [
    { record_id: "s1", label: "Space One", teams: ["f", "a"] },
    { record_id: "s2", label: "Space Two", teams: ["f", "b"] },
  ];
  const { spaces } = egoSpaceFits({ record_id: "f" }, { teamById, clusters });
  assert.equal(spaces[0].pct, 50);
  assert.equal(spaces[1].pct, 50);
  assert.ok(spaces.every((s) => s.fallback));
});

test("egoSpaceFits: team in no cluster yields N=0", () => {
  const { teamById, clusters } = fixture();
  const { N, spaces } = egoSpaceFits({ record_id: "nope" }, { teamById, clusters });
  assert.equal(N, 0);
  assert.deepEqual(spaces, []);
});

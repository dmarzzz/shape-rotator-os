"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  TIERS,
  TIER_ORDER,
  isTier,
  SURFACE,
  SURFACE_BY_TIER,
  mergeSurface,
} = require("./lib/tiers.cjs");

const POLICY = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "..", "cohort-data", "policies", "transcript-routing-policy.json"),
    "utf8",
  ),
);

test("TIERS is sourced from the routing policy (single source of truth)", () => {
  assert.deepEqual(Object.keys(TIERS).sort(), ["T0", "T1", "T2", "T3"]);
  for (const id of TIER_ORDER) {
    assert.equal(TIERS[id].id, id, `${id} carries its own id`);
    assert.equal(TIERS[id].label, POLICY.tiers[id].label, `${id} label matches policy`);
    assert.equal(TIERS[id].audience, POLICY.tiers[id].audience, `${id} audience matches policy`);
    assert.equal(TIERS[id].raw_allowed, POLICY.tiers[id].raw_allowed, `${id} raw_allowed matches policy`);
  }
});

test("TIER_ORDER runs most-private -> most-public", () => {
  assert.deepEqual([...TIER_ORDER], ["T0", "T1", "T2", "T3"]);
});

test("isTier accepts only the four tier ids", () => {
  for (const id of TIER_ORDER) assert.equal(isTier(id), true);
  for (const bad of ["", "t2", "T4", "cohort", null, undefined, 2]) {
    assert.equal(isTier(bad), false);
  }
});

test("SURFACE constants equal the literals they replace", () => {
  assert.equal(SURFACE.COHORT, "cohort");
  assert.equal(SURFACE.PUBLIC_CANDIDATE, "public_candidate");
  assert.equal(SURFACE.PUBLIC, "public");
});

test("SURFACE_BY_TIER maps T2->cohort, T3->public", () => {
  assert.equal(SURFACE_BY_TIER.T2, SURFACE.COHORT);
  assert.equal(SURFACE_BY_TIER.T3, SURFACE.PUBLIC);
});

test("mergeSurface returns the more restrictive ceiling (cohort > public_candidate > unset)", () => {
  assert.equal(mergeSurface("cohort", "public_candidate"), "cohort");
  assert.equal(mergeSurface("public", "cohort"), "cohort");
  assert.equal(mergeSurface("cohort", "cohort"), "cohort");
  assert.equal(mergeSurface("public_candidate", "public"), "public_candidate");
  assert.equal(mergeSurface("public", "public_candidate"), "public_candidate");
  assert.equal(mergeSurface("public", "public"), "public");
  assert.equal(mergeSurface("public", undefined), "public");
  assert.equal(mergeSurface(undefined, "public"), "public");
  assert.equal(mergeSurface(undefined, undefined), "cohort");
});

test("TIERS entries are frozen (cannot be mutated at runtime)", () => {
  assert.throws(() => {
    "use strict";
    TIERS.T2.label = "hacked";
  });
});

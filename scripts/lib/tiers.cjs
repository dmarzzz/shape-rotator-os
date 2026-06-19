"use strict";

// Single source of truth for the T0–T3 ACCESS tiers (who may see the content).
//
// The tier definitions are sourced from the routing policy
// (cohort-data/policies/transcript-routing-policy.json -> `tiers`) so they live
// in exactly one place. Before this module, the same facts were re-expressed as
// hardcoded `["T0","T1","T2","T3"]` arrays and inline `=== "T2"` string checks
// scattered across the build/Node layer.
//
// Cross-vocabulary mapping — these name the SAME access tier in different layers
// (see docs/PRIVACY_TIERS.html and docs/INFORMATION_RULES.md). This module does
// NOT rename any database column; it only centralizes + documents the in-code
// vocabulary. The DB-persisted `surface_tier` values are intentionally untouched.
//
//   T0  =  room    raw, in-vault only (no published-surface equivalent)
//   T1  =  core    coordinator-only (cohort_insight_cards/articles call it 'operator')
//   T2  =  cohort  gated cohort surface        ->  max_surface 'cohort'
//   T3  =  public  open public site            ->  max_surface 'public'

const fs = require("node:fs");
const path = require("node:path");

const POLICY_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "cohort-data",
  "policies",
  "transcript-routing-policy.json",
);

// Baked fallback mirrors the policy JSON so this module still works on a partial
// checkout where the policy file is absent. The policy file remains canonical.
const FALLBACK_TIERS = {
  T0: { label: "room", audience: "people who were there", raw_allowed: true },
  T1: { label: "core", audience: "core team and coordinators", raw_allowed: "request_and_approval" },
  T2: { label: "cohort", audience: "gated cohort site", raw_allowed: false },
  T3: { label: "public", audience: "open public site", raw_allowed: false },
};

function loadTiersFromPolicy() {
  try {
    const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
    if (policy && policy.tiers && typeof policy.tiers === "object") return policy.tiers;
  } catch {
    // fall through to the baked fallback below
  }
  return null;
}

const rawTiers = loadTiersFromPolicy() || FALLBACK_TIERS;

// Each entry carries its own `id` so callers reference TIERS.T2.id rather than a
// bare "T2" literal — the only place the tier strings are written is here.
const TIERS = Object.freeze(
  Object.fromEntries(
    Object.entries(rawTiers).map(([id, value]) => [id, Object.freeze({ id, ...value })]),
  ),
);

// Ordered most-private -> most-public.
const TIER_ORDER = Object.freeze(["T0", "T1", "T2", "T3"]);

function isTier(value) {
  return typeof value === "string" && TIER_ORDER.includes(value);
}

// max_surface vocabulary (the "how far could this travel" ceiling on a piece of
// evidence). Distinct from the access tier, but mapped to it below.
const SURFACE = Object.freeze({
  COHORT: "cohort",
  PUBLIC_CANDIDATE: "public_candidate",
  PUBLIC: "public",
});

// Which max_surface each access tier maps to (T2 -> cohort, T3 -> public).
const SURFACE_BY_TIER = Object.freeze({
  T2: SURFACE.COHORT,
  T3: SURFACE.PUBLIC,
});

// Merge two max_surface ceilings, returning the MORE RESTRICTIVE.
// Precedence: cohort > public_candidate > (unset). Behavior is identical to the
// helper this replaces in transcript-evidence.cjs.
function mergeSurface(left, right) {
  if (left === SURFACE.COHORT || right === SURFACE.COHORT) return SURFACE.COHORT;
  if (left === SURFACE.PUBLIC_CANDIDATE || right === SURFACE.PUBLIC_CANDIDATE) {
    return SURFACE.PUBLIC_CANDIDATE;
  }
  return left || right || SURFACE.COHORT;
}

module.exports = {
  TIERS,
  TIER_ORDER,
  isTier,
  SURFACE,
  SURFACE_BY_TIER,
  mergeSurface,
};

// Unit tests for the build-baked cohort-key resolution (resolveDefaultCohortKey).
// The key gates the T2 evidence read; getting precedence + emptiness right is the
// whole security-relevant contract, so it is exercised in isolation here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultCohortKey } from "./supabase-evidence.mjs";

test("cohort key: the build-bridge value wins over env and is trimmed", () => {
  assert.equal(
    resolveDefaultCohortKey({ bridge: "  jwt-from-build  ", env: "jwt-from-env" }),
    "jwt-from-build",
  );
});

test("cohort key: falls back to env when the bridge is empty", () => {
  assert.equal(resolveDefaultCohortKey({ bridge: "", env: "  jwt-from-env " }), "jwt-from-env");
});

test("cohort key: empty when neither is set (anon T3 fallback)", () => {
  assert.equal(resolveDefaultCohortKey({ bridge: "", env: "" }), "");
});

test("cohort key: live-global probe resolves to a string without throwing", () => {
  // No window.api and (normally) no SRFG_COHORT_KEY in the node test context, so
  // the no-arg probe path must degrade to "" rather than throw on a missing
  // globalThis.api — the renderer relies on this guard at module-eval.
  const v = resolveDefaultCohortKey();
  assert.equal(typeof v, "string");
});

test("cohort key: a non-string bridge value is ignored, not coerced", () => {
  // globalThis.api.cohortKey is typed as a string by the preload; defend the
  // resolver against anything else slipping through (it should fall to env).
  assert.equal(resolveDefaultCohortKey({ bridge: undefined, env: "env-key" }), "env-key");
});

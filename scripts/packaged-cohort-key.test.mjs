import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintCohortJwt } from "./lib/cohort-key.mjs";
import {
  DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH,
  formatPackagedCohortKeyInspection,
  inspectPackagedCohortKey,
  projectRefFromSupabaseUrl,
} from "./lib/packaged-cohort-key.mjs";

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-cohort-key-"));
  fs.mkdirSync(path.join(root, path.dirname(DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH)), { recursive: true });
  return root;
}

function writeKey(root, cohortKey) {
  fs.writeFileSync(
    path.join(root, DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH),
    JSON.stringify({ cohortKey }, null, 2),
  );
}

test("inspectPackagedCohortKey reports the empty fallback file as not ready", () => {
  const root = fixtureRoot();
  writeKey(root, "");
  const result = inspectPackagedCohortKey({ root });
  assert.equal(result.status, "empty");
  assert.equal(result.ready, false);
  assert.equal(result.key_present, false);
  assert.match(result.errors.join("\n"), /fall back to public T3/);
});

test("inspectPackagedCohortKey accepts a current role=cohort_app key for the expected project", () => {
  const root = fixtureRoot();
  const cohortKey = mintCohortJwt({
    secret: "test-secret",
    ref: "txjntzwksiluvqcpccpc",
    role: "cohort_app",
    iat: 1000,
    expSeconds: 365 * 24 * 60 * 60,
  });
  writeKey(root, cohortKey);
  const result = inspectPackagedCohortKey({
    root,
    expectedRef: "txjntzwksiluvqcpccpc",
    now: new Date(1100 * 1000),
  });
  assert.equal(result.ready, true);
  assert.equal(result.status, "ready");
  assert.equal(result.role, "cohort_app");
  assert.equal(result.ref, "txjntzwksiluvqcpccpc");
  assert.ok(result.days_until_expiry > 300);
});

test("inspectPackagedCohortKey fails safely on wrong role, wrong ref, or near expiry", () => {
  const root = fixtureRoot();
  const cohortKey = mintCohortJwt({
    secret: "test-secret",
    ref: "other-ref",
    role: "anon",
    iat: 1000,
    expSeconds: 10 * 24 * 60 * 60,
  });
  writeKey(root, cohortKey);
  const result = inspectPackagedCohortKey({
    root,
    expectedRef: "txjntzwksiluvqcpccpc",
    minDays: 30,
    now: new Date(1100 * 1000),
  });
  assert.equal(result.ready, false);
  assert.equal(result.status, "invalid");
  assert.match(result.errors.join("\n"), /expected role=cohort_app/);
  assert.match(result.errors.join("\n"), /expected ref=txjntzwksiluvqcpccpc/);
  assert.match(result.errors.join("\n"), /below minDays=30/);
});

test("formatted inspection never includes token material", () => {
  const root = fixtureRoot();
  const cohortKey = mintCohortJwt({
    secret: "test-secret",
    ref: "txjntzwksiluvqcpccpc",
    role: "cohort_app",
    iat: 1000,
    expSeconds: 365 * 24 * 60 * 60,
  });
  writeKey(root, cohortKey);
  const result = inspectPackagedCohortKey({ root, now: new Date(1100 * 1000) });
  const output = formatPackagedCohortKeyInspection(result);
  assert.doesNotMatch(output, /eyJ/);
  assert.doesNotMatch(output, new RegExp(cohortKey.split(".")[2]));
  assert.match(output, /role: cohort_app/);
});

test("projectRefFromSupabaseUrl extracts the hosted project ref", () => {
  assert.equal(projectRefFromSupabaseUrl("https://txjntzwksiluvqcpccpc.supabase.co"), "txjntzwksiluvqcpccpc");
  assert.equal(projectRefFromSupabaseUrl("https://example.com"), "");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const PR_WORKFLOW = ".github/workflows/os-pr-checks.yml";
const RELEASE_WORKFLOW = ".github/workflows/os-release.yml";

function workflow(path) {
  return fs.readFileSync(path, "utf8");
}

test("OS PR checks run the commit privacy boundary and public surface scanner", () => {
  const source = workflow(PR_WORKFLOW);

  assert.match(source, /node scripts\/check-commit-privacy-boundary\.mjs --all/);
  assert.match(source, /npm run surface:scan/);
});

test("OS PR checks run the full unit suite after materializing generated assets", () => {
  const source = workflow(PR_WORKFLOW);
  const checkIndex = source.indexOf("npm run check:cohort");
  const vendorIndex = source.indexOf("npm run vendor:web");
  const buildIndex = source.indexOf("npm run build:cohort");
  const testIndex = source.indexOf("npm test");

  assert.ok(checkIndex > 0);
  assert.ok(vendorIndex > checkIndex);
  assert.ok(buildIndex > vendorIndex);
  assert.ok(testIndex > buildIndex);
});

test("OS release builds run privacy gates after regenerating cohort assets", () => {
  const source = workflow(RELEASE_WORKFLOW);
  const buildIndex = source.lastIndexOf("npm run build:cohort");
  const privacyIndex = source.lastIndexOf("node scripts/check-commit-privacy-boundary.mjs --all");
  const surfaceIndex = source.lastIndexOf("npm run surface:scan");
  const bundleIndex = source.indexOf("npm run bundle:check --workspace @shape-rotator/os");

  assert.ok(buildIndex > 0);
  assert.ok(privacyIndex > buildIndex);
  assert.ok(surfaceIndex > privacyIndex);
  assert.ok(bundleIndex > surfaceIndex);
});

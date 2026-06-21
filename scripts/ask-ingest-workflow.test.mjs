import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/ask-ingest.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

test("ask-ingest direct push runs privacy gates before committing to main", () => {
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions.issues, "write");
  assert.match(workflowText, /git push origin HEAD:main/);
  assert.match(workflowText, /\[skip ci\]/);

  const buildIndex = workflowText.indexOf("npm run build:cohort");
  const vendorIndex = workflowText.indexOf("npm run vendor:web");
  const privacyIndex = workflowText.indexOf("node scripts/check-commit-privacy-boundary.mjs --staged");
  const surfaceIndex = workflowText.indexOf("npm run surface:scan");
  const testIndex = workflowText.indexOf("npm test");
  const addIndex = workflowText.indexOf("git add \"cohort-data/asks/${SLUG}.md\" \"apps/os/src/cohort-surface.json\"");
  const commitIndex = workflowText.indexOf("git commit");

  assert.ok(buildIndex > 0);
  assert.ok(vendorIndex > buildIndex);
  assert.ok(addIndex > vendorIndex);
  assert.ok(privacyIndex > addIndex);
  assert.ok(surfaceIndex > privacyIndex);
  assert.ok(testIndex > surfaceIndex);
  assert.ok(commitIndex > testIndex);

  const retryBuildIndex = workflowText.lastIndexOf("npm run build:cohort");
  const retryVendorIndex = workflowText.lastIndexOf("npm run vendor:web");
  const retryAddIndex = workflowText.lastIndexOf('git add "apps/os/src/cohort-surface.json"');
  const retryPrivacyIndex = workflowText.lastIndexOf("node scripts/check-commit-privacy-boundary.mjs --staged");
  const retrySurfaceIndex = workflowText.lastIndexOf("npm run surface:scan");
  const retryTestIndex = workflowText.lastIndexOf("npm test");
  const amendIndex = workflowText.indexOf("git commit --amend --no-edit");

  assert.ok(retryBuildIndex > commitIndex);
  assert.ok(retryVendorIndex > retryBuildIndex);
  assert.ok(retryAddIndex > retryVendorIndex);
  assert.ok(retryPrivacyIndex > retryAddIndex);
  assert.ok(retrySurfaceIndex > retryPrivacyIndex);
  assert.ok(retryTestIndex > retrySurfaceIndex);
  assert.ok(amendIndex > retryTestIndex);
});

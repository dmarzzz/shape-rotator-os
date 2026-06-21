import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/github-releases-sync.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

test("github releases sync opens a guarded PR instead of pushing generated artifacts to main", () => {
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions["pull-requests"], "write");
  assert.match(workflowText, /SYNC_BRANCH:\s*automation\/github-releases-sync/);
  assert.match(workflowText, /gh pr create --base main --head "\$SYNC_BRANCH"/);
  assert.doesNotMatch(workflowText, /git push origin HEAD:main/);

  const addIndex = workflowText.indexOf("git add cohort-data/artifacts/github-releases cohort-data/artifacts/cohort-insights apps/os/src/cohort-surface.json");
  const privacyIndex = workflowText.indexOf("node scripts/check-commit-privacy-boundary.mjs --staged");
  const surfaceIndex = workflowText.indexOf("npm run surface:scan");
  const commitIndex = workflowText.indexOf("git commit -m \"chore(releases): sync cohort GitHub releases\"");

  assert.ok(addIndex > 0);
  assert.ok(privacyIndex > addIndex);
  assert.ok(surfaceIndex > privacyIndex);
  assert.ok(commitIndex > surfaceIndex);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/pr-conflict-watch.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

test("pr conflict remediation includes privacy gates before force pushing", () => {
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions.issues, "write");
  assert.equal(workflow.permissions["pull-requests"], "read");

  const addIndex = workflowText.indexOf('"git add apps/os/src/cohort-surface.json"');
  const privacyIndex = workflowText.indexOf('"node scripts/check-commit-privacy-boundary.mjs --staged"');
  const surfaceIndex = workflowText.indexOf('"npm run surface:scan"');
  const continueIndex = workflowText.indexOf('"git rebase --continue"');
  const pushIndex = workflowText.indexOf('"git push --force-with-lease"');

  assert.ok(addIndex > 0);
  assert.ok(privacyIndex > addIndex);
  assert.ok(surfaceIndex > privacyIndex);
  assert.ok(continueIndex > surfaceIndex);
  assert.ok(pushIndex > continueIndex);
});

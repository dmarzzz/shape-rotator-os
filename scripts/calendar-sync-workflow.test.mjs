import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/calendar-sync.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

test("calendar-sync respects protected main by using a PR sync branch", () => {
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions["pull-requests"], "write");
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.match(workflowText, /SYNC_BRANCH:\s*automation\/calendar-sync/);
  assert.match(workflowText, /gh pr create --base main --head "\$SYNC_BRANCH"/);
  assert.match(workflowText, /Could not create calendar sync PR/);
  // Live source is the Supabase publish; the git PR is now just the offline
  // bundle refresh, so there is no auto-merge.
  assert.match(workflowText, /publish-calendar-grid-to-supabase/);
  assert.doesNotMatch(workflowText, /--auto --squash/);
  assert.doesNotMatch(workflowText, /git push origin HEAD:main/);
});

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
  for (const expectedPath of [
    "scripts/build-calendar-from-google.js",
    "scripts/publish-calendar-grid-to-supabase.mjs",
    "scripts/build-ics.js",
    "cohort-data/calendar-meta.json",
    "scripts/build-cohort-insights.mjs",
    "scripts/lib/cohort-insight-engine.cjs",
    "scripts/build-bundles.js",
    ".github/workflows/calendar-sync.yml",
  ]) {
    assert.ok(workflow.on.push.paths.includes(expectedPath), `calendar-sync push filter should include ${expectedPath}`);
  }
  assert.equal(workflow.on.schedule[0].cron, "0 * * * *");
  assert.match(workflowText, /SYNC_BRANCH:\s*automation\/calendar-sync/);
  assert.match(workflowText, /gh pr create --base main --head "\$SYNC_BRANCH"/);
  assert.match(workflowText, /Could not create calendar sync PR/);
  // Live source is the Supabase publish; the git PR is now just the offline
  // bundle refresh, so there is no auto-merge.
  assert.match(workflowText, /publish-calendar-grid-to-supabase/);
  assert.match(workflowText, /git fetch origin "\$SYNC_BRANCH"/);
  assert.match(workflowText, /build-calendar-from-google/);
  assert.doesNotMatch(workflowText, /--auto --squash/);
  assert.doesNotMatch(workflowText, /git commit[\s\S]{0,400}\[skip ci\]/);
  assert.doesNotMatch(workflowText, /git push origin HEAD:main/);
});

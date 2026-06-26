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

test("calendar-sync self-arms Meet links + transcription after the live publish", () => {
  // Every future event must end up with a Meet link AND auto-transcription,
  // however it was created. These run as the documented reconciler pair.
  const publishIdx = workflowText.indexOf("publish-calendar-grid-to-supabase");
  const meetLinksIdx = workflowText.indexOf("calendar:meet-links:google");
  const armIdx = workflowText.indexOf("calendar:meet-auto-artifacts:google");

  assert.ok(meetLinksIdx !== -1, "calendar-sync should ensure future Meet links");
  assert.ok(armIdx !== -1, "calendar-sync should arm future Meet transcription");

  // Arming must run AFTER the live Supabase publish so a Google failure can
  // never block the schedule, and links must precede transcription (a link is
  // the prerequisite for arming a transcript).
  assert.ok(publishIdx !== -1 && meetLinksIdx > publishIdx, "Meet-link reconcile must run after the Supabase publish");
  assert.ok(armIdx > meetLinksIdx, "transcription arming must run after Meet-link reconcile");

  // Safe flags: transcription must no-op cleanly when the Meet settings scope
  // is absent rather than failing the whole sync.
  assert.match(workflowText, /calendar:meet-auto-artifacts:google -- --apply --time-min "\$\{\{ steps\.window\.outputs\.time_min \}\}" --skip-if-missing-scope/);
  assert.match(workflowText, /calendar:meet-links:google -- --apply --time-min "\$\{\{ steps\.window\.outputs\.time_min \}\}"/);
  assert.match(workflowText, /time_min=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)/);

  // The arming steps mutate Google only; they must not introduce a new push
  // trigger path that could loop the workflow.
  assert.ok(!workflow.on.push.paths.includes("scripts/ensure-google-calendar-meet-auto-artifacts.js"));
});

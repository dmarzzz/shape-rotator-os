import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/google-calendar-watch-renewal.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

test("Google Calendar watch renewal workflow is manual-only operator fallback", () => {
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.on.schedule, undefined);
  assert.doesNotMatch(workflowText, /^\s*schedule:/m);
  assert.doesNotMatch(workflowText, /github\.event\.schedule/);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency.group, "google-calendar-watch-renewal");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);

  const env = workflow.jobs.renew.env;
  for (const secretName of [
    "GOOGLE_CALENDAR_ID",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
    "GOOGLE_OAUTH_SCOPES",
    "GOOGLE_CALENDAR_WEBHOOK_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ORG_ID",
    "CALENDAR_CONNECTION_ID",
  ]) {
    assert.equal(env[secretName], `\${{ secrets.${secretName} }}`);
  }

  // The guest-calendar mirror was removed in favor of a single shared cohort
  // calendar (admins edit directly; members subscribe read-only), so the
  // renewal workflow must no longer carry the mirror step or guest secrets.
  assert.doesNotMatch(workflowText, /calendar:mirror:google/);
  assert.equal(env.GOOGLE_GUEST_CALENDAR_ID, undefined);
  assert.equal(env.GUEST_CALENDAR_CONNECTION_ID, undefined);

  assert.match(workflowText, /npm run calendar:watch:google -- --apply/);
  assert.match(workflowText, /npm run calendar:meet-links:google -- --apply --time-min/);
  assert.match(workflowText, /npm run calendar:capture-bot:google -- --apply --time-min/);
  assert.match(workflowText, /npm run calendar:meet-auto-artifacts:google -- --apply --time-min .* --skip-if-missing-scope/);
  assert.doesNotMatch(workflowText, /calendar:meet-auto-artifacts:google.*--fail-on-error/);
  assert.match(workflowText, /npm run calendar:sync:google -- --apply/);
  assert.doesNotMatch(workflowText, /GOOGLE_CALENDAR_ACCESS_TOKEN/);
});

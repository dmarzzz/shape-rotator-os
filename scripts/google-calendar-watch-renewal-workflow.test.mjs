import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/google-calendar-watch-renewal.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

test("Google Calendar watch renewal workflow uses durable OAuth refresh credentials", () => {
  assert.match(workflowText, /cron:\s*"17 8 \* \* \*"/);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency.group, "google-calendar-watch-renewal");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);

  const env = workflow.jobs.renew.env;
  for (const secretName of [
    "GOOGLE_CALENDAR_ID",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
    "GOOGLE_CALENDAR_WEBHOOK_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ORG_ID",
    "CALENDAR_CONNECTION_ID",
  ]) {
    assert.equal(env[secretName], `\${{ secrets.${secretName} }}`);
  }

  assert.match(workflowText, /npm run calendar:watch:google -- --apply/);
  assert.match(workflowText, /npm run calendar:sync:google -- --apply/);
  assert.doesNotMatch(workflowText, /GOOGLE_CALENDAR_ACCESS_TOKEN/);
});

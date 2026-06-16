import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("public web calendar does not load the signed-in Supabase source module", () => {
  const calendarSource = read("apps/web/scripts/calendar.js");

  assert.match(calendarSource, /const WEB_CALENDAR_URL = "\/calendar\.json"/);
  assert.doesNotMatch(calendarSource, /calendar-supabase-source|loadSupabaseCalendarSnapshot|fetchSupabaseSessions/i);
  assert.doesNotMatch(calendarSource, /accessToken|orgId/);
});

test("public web calendar page does not mount operator ingress", () => {
  const html = read("apps/web/calendar/index.html");

  assert.doesNotMatch(html, /calendar-ingress/i);
  assert.doesNotMatch(html, /operator controls|operator setup|Supabase anon key|signed-in access token/i);
});

test("public web app does not ship Supabase/operator calendar source bundles", () => {
  const removed = [
    "apps/web/scripts/calendar-supabase-source.mjs",
    "apps/web/scripts/calendar-ingress.js",
    "apps/web/scripts/calendar-ingress-client.mjs",
    "apps/web/scripts/calendar-ingress-client/index.mjs",
    "apps/web/styles/calendar-ingress.css",
  ];

  for (const relativePath of removed) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not be in apps/web`);
  }
});

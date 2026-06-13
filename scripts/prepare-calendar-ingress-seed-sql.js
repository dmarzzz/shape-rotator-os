#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  buildCalendarIngressSeedSql,
  mergeEnv,
} = require("./lib/calendar-ingress-setup.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-calendar-ingress-seed-sql.js [--env-file .env.local] [--out seed.sql]",
    "",
    "Reads non-browser launch values and emits idempotent SQL for:",
    "  orgs, first admin membership, routing_policies, calendar_connections",
    "",
    "Relevant env keys:",
    "  ORG_SLUG, ORG_NAME, ADMIN_USER_ID, GOOGLE_CALENDAR_ID,",
    "  GOOGLE_CALENDAR_ORGANIZER_EMAIL, GOOGLE_CALENDAR_AUTH_MODE",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const env = mergeEnv({ envFile: arg("--env-file") });
  const sql = buildCalendarIngressSeedSql({
    env,
    repoRoot: path.resolve(__dirname, ".."),
  });
  const out = arg("--out");
  if (out && out !== "-") {
    fs.writeFileSync(path.resolve(out), sql);
  } else {
    process.stdout.write(sql);
  }
}

main();

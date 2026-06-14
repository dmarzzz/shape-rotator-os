#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { calendarJsonFromSessions } = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/export-supabase-calendar.js --input sessions.json --out cohort-data/calendar.json",
    "  node scripts/export-supabase-calendar.js --input sessions.json --check --out cohort-data/calendar.json",
    "",
    "Input can be either an array of session rows or an object with a sessions array.",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function readInput(filePath) {
  if (!filePath || filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const inputPath = arg("--input");
  if (!inputPath) {
    console.error(usage());
    process.exit(2);
  }
  const outPath = arg("--out");
  const check = process.argv.includes("--check");
  const payload = readInput(inputPath);
  const sessions = Array.isArray(payload) ? payload : payload.sessions;
  const calendar = calendarJsonFromSessions({
    sessions,
    lastRefresh: payload.last_refresh || payload.lastRefresh || new Date().toISOString(),
    tabName: payload.tabName || "Supabase Sessions",
  });
  const rendered = JSON.stringify(calendar, null, 2) + "\n";

  if (!outPath) {
    process.stdout.write(rendered);
    return;
  }
  const resolved = path.resolve(outPath);
  if (check) {
    const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
    if (existing !== rendered) {
      console.error(`[export-supabase-calendar] --check: ${outPath} is stale`);
      process.exit(1);
    }
    console.log(`[export-supabase-calendar] --check: ${outPath} is up to date`);
    return;
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rendered);
  console.log(`[export-supabase-calendar] wrote ${outPath}`);
}

if (require.main === module) main();

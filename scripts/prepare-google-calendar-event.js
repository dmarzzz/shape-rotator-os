#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  buildGoogleCalendarEvent,
  loadRoutingPolicy,
  defaultPolicyPath,
} = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-google-calendar-event.js --session session.json [--policy cohort-data/policies/transcript-routing-policy.json] [--attendees attendees.json] [--bot-email bot@example.com]",
    "",
    "Prints the Google Calendar events.insert query/body payload for backend use.",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function readJson(filePath, fallback) {
  if (!filePath) return fallback;
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const sessionPath = arg("--session");
  if (!sessionPath) {
    console.error(usage());
    process.exit(2);
  }
  const session = readJson(sessionPath);
  const attendeesPayload = readJson(arg("--attendees"), []);
  const attendees = Array.isArray(attendeesPayload) ? attendeesPayload : attendeesPayload.attendees || [];
  const policy = loadRoutingPolicy(arg("--policy") || defaultPolicyPath());
  const payload = buildGoogleCalendarEvent({
    session,
    attendees,
    policy,
    botEmail: arg("--bot-email"),
    requestMeet: !process.argv.includes("--no-meet"),
  });
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

if (require.main === module) main();

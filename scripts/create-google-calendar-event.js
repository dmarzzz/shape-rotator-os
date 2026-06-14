#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  buildGoogleCalendarEvent,
  loadRoutingPolicy,
  defaultPolicyPath,
  googleEventToSessionRow,
} = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/create-google-calendar-event.js --calendar-id CALENDAR_ID --session session.json [--attendees attendees.json] [--access-token TOKEN] [--dry-run]",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_ACCESS_TOKEN",
    "",
    "This helper is intended for backend/worker use. Do not run it from the Electron renderer.",
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

async function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const sessionPath = arg("--session");
  const calendarId = arg("--calendar-id") || process.env.GOOGLE_CALENDAR_ID;
  const accessToken = arg("--access-token") || process.env.GOOGLE_ACCESS_TOKEN;
  const dryRun = process.argv.includes("--dry-run");
  if (!sessionPath || !calendarId) {
    console.error(usage());
    process.exit(2);
  }

  const policy = loadRoutingPolicy(arg("--policy") || defaultPolicyPath());
  const session = readJson(sessionPath);
  const attendeesPayload = readJson(arg("--attendees"), []);
  const attendees = Array.isArray(attendeesPayload) ? attendeesPayload : attendeesPayload.attendees || [];
  const payload = buildGoogleCalendarEvent({
    session,
    attendees,
    policy,
    botEmail: arg("--bot-email") || process.env.SHAPE_CALENDAR_BOT_EMAIL,
    requestMeet: !process.argv.includes("--no-meet"),
  });
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("sendUpdates", payload.query.sendUpdates);
  url.searchParams.set("conferenceDataVersion", String(payload.query.conferenceDataVersion));

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      method: "POST",
      url: String(url),
      body: payload.body,
      decision: payload.decision,
    }, null, 2) + "\n");
    return;
  }

  if (!accessToken) {
    console.error("GOOGLE_ACCESS_TOKEN or --access-token is required unless --dry-run is set");
    process.exit(2);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(JSON.stringify({ status: response.status, body: data }, null, 2));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    google_event: data,
    session_row: googleEventToSessionRow(data, { policy }),
  }, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

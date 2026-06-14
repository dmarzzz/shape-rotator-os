#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { meetArtifactRowsFromManifest } = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-meet-artifacts.js --manifest meet-manifest.json --session-id SESSION_ID [--org-id ORG_ID] [--fetched-raw]",
    "",
    "Manifest shape:",
    "  {",
    "    \"conference_record\": \"conferenceRecords/abc\",",
    "    \"meet_space\": \"spaces/xyz\",",
    "    \"artifacts\": [",
    "      { \"kind\": \"transcript\", \"name\": \"conferenceRecords/abc/transcripts/123\" },",
    "      { \"kind\": \"smart_notes\", \"name\": \"conferenceRecords/abc/smartNotes/456\" }",
    "    ]",
    "  }",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function readJson(filePath) {
  if (filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const manifestPath = arg("--manifest");
  const sessionId = arg("--session-id");
  if (!manifestPath || !sessionId) {
    console.error(usage());
    process.exit(2);
  }
  const manifest = readJson(manifestPath);
  const rows = meetArtifactRowsFromManifest({
    orgId: arg("--org-id"),
    sessionId,
    manifest,
    fetchedRaw: process.argv.includes("--fetched-raw"),
  });
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

if (require.main === module) main();

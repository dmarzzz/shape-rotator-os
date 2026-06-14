#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { manualSourceArtifactRowsFromManifest } = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-manual-artifacts.js --manifest manifest.json [--session-id SESSION_ID] [--org-id ORG_ID]",
    "",
    "Manifest shape:",
    "  {",
    "    \"storage_mode\": \"local_only\",",
    "    \"artifacts\": [",
    "      { \"kind\": \"manual_upload\", \"file\": \"local/transcript.txt\", \"mime_type\": \"text/plain\" },",
    "      { \"kind\": \"drive_doc\", \"url\": \"https://docs.google.com/...\" }",
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
  if (!manifestPath) {
    console.error(usage());
    process.exit(2);
  }
  const manifest = readJson(manifestPath);
  const rows = manualSourceArtifactRowsFromManifest({
    orgId: arg("--org-id"),
    sessionId: arg("--session-id"),
    manifest,
  });
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

if (require.main === module) main();

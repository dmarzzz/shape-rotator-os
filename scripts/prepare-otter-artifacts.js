#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { otterArtifactRowsFromManifest } = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-otter-artifacts.js --manifest otter-manifest.json --session-id SESSION_ID [--org-id ORG_ID] [--fetched-raw]",
    "  node scripts/prepare-otter-slides-manifest.js --dir otter-export --conversation-id OTTER_ID --out otter-manifest.json",
    "",
    "Manifest shape:",
    "  {",
    "    \"conversation_id\": \"otter-conversation-id\",",
    "    \"slides\": [",
    "      { \"file\": \"exports/slide-001.jpg\", \"source_hash\": \"sha256...\", \"slide_number\": 1 }",
    "    ],",
    "    \"artifacts\": [",
    "      { \"kind\": \"transcript\", \"file\": \"exports/transcript.txt\" },",
    "      { \"kind\": \"summary\", \"file\": \"exports/summary.txt\" },",
    "      { \"kind\": \"slides\", \"file\": \"exports/slide-001.jpg\", \"captured_at\": \"2026-06-12T16:10:00Z\" }",
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
  const rows = otterArtifactRowsFromManifest({
    orgId: arg("--org-id"),
    sessionId,
    manifest,
    fetchedRaw: process.argv.includes("--fetched-raw"),
  });
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

if (require.main === module) main();

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./lib/env-file.cjs");
const {
  buildSupabaseUpsertRequests,
  executeSupabaseRequests,
} = require("./lib/supabase-rest.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-supabase-upsert.js --input rows.json --supabase-url URL",
    "  node scripts/prepare-supabase-upsert.js --input rows.json --apply",
    "",
    "Environment fallbacks:",
    "  SHAPE_SUPABASE_URL or SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  --env-file FILE",
    "",
    "Input keys:",
    "  sessions, attendees, ingestionEvents, captureArtifacts, sourceArtifacts, processingJobs, derivedArtifacts, approvalGates, artifactReviews",
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

async function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const inputPath = arg("--input");
  const envFile = arg("--env-file");
  if (envFile) loadEnvFile(envFile);
  const supabaseUrl = arg("--supabase-url") || process.env.SHAPE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!inputPath || !supabaseUrl) {
    console.error(usage());
    process.exit(2);
  }
  const payload = readInput(inputPath);
  const requests = buildSupabaseUpsertRequests({
    supabaseUrl,
    sessions: payload.sessions,
    attendees: payload.attendees,
    ingestionEvents: payload.ingestionEvents,
    captureArtifacts: payload.captureArtifacts,
    sourceArtifacts: payload.sourceArtifacts,
    processingJobs: payload.processingJobs,
    derivedArtifacts: payload.derivedArtifacts,
    approvalGates: payload.approvalGates,
    artifactReviews: payload.artifactReviews,
  });

  if (!process.argv.includes("--apply")) {
    process.stdout.write(JSON.stringify({ requests }, null, 2) + "\n");
    return;
  }

  const serviceRoleKey = arg("--service-role-key") || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY or --service-role-key is required with --apply");
    process.exit(2);
  }
  const results = await executeSupabaseRequests({ requests, serviceRoleKey });
  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

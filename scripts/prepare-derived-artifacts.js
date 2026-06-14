#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildDerivedArtifactsFromTranscript,
  loadRoutingPolicy,
} = require("./lib/calendar-integration.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-derived-artifacts.js --transcript transcript.txt --session session.json --source-artifact source-artifact.json [--processing-job job.json] [--org-id ORG_ID] [--policy policy.json]",
    "",
    "Reads the raw transcript locally and writes Supabase-ready derived rows only.",
    "The raw transcript text is not included in the output.",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function readText(filePath) {
  if (filePath === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

function readJson(filePath) {
  if (!filePath) return null;
  return JSON.parse(readText(filePath));
}

function assignIds({ derivedArtifacts, approvalGates }) {
  for (const artifact of derivedArtifacts || []) {
    if (!artifact.id) artifact.id = crypto.randomUUID();
  }
  const publicCandidate = (derivedArtifacts || []).find((artifact) => artifact.artifact_kind === "public_candidate");
  for (const gate of approvalGates || []) {
    if (!gate.id) gate.id = crypto.randomUUID();
    if (!gate.derived_artifact_id && publicCandidate?.id) gate.derived_artifact_id = publicCandidate.id;
    if (!gate.session_id && publicCandidate?.session_id) gate.session_id = publicCandidate.session_id;
    if (!gate.org_id && publicCandidate?.org_id) gate.org_id = publicCandidate.org_id;
  }
}

function buildProcessingJobCompletion(processingJob) {
  if (!processingJob?.id) return null;
  return {
    ...processingJob,
    processor_status: "complete",
    finished_at: new Date().toISOString(),
  };
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const transcriptPath = arg("--transcript");
  const sessionPath = arg("--session");
  const sourceArtifactPath = arg("--source-artifact");
  if (!transcriptPath || !sessionPath || !sourceArtifactPath) {
    console.error(usage());
    process.exit(2);
  }

  const session = readJson(sessionPath);
  const sourceArtifact = readJson(sourceArtifactPath);
  const processingJob = readJson(arg("--processing-job"));
  const policy = arg("--policy") ? readJson(arg("--policy")) : loadRoutingPolicy();
  const orgId = arg("--org-id") || session?.org_id || sourceArtifact?.org_id;
  const transcriptText = readText(transcriptPath);
  const rows = buildDerivedArtifactsFromTranscript({
    orgId,
    session,
    sourceArtifact,
    processingJob,
    policy,
    transcriptText,
  });
  assignIds(rows);

  const processingJobCompletion = buildProcessingJobCompletion(processingJob);
  const output = {
    derivedArtifacts: rows.derivedArtifacts,
    approvalGates: rows.approvalGates,
  };
  if (processingJobCompletion) output.processingJobs = [processingJobCompletion];
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (require.main === module) main();

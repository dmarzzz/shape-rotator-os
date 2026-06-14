#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildDerivedArtifactsFromTranscript, loadRoutingPolicy } = require("./lib/calendar-integration.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");

const TEXT_SOURCE_KINDS = new Set([
  "manual_upload",
  "meet_transcript",
  "meet_smart_notes",
  "otter_transcript",
  "otter_summary",
  "drive_doc",
  "router",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/run-local-distillation-worker.js --input worker-batch.json [--transcript-root DIR] [--out rows.json]",
    "  node scripts/run-local-distillation-worker.js --supabase-url URL --service-role-key KEY --org-id ORG_ID --apply [--transcript-root DIR] [--limit 5]",
    "",
    "The worker reads raw transcript files locally and writes only derived rows/gates/job status.",
    "Raw transcript text is never printed or sent to stdout.",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function intArg(name, fallback) {
  const value = Number(arg(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readJson(filePath) {
  if (!filePath || filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (!filePath || filePath === "-") {
    process.stdout.write(text);
    return;
  }
  fs.writeFileSync(path.resolve(filePath), text);
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

function isLikelyTextPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return !ext || [".txt", ".md", ".markdown", ".json", ".csv", ".srt", ".vtt"].includes(ext);
}

function fileUrlToPath(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return null;
  }
}

function resolveTranscriptPath(sourceArtifact, { transcriptRoot = process.cwd() } = {}) {
  const ref = String(sourceArtifact?.local_path || sourceArtifact?.storage_ref || "").trim();
  if (!ref) throw new Error("source artifact has no local storage_ref");
  if (/^https?:\/\//i.test(ref)) throw new Error("source artifact storage_ref is remote, not local");
  const fileUrlPath = /^file:/i.test(ref) ? fileUrlToPath(ref) : null;
  const candidate = fileUrlPath || ref;
  const resolved = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(transcriptRoot, candidate);
  const root = path.resolve(transcriptRoot);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("source artifact path escapes transcript root");
  }
  if (!isLikelyTextPath(resolved)) throw new Error("source artifact does not point to a supported text file");
  return resolved;
}

function readTranscriptText(sourceArtifact, options = {}) {
  if (!TEXT_SOURCE_KINDS.has(sourceArtifact?.source_kind)) {
    throw new Error(`source kind is not text-distillable: ${sourceArtifact?.source_kind || "unknown"}`);
  }
  const filePath = resolveTranscriptPath(sourceArtifact, options);
  return fs.readFileSync(filePath, "utf8");
}

function normalizeBatch(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.jobs)) return input.jobs;
  return [];
}

function normalizeJobItem(item) {
  return {
    processingJob: item.processingJob || item.processing_job || item.job || item,
    sourceArtifact: item.sourceArtifact || item.source_artifact,
    session: item.session,
  };
}

function jobFailure(item, error) {
  const { processingJob, sourceArtifact, session } = normalizeJobItem(item);
  return {
    processingJob,
    sourceArtifact: sourceArtifact ? { ...sourceArtifact, storage_ref: sourceArtifact.storage_ref || null } : null,
    session: session ? { id: session.id, session_type: session.session_type, public_title: session.public_title || session.title } : null,
    error: error.message || String(error),
  };
}

function buildDistillationForJob(item, { policy, transcriptRoot = process.cwd() } = {}) {
  const { processingJob, sourceArtifact, session } = normalizeJobItem(item);
  if (!processingJob?.id) throw new Error("processing job id is required");
  if (processingJob.job_kind && processingJob.job_kind !== "distill") throw new Error(`unsupported job_kind: ${processingJob.job_kind}`);
  if (processingJob.processor_mode && processingJob.processor_mode !== "local") throw new Error(`unsupported processor_mode: ${processingJob.processor_mode}`);
  if (!sourceArtifact?.id) throw new Error("source artifact id is required");
  if (!session?.id) throw new Error("session id is required");
  const transcriptText = readTranscriptText(sourceArtifact, { transcriptRoot });
  const rows = buildDerivedArtifactsFromTranscript({
    orgId: processingJob.org_id || sourceArtifact.org_id || session.org_id,
    session,
    sourceArtifact,
    processingJob,
    policy,
    transcriptText,
  });
  assignIds(rows);
  const finishedAt = new Date().toISOString();
  const hasReadout = rows.derivedArtifacts.length > 0;
  return {
    processingJob,
    sourceArtifact: {
      id: sourceArtifact.id,
      session_id: sourceArtifact.session_id,
      source_kind: sourceArtifact.source_kind,
      storage_mode: sourceArtifact.storage_mode,
      storage_ref: sourceArtifact.storage_ref,
    },
    session: {
      id: session.id,
      session_type: session.session_type,
      public_title: session.public_title || session.title,
    },
    derivedArtifacts: rows.derivedArtifacts,
    approvalGates: rows.approvalGates,
    processingJobPatch: {
      id: processingJob.id,
      processor_status: "complete",
      finished_at: finishedAt,
    },
    sessionPatch: {
      id: session.id,
      transcript_status: hasReadout ? "distilled" : "source_ready",
      bot_status: "processed",
      ...(hasReadout ? { first_readout_at: finishedAt } : {}),
    },
  };
}

function buildDistillationBatch(input, { policy = loadRoutingPolicy(), transcriptRoot = process.cwd() } = {}) {
  const results = [];
  const failures = [];
  for (const rawItem of normalizeBatch(input)) {
    try {
      results.push(buildDistillationForJob(rawItem, { policy, transcriptRoot }));
    } catch (error) {
      failures.push(jobFailure(rawItem, error));
    }
  }
  return {
    results,
    failures,
    derivedArtifacts: results.flatMap((item) => item.derivedArtifacts),
    approvalGates: results.flatMap((item) => item.approvalGates),
    processingJobPatches: results.map((item) => item.processingJobPatch),
    sessionPatches: results.map((item) => item.sessionPatch),
  };
}

async function fetchRowsById({ supabaseUrl, serviceRoleKey, table, ids, fetchImpl }) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniqueIds.length) return [];
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "GET",
    query: {
      select: "*",
      id: `in.(${uniqueIds.join(",")})`,
    },
    fetchImpl,
  });
}

async function fetchQueuedLocalJobs({ supabaseUrl, serviceRoleKey, orgId, limit = 5, fetchImpl = fetch } = {}) {
  if (!orgId) throw new Error("orgId is required");
  const jobs = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    method: "GET",
    query: {
      select: "*",
      org_id: `eq.${orgId}`,
      job_kind: "eq.distill",
      processor_mode: "eq.local",
      processor_status: "eq.queued",
      order: "due_at.asc.nullslast,created_at.asc",
      limit,
    },
    fetchImpl,
  });
  const sourceArtifacts = await fetchRowsById({
    supabaseUrl,
    serviceRoleKey,
    table: "source_artifacts",
    ids: jobs.map((job) => job.source_artifact_id),
    fetchImpl,
  });
  const sessions = await fetchRowsById({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    ids: sourceArtifacts.map((artifact) => artifact.session_id),
    fetchImpl,
  });
  const sourcesById = new Map(sourceArtifacts.map((artifact) => [artifact.id, artifact]));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  return jobs.map((job) => {
    const sourceArtifact = sourcesById.get(job.source_artifact_id);
    return {
      processingJob: job,
      sourceArtifact,
      session: sourceArtifact ? sessionsById.get(sourceArtifact.session_id) : null,
    };
  });
}

async function insertRows({ supabaseUrl, serviceRoleKey, table, rows, onConflict, fetchImpl }) {
  const body = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!body.length) return [];
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "POST",
    query: onConflict ? { on_conflict: onConflict } : {},
    body,
    prefer: onConflict ? "resolution=merge-duplicates,return=representation" : "return=representation",
    fetchImpl,
  });
}

async function patchRow({ supabaseUrl, serviceRoleKey, table, id, body, fetchImpl }) {
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "PATCH",
    query: { id: `eq.${id}` },
    body,
    prefer: "return=representation",
    fetchImpl,
  });
}

async function applyDistillationResult({ supabaseUrl, serviceRoleKey, result, fetchImpl = fetch } = {}) {
  const { id: sessionId, ...sessionPatchBody } = result.sessionPatch;
  await patchRow({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    id: result.processingJob.id,
    body: {
      processor_status: "running",
      started_at: new Date().toISOString(),
      error: null,
    },
    fetchImpl,
  });
  const derivedArtifacts = await insertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "derived_artifacts",
    rows: result.derivedArtifacts,
    onConflict: "id",
    fetchImpl,
  });
  const approvalGates = await insertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "approval_gates",
    rows: result.approvalGates,
    onConflict: "derived_artifact_id,gate_key",
    fetchImpl,
  });
  const processingJobs = await patchRow({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    id: result.processingJob.id,
    body: {
      processor_status: "complete",
      finished_at: result.processingJobPatch.finished_at,
      error: null,
    },
    fetchImpl,
  });
  const sessions = await patchRow({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    id: sessionId || result.session.id,
    body: sessionPatchBody,
    fetchImpl,
  });
  return { derivedArtifacts, approvalGates, processingJobs, sessions };
}

async function markJobFailed({ supabaseUrl, serviceRoleKey, processingJob, error, fetchImpl = fetch } = {}) {
  if (!processingJob?.id) return [];
  return patchRow({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    id: processingJob.id,
    body: {
      processor_status: "failed",
      finished_at: new Date().toISOString(),
      error: String(error?.message || error || "local worker failed").slice(0, 1000),
    },
    fetchImpl,
  });
}

async function runLiveWorker({ supabaseUrl, serviceRoleKey, orgId, policy, transcriptRoot, limit, apply, fetchImpl = fetch } = {}) {
  const jobs = await fetchQueuedLocalJobs({ supabaseUrl, serviceRoleKey, orgId, limit, fetchImpl });
  const batch = buildDistillationBatch({ jobs }, { policy, transcriptRoot });
  const applied = [];
  const failed = [];
  if (apply) {
    for (const result of batch.results) {
      try {
        applied.push(await applyDistillationResult({ supabaseUrl, serviceRoleKey, result, fetchImpl }));
      } catch (error) {
        failed.push({ processingJob: result.processingJob, error: error.message || String(error) });
        await markJobFailed({ supabaseUrl, serviceRoleKey, processingJob: result.processingJob, error, fetchImpl });
      }
    }
    for (const failure of batch.failures) {
      failed.push(failure);
      await markJobFailed({ supabaseUrl, serviceRoleKey, processingJob: failure.processingJob, error: failure.error, fetchImpl });
    }
  }
  return {
    fetched: jobs.length,
    apply: !!apply,
    results: batch.results,
    failures: [...batch.failures, ...failed],
    applied,
    derivedArtifacts: batch.derivedArtifacts,
    approvalGates: batch.approvalGates,
    processingJobPatches: batch.processingJobPatches,
    sessionPatches: batch.sessionPatches,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const transcriptRoot = path.resolve(arg("--transcript-root") || process.cwd());
  const policy = arg("--policy") ? readJson(arg("--policy")) : loadRoutingPolicy();
  const inputPath = arg("--input");
  if (inputPath) {
    const output = buildDistillationBatch(readJson(inputPath), { policy, transcriptRoot });
    writeJson(arg("--out"), output);
    return;
  }
  const supabaseUrl = arg("--supabase-url") || process.env.SUPABASE_URL || process.env.SHAPE_SUPABASE_URL;
  const serviceRoleKey = arg("--service-role-key") || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const orgId = arg("--org-id") || process.env.ORG_ID;
  if (!supabaseUrl || !serviceRoleKey || !orgId) {
    console.error(usage());
    process.exit(2);
  }
  const output = await runLiveWorker({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    policy,
    transcriptRoot,
    limit: intArg("--limit", 5),
    apply: process.argv.includes("--apply"),
  });
  writeJson(arg("--out"), output);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  resolveTranscriptPath,
  readTranscriptText,
  buildDistillationForJob,
  buildDistillationBatch,
  fetchQueuedLocalJobs,
  applyDistillationResult,
  markJobFailed,
  runLiveWorker,
};

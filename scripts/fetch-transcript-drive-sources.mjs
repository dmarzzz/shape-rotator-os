#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvFile } = require("./lib/env-file.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-supabase-plan.json");
const DEFAULT_TRANSCRIPT_ROOT = path.join(ROOT, "cohort-data", ".private", "transcript-sources");
const DEFAULT_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-drive-fetch-manifest.json");
const DEFAULT_BATCH_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-drive-worker-batch.json");

function usage() {
  return [
    "Usage:",
    "  node scripts/fetch-transcript-drive-sources.mjs [--env-file .env.calendar.local] [--plan transcript-supabase-plan.json] [--transcript-root DIR] [--out manifest.json] [--batch-out worker-batch.json] [--summary-out summary.md] [--dry-run]",
    "",
    "Fetches apply-ready Drive transcript refs into ignored private local storage.",
    "Raw transcript text is written only under --transcript-root and is never printed.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_REFRESH_TOKEN + GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function stableUuid(key) {
  const hash = crypto.createHash("sha1").update(String(key || "")).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function posixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function safeFileName(value, fallback = "transcript.txt") {
  const base = path.basename(String(value || fallback))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return base || fallback;
}

function parseDriveFileId(storageRef) {
  const ref = String(storageRef || "").trim();
  if (!ref) return null;
  const driveMatch = /^drive:\/\/([^/?#]+)/i.exec(ref);
  if (driveMatch) return driveMatch[1];
  const fileMatch = /\/file\/d\/([^/]+)/i.exec(ref);
  if (fileMatch) return fileMatch[1];
  const openMatch = /[?&]id=([^&#]+)/i.exec(ref);
  if (openMatch) return decodeURIComponent(openMatch[1]);
  return null;
}

function eventJsonBySource(plan) {
  const byId = new Map();
  for (const event of plan?.ingestionEvents || []) {
    const json = event?.event_json || {};
    if (json.source_artifact_id) byId.set(json.source_artifact_id, json);
  }
  return byId;
}

function jobsBySource(plan) {
  const byId = new Map();
  for (const job of plan?.processingJobs || []) {
    if (!job?.source_artifact_id) continue;
    const list = byId.get(job.source_artifact_id) || [];
    list.push(job);
    byId.set(job.source_artifact_id, list);
  }
  return byId;
}

function plannedFetchItems(plan, { transcriptRoot = DEFAULT_TRANSCRIPT_ROOT } = {}) {
  const events = eventJsonBySource(plan);
  const jobs = jobsBySource(plan);
  const root = path.resolve(transcriptRoot);
  return (plan?.sourceArtifacts || [])
    .map((artifact) => {
      const driveFileId = parseDriveFileId(artifact?.storage_ref);
      if (!artifact?.id || !driveFileId) return null;
      const artifactJobs = jobs.get(artifact.id) || [];
      const fetchJob = artifactJobs.find((job) => job.job_kind === "artifact_fetch") || null;
      const event = events.get(artifact.id) || {};
      const preferred = safeFileName(event.preferred_drive_name || event.original_name || `${artifact.id}.txt`);
      const relativePath = posixPath(path.join("drive", artifact.id, preferred));
      return {
        source_artifact_id: artifact.id,
        org_id: artifact.org_id || plan.org_id || null,
        session_id: artifact.session_id || null,
        source_kind: artifact.source_kind,
        source_tier: artifact.source_tier,
        source_storage_ref: artifact.storage_ref,
        drive_file_id: driveFileId,
        original_name: event.original_name || null,
        preferred_drive_name: event.preferred_drive_name || preferred,
        inferred_session_type: event.inferred_session_type || null,
        inferred_date: event.inferred_date || null,
        max_tier: event.max_tier || null,
        target_drive_route: event.target_drive_route || null,
        local_relative_path: relativePath,
        local_path: path.join(root, relativePath),
        fetch_job: fetchJob,
        source_artifact: artifact,
      };
    })
    .filter(Boolean);
}

function distillJobForFetchedItem(item, { policyVersion, dueAt } = {}) {
  return {
    id: stableUuid(`transcript-drive-distill:${item.source_artifact_id}:local-distill-v1`),
    org_id: item.org_id,
    source_artifact_id: item.source_artifact_id,
    job_kind: "distill",
    processor_mode: "local",
    processor_status: "queued",
    tee_required: false,
    due_at: dueAt || new Date().toISOString(),
    policy_version: policyVersion || null,
    prompt_version: "local-distill-v1",
    model_provider: "local",
    model_name: "deterministic-distiller",
  };
}

function localSourceArtifactForFetchedItem(item, fetched) {
  return {
    ...item.source_artifact,
    storage_mode: "local_only",
    storage_ref: item.local_relative_path,
    source_hash: fetched?.source_hash || null,
    mime_type: fetched?.mime_type || item.source_artifact?.mime_type || "text/plain",
    size_bytes: fetched?.size_bytes ?? item.source_artifact?.size_bytes ?? null,
    raw_available_to_server: false,
  };
}

function sessionStubForFetchedItem(item) {
  return {
    id: item.session_id,
    org_id: item.org_id,
    session_type: item.inferred_session_type || "office_hours",
    public_title: String(item.preferred_drive_name || item.original_name || "Transcript source")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim(),
  };
}

function buildWorkerBatch(items, { policyVersion, fetchedAt, transcriptRoot = DEFAULT_TRANSCRIPT_ROOT } = {}) {
  return {
    generated_at: fetchedAt || new Date().toISOString(),
    transcript_root: path.resolve(transcriptRoot),
    jobs: items
      .filter((item) => item.status === "fetched")
      .map((item) => ({
        processingJob: distillJobForFetchedItem(item, { policyVersion }),
        sourceArtifact: localSourceArtifactForFetchedItem(item, item),
        session: sessionStubForFetchedItem(item),
      })),
  };
}

function buildFetchManifest(plan, {
  transcriptRoot = DEFAULT_TRANSCRIPT_ROOT,
  generatedAt = new Date().toISOString(),
} = {}) {
  const items = plannedFetchItems(plan, { transcriptRoot }).map((item) => ({
    ...item,
    status: "planned",
    local_path: undefined,
  }));
  return {
    generated_at: generatedAt,
    operation_mode: "dry_run",
    transcript_root: path.resolve(transcriptRoot),
    source_plan_generated_at: plan?.generated_at || null,
    org_id: plan?.org_id || null,
    policy_version: plan?.policy_version || null,
    counts: {
      planned_fetches: items.length,
      fetched: 0,
      failed: 0,
      worker_jobs: 0,
    },
    items,
    worker_batch: {
      generated_at: generatedAt,
      transcript_root: path.resolve(transcriptRoot),
      jobs: [],
    },
  };
}

async function refreshGoogleAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  if (!clientId || !clientSecret || !refreshToken) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google OAuth token refresh failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data?.access_token || null;
}

async function resolveGoogleAccessToken({
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  if (refreshToken && clientId && clientSecret) {
    const refreshed = await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
    if (refreshed) return refreshed;
  }
  return accessToken || null;
}

async function driveJson(url, accessToken, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Drive request failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

function driveMetadataUrl(fileId) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,md5Checksum");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function driveContentUrl(metadata) {
  const fileId = metadata?.id;
  if (!fileId) throw new Error("Drive metadata missing id");
  if (metadata.mimeType === "application/vnd.google-apps.document") {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set("mimeType", "text/plain");
    return url;
  }
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

async function fetchDriveFileBuffer(fileId, accessToken, { fetchImpl = fetch } = {}) {
  const metadata = await driveJson(driveMetadataUrl(fileId), accessToken, { fetchImpl });
  const response = await fetchImpl(driveContentUrl(metadata), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const detail = bytes.toString("utf8").slice(0, 500);
    const error = new Error(`Google Drive download failed: ${response.status}`);
    error.status = response.status;
    error.body = detail;
    throw error;
  }
  return {
    metadata,
    buffer: bytes,
    mime_type: metadata.mimeType === "application/vnd.google-apps.document"
      ? "text/plain"
      : (metadata.mimeType || response.headers.get("content-type") || "application/octet-stream"),
  };
}

function assertInsideRoot(filePath, rootPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("resolved transcript path escapes transcript root");
  }
}

async function fetchTranscriptDriveSources(plan, {
  transcriptRoot = DEFAULT_TRANSCRIPT_ROOT,
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  dryRun = false,
  generatedAt = new Date().toISOString(),
  fetchImpl = fetch,
} = {}) {
  const root = path.resolve(transcriptRoot);
  const baseManifest = buildFetchManifest(plan, { transcriptRoot: root, generatedAt });
  if (dryRun || !baseManifest.items.length) return baseManifest;

  const resolvedToken = await resolveGoogleAccessToken({
    accessToken,
    clientId,
    clientSecret,
    refreshToken,
    fetchImpl,
  });
  if (!resolvedToken) throw new Error("Google access token or OAuth refresh credentials are required");

  const fetchedItems = [];
  for (const planned of plannedFetchItems(plan, { transcriptRoot: root })) {
    const item = { ...planned };
    try {
      assertInsideRoot(item.local_path, root);
      const fetched = await fetchDriveFileBuffer(item.drive_file_id, resolvedToken, { fetchImpl });
      fs.mkdirSync(path.dirname(item.local_path), { recursive: true });
      fs.writeFileSync(item.local_path, fetched.buffer);
      item.status = "fetched";
      item.drive_name = fetched.metadata?.name || null;
      item.drive_mime_type = fetched.metadata?.mimeType || null;
      item.mime_type = fetched.mime_type || "text/plain";
      item.size_bytes = fetched.buffer.length;
      item.source_hash = `sha256:${sha256(fetched.buffer)}`;
      item.local_path = undefined;
    } catch (error) {
      item.status = "failed";
      item.error = error?.body?.error_description
        || error?.body?.error?.message
        || error?.message
        || String(error);
      item.local_path = undefined;
    }
    fetchedItems.push(item);
  }

  const fetchedCount = fetchedItems.filter((item) => item.status === "fetched").length;
  const failedCount = fetchedItems.filter((item) => item.status === "failed").length;
  const workerBatch = buildWorkerBatch(fetchedItems, {
    policyVersion: plan?.policy_version || null,
    fetchedAt: generatedAt,
    transcriptRoot: root,
  });

  return {
    ...baseManifest,
    operation_mode: "fetch",
    counts: {
      planned_fetches: fetchedItems.length,
      fetched: fetchedCount,
      failed: failedCount,
      worker_jobs: workerBatch.jobs.length,
    },
    items: fetchedItems,
    worker_batch: workerBatch,
  };
}

function renderFetchSummary(manifest) {
  const lines = [
    "# Transcript Drive Fetch Manifest",
    "",
    `Generated: ${manifest.generated_at}`,
    "",
    "Raw transcript text is not included in this summary. Fetched files, when present, live only under the private transcript root.",
    "",
    "## Counts",
    "",
    `- Planned fetches: ${manifest.counts.planned_fetches}`,
    `- Fetched: ${manifest.counts.fetched}`,
    `- Failed: ${manifest.counts.failed}`,
    `- Worker distill jobs: ${manifest.counts.worker_jobs}`,
    "",
    "## Items",
    "",
    "| Status | Source artifact | Drive file | Local ref | Error |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of manifest.items || []) {
    lines.push(`| ${item.status || ""} | ${item.source_artifact_id || ""} | ${item.drive_file_id || ""} | ${item.local_relative_path || ""} | ${String(item.error || "").replaceAll("|", "\\|")} |`);
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }
  const envFile = arg("--env-file", argv);
  if (envFile) loadEnvFile(envFile, { cwd: ROOT });
  const planPath = path.resolve(arg("--plan", argv) || DEFAULT_PLAN_PATH);
  const transcriptRoot = path.resolve(arg("--transcript-root", argv) || process.env.TRANSCRIPT_ROOT || DEFAULT_TRANSCRIPT_ROOT);
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const batchOutPath = path.resolve(arg("--batch-out", argv) || DEFAULT_BATCH_OUT_PATH);
  const summaryOutPath = arg("--summary-out", argv)
    ? path.resolve(arg("--summary-out", argv))
    : path.join(path.dirname(outPath), "transcript-drive-fetch-summary.md");
  const manifest = await fetchTranscriptDriveSources(readJson(planPath), {
    transcriptRoot,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN,
    clientId: arg("--client-id", argv) || process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: arg("--client-secret", argv) || process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: arg("--refresh-token", argv) || process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    dryRun: hasFlag("--dry-run", argv),
  });
  writeJson(outPath, manifest);
  writeJson(batchOutPath, manifest.worker_batch || { jobs: [] });
  writeText(summaryOutPath, renderFetchSummary(manifest));
  console.log(`prepared transcript Drive fetch (${manifest.counts.fetched}/${manifest.counts.planned_fetches} fetched, ${manifest.counts.failed} failed)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`wrote ${path.relative(ROOT, batchOutPath)}`);
  console.log(`wrote ${path.relative(ROOT, summaryOutPath)}`);
  if (manifest.counts.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildFetchManifest,
  buildWorkerBatch,
  driveContentUrl,
  driveMetadataUrl,
  fetchTranscriptDriveSources,
  parseDriveFileId,
  plannedFetchItems,
  refreshGoogleAccessToken,
  renderFetchSummary,
  safeFileName,
};

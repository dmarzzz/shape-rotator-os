#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { buildProcessingJobsFromSourceArtifacts } = require("./lib/calendar-integration.cjs");
const { loadEnvFile } = require("./lib/env-file.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DEFAULT_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-supabase-plan.json");
const DEFAULT_SESSION_MAP_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-session-map.json");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-transcript-supabase-plan.mjs --org-id ORG_ID [--env-file .env.calendar.local] [--plan import-plan.json] [--session-map session-map.json] [--out supabase-plan.json] [--summary-out summary.md]",
    "",
    "Builds a dry-run Supabase bridge plan from the transcript vault import plan.",
    "Only strong, non-review transcript refs with a resolved session_id become apply-ready rows.",
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

function sourceArtifactId({ orgId, driveFileId }) {
  return stableUuid(`transcript-vault-source:${orgId}:${driveFileId}`);
}

function normalizeSessionMap(rawMap) {
  if (!rawMap) return {};
  if (rawMap.session_map && typeof rawMap.session_map === "object") {
    return rawMap.session_map;
  }
  if (Array.isArray(rawMap)) {
    return {
      by_drive_file_id: Object.fromEntries(rawMap
        .filter((item) => item?.drive_file_id && (item.session_id || item.id))
        .map((item) => [item.drive_file_id, item.session_id || item.id])),
    };
  }
  return rawMap;
}

function mappedValue(map, bucketName, key) {
  if (!key) return null;
  const bucket = map?.[bucketName];
  const value = bucket?.[key] || map?.[key];
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.session_id || value.id || null;
}

function resolveSessionId(file, sessionMap) {
  return mappedValue(sessionMap, "by_drive_file_id", file.drive_file_id)
    || mappedValue(sessionMap, "by_storage_ref", file.source_artifact_manifest?.storage_ref)
    || mappedValue(sessionMap, "by_vault_id", file.vault_id)
    || mappedValue(sessionMap, "by_preferred_drive_name", file.preferred_drive_name)
    || mappedValue(sessionMap, "by_canonical_name", file.canonical_name)
    || mappedValue(sessionMap, "by_original_name", file.original_name)
    || null;
}

function isStrongSourceCandidate(file) {
  return !!file?.source_artifact_manifest
    && file.needs_manual_review !== true
    && file.calendar_match?.status === "matched";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== null && entry !== undefined),
  );
}

function confidenceMetadataForFile(file) {
  const manifest = file.source_artifact_manifest || {};
  const assessment = file.classification_confidence || manifest.confidence_assessment || null;
  return compactObject({
    confidence_schema_version: 1,
    type_confidence_pct: numberOrNull(file.type_confidence_pct ?? manifest.type_confidence_pct ?? assessment?.type_pct),
    group_confidence_pct: numberOrNull(file.group_confidence_pct ?? manifest.group_confidence_pct ?? assessment?.group_pct),
    understanding_confidence_pct: numberOrNull(file.understanding_confidence_pct ?? manifest.understanding_confidence_pct ?? assessment?.understanding_pct),
    calendar_confidence_pct: numberOrNull(file.calendar_match?.confidence_pct ?? assessment?.calendar_pct),
    source_confidence_pct: numberOrNull(file.source_confidence_pct ?? manifest.source_confidence_pct ?? assessment?.source_pct),
    confidence_label: assessment?.label || null,
    confidence_basis: assessment?.basis || null,
    source_system: file.source_system || manifest.source_system || null,
    source_provider: file.source_provider || manifest.source_provider || null,
    source_confidence: file.source_confidence || manifest.source_confidence || null,
    inferred_session_type: file.inferred_session_type || manifest.inferred_session_type || null,
    inferred_date: file.inferred_date || manifest.inferred_date || null,
    calendar_status: file.calendar_match?.status || null,
    calendar_confidence: file.calendar_match?.confidence || null,
    target_drive_route: file.drive_route?.path || manifest.target_drive_route || null,
    derived_drive_route: file.drive_route?.derived_path || null,
    preferred_drive_name: file.preferred_drive_name || null,
  });
}

function sourceRowForFile({ file, orgId, sessionId }) {
  const manifest = file.source_artifact_manifest || {};
  return {
    id: sourceArtifactId({ orgId, driveFileId: file.drive_file_id }),
    org_id: orgId,
    session_id: sessionId,
    source_kind: manifest.source_kind || manifest.kind || "drive_doc",
    source_tier: manifest.source_tier || "T0",
    storage_mode: manifest.storage_mode || "external_ref",
    storage_ref: manifest.storage_ref || (file.drive_file_id ? `drive://${file.drive_file_id}` : null),
    source_hash: manifest.source_hash || null,
    mime_type: manifest.mime_type || file.mime_type || null,
    size_bytes: manifest.size_bytes || null,
    raw_available_to_server: manifest.raw_available_to_server === true,
    metadata: confidenceMetadataForFile(file),
  };
}

function ingestionEventForFile({ file, orgId, sessionId, sourceArtifact, generatedAt }) {
  return {
    org_id: orgId,
    session_id: sessionId,
    provider: "manual",
    event_type: `${sourceArtifact.source_kind}.submitted`,
    resource_name: sourceArtifact.storage_ref,
    event_json: {
      provider: "manual",
      source: "transcript_vault",
      source_artifact_id: sourceArtifact.id,
      source_kind: sourceArtifact.source_kind,
      source_system: file.source_system || file.source_artifact_manifest?.source_system || null,
      source_provider: file.source_provider || file.source_artifact_manifest?.source_provider || null,
      source_confidence: file.source_confidence || file.source_artifact_manifest?.source_confidence || null,
      source_confidence_pct: file.source_confidence_pct || file.source_artifact_manifest?.source_confidence_pct || null,
      storage_mode: sourceArtifact.storage_mode,
      storage_ref: sourceArtifact.storage_ref,
      drive_file_id: file.drive_file_id || null,
      drive_url: file.drive_url || null,
      original_name: file.original_name || null,
      preferred_drive_name: file.preferred_drive_name || null,
      target_drive_route: file.drive_route?.path || null,
      derived_drive_route: file.drive_route?.derived_path || null,
      inferred_session_type: file.inferred_session_type || null,
      inferred_date: file.inferred_date || null,
      calendar_status: file.calendar_match?.status || null,
      calendar_confidence: file.calendar_match?.confidence || null,
      calendar_confidence_pct: file.calendar_match?.confidence_pct || null,
      type_confidence_pct: file.type_confidence_pct || file.source_artifact_manifest?.type_confidence_pct || null,
      group_confidence_pct: file.group_confidence_pct || file.source_artifact_manifest?.group_confidence_pct || null,
      understanding_confidence_pct: file.understanding_confidence_pct || file.source_artifact_manifest?.understanding_confidence_pct || null,
      confidence_basis: file.classification_confidence?.basis || file.source_artifact_manifest?.confidence_assessment?.basis || null,
      max_tier: file.routing?.max_tier || null,
    },
    processing_status: "processed",
    received_at: generatedAt,
    processed_at: generatedAt,
  };
}

function linkQueueRow(file) {
  return {
    drive_file_id: file.drive_file_id,
    storage_ref: file.source_artifact_manifest?.storage_ref || (file.drive_file_id ? `drive://${file.drive_file_id}` : null),
    original_name: file.original_name,
    preferred_drive_name: file.preferred_drive_name,
    inferred_session_type: file.inferred_session_type,
    inferred_date: file.inferred_date,
    calendar_status: file.calendar_match?.status || null,
    calendar_confidence: file.calendar_match?.confidence || null,
    calendar_confidence_pct: file.calendar_match?.confidence_pct || null,
    type_confidence_pct: file.type_confidence_pct || null,
    group_confidence_pct: file.group_confidence_pct || null,
    understanding_confidence_pct: file.understanding_confidence_pct || null,
    matched_tokens: file.calendar_match?.matched_tokens || [],
    target_drive_route: file.drive_route?.path || null,
    reason: "session_id_required_before_queueing_processing_job",
  };
}

function reviewQueueRow(file) {
  return {
    drive_file_id: file.drive_file_id,
    original_name: file.original_name,
    preferred_drive_name: file.preferred_drive_name,
    inferred_session_type: file.inferred_session_type,
    inferred_date: file.inferred_date,
    calendar_status: file.calendar_match?.status || null,
    calendar_confidence_pct: file.calendar_match?.confidence_pct || null,
    type_confidence_pct: file.type_confidence_pct || null,
    group_confidence_pct: file.group_confidence_pct || null,
    understanding_confidence_pct: file.understanding_confidence_pct || null,
    target_drive_route: file.drive_route?.path || null,
    manual_review_reasons: file.manual_review_reasons || [],
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item) || "none";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildTranscriptSupabasePlan(importPlan, {
  orgId,
  sessionMap,
  generatedAt = new Date().toISOString(),
  processorMode = "local",
} = {}) {
  if (!importPlan || typeof importPlan !== "object") throw new Error("import plan is required");
  if (!orgId) throw new Error("orgId is required");

  const normalizedSessionMap = normalizeSessionMap(sessionMap);
  const sourceArtifacts = [];
  const ingestionEvents = [];
  const sessionLinkQueue = [];
  const manualReviewQueue = [];
  const skippedFiles = [];

  for (const file of importPlan.files || []) {
    if (isStrongSourceCandidate(file)) {
      const sessionId = resolveSessionId(file, normalizedSessionMap);
      if (!sessionId) {
        sessionLinkQueue.push(linkQueueRow(file));
        continue;
      }
      const sourceArtifact = sourceRowForFile({ file, orgId, sessionId });
      sourceArtifacts.push(sourceArtifact);
      ingestionEvents.push(ingestionEventForFile({
        file,
        orgId,
        sessionId,
        sourceArtifact,
        generatedAt,
      }));
      continue;
    }
    if (file.source_artifact_manifest) {
      manualReviewQueue.push(reviewQueueRow(file));
    } else {
      skippedFiles.push(reviewQueueRow(file));
    }
  }

  const processingJobs = buildProcessingJobsFromSourceArtifacts({
    orgId,
    sourceArtifacts,
    policyVersion: importPlan.policy?.version || importPlan.policy?.policy_version || importPlan.policy?.policyVersion || null,
    processorMode,
  });

  return {
    generated_at: generatedAt,
    operation_mode: "dry_run",
    source_plan_generated_at: importPlan.generated_at || null,
    org_id: orgId,
    policy_version: importPlan.policy?.version || importPlan.policy?.policy_version || importPlan.policy?.policyVersion || null,
    source_drive: importPlan.source_drive || {},
    counts: {
      total_files: (importPlan.files || []).length,
      strong_source_candidates: (importPlan.files || []).filter(isStrongSourceCandidate).length,
      ready_source_artifacts: sourceArtifacts.length,
      session_link_required: sessionLinkQueue.length,
      manual_review_required: manualReviewQueue.length,
      skipped_files: skippedFiles.length,
      ingestion_events: ingestionEvents.length,
      processing_jobs: processingJobs.length,
      by_job_kind: countBy(processingJobs, (job) => job.job_kind),
      by_review_reason: countBy(
        manualReviewQueue.flatMap((item) => item.manual_review_reasons || []),
        (reason) => reason,
      ),
    },
    apply_rows: {
      ingestionEvents,
      sourceArtifacts,
      processingJobs,
    },
    ingestionEvents,
    sourceArtifacts,
    processingJobs,
    session_link_queue: sessionLinkQueue,
    manual_review_queue: manualReviewQueue,
    skipped_files: skippedFiles,
  };
}

export function renderTranscriptSupabaseSummary(plan) {
  const lines = [
    "# Transcript Supabase Bridge Plan",
    "",
    `Generated: ${plan.generated_at}`,
    "",
    "This is a dry-run plan. It does not mutate Supabase or read raw transcript text.",
    "",
    "## Counts",
    "",
    `- Files: ${plan.counts.total_files}`,
    `- Strong source candidates: ${plan.counts.strong_source_candidates}`,
    `- Apply-ready source artifacts: ${plan.counts.ready_source_artifacts}`,
    `- Session-link required: ${plan.counts.session_link_required}`,
    `- Manual-review required: ${plan.counts.manual_review_required}`,
    `- Skipped files: ${plan.counts.skipped_files}`,
    `- Ingestion events: ${plan.counts.ingestion_events}`,
    `- Processing jobs: ${plan.counts.processing_jobs}`,
    "",
    "## Apply-Ready Rows",
    "",
    "| Source artifact | Session | Storage ref | Job |",
    "| --- | --- | --- | --- |",
  ];
  const jobsBySource = new Map((plan.processingJobs || []).map((job) => [job.source_artifact_id, job]));
  for (const artifact of plan.sourceArtifacts || []) {
    const job = jobsBySource.get(artifact.id);
    lines.push(`| ${artifact.id} | ${artifact.session_id || ""} | ${artifact.storage_ref || ""} | ${job?.job_kind || ""} |`);
  }

  lines.push("", "## Session Link Queue", "");
  lines.push("| File | Type | Type % | Group % | Understanding % | Date | Reason |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- |");
  for (const item of plan.session_link_queue || []) {
    lines.push(`| ${String(item.preferred_drive_name || item.original_name || "").replaceAll("|", "\\|")} | ${item.inferred_session_type || ""} | ${item.type_confidence_pct || 0}% | ${item.group_confidence_pct || 0}% | ${item.understanding_confidence_pct || 0}% | ${item.inferred_date || ""} | ${item.reason} |`);
  }

  lines.push("", "## Manual Review Queue", "");
  lines.push("| File | Proposed type | Type % | Group % | Understanding % | Date | Reasons |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- |");
  for (const item of plan.manual_review_queue || []) {
    lines.push(`| ${String(item.preferred_drive_name || item.original_name || "").replaceAll("|", "\\|")} | ${item.inferred_session_type || ""} | ${item.type_confidence_pct || 0}% | ${item.group_confidence_pct || 0}% | ${item.understanding_confidence_pct || 0}% | ${item.inferred_date || ""} | ${String((item.manual_review_reasons || []).join(", ")).replaceAll("|", "\\|")} |`);
  }

  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }
  const envFile = arg("--env-file", argv);
  if (envFile) loadEnvFile(envFile, { cwd: ROOT });
  const orgId = arg("--org-id", argv) || process.env.ORG_ID;
  if (!orgId) {
    console.error(usage());
    process.exit(2);
  }
  const planPath = path.resolve(arg("--plan", argv) || DEFAULT_PLAN_PATH);
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const summaryOutPath = arg("--summary-out", argv)
    ? path.resolve(arg("--summary-out", argv))
    : path.join(path.dirname(outPath), "transcript-supabase-summary.md");
  const sessionMapPath = arg("--session-map", argv) || (fs.existsSync(DEFAULT_SESSION_MAP_PATH) ? DEFAULT_SESSION_MAP_PATH : null);
  const plan = buildTranscriptSupabasePlan(readJson(planPath), {
    orgId,
    sessionMap: sessionMapPath ? readJson(sessionMapPath) : null,
  });
  writeJson(outPath, plan);
  writeText(summaryOutPath, renderTranscriptSupabaseSummary(plan));
  console.log(`prepared transcript Supabase bridge (${plan.counts.ready_source_artifacts} ready, ${plan.counts.session_link_required} need session links, ${plan.counts.manual_review_required} review-held)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`wrote ${path.relative(ROOT, summaryOutPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

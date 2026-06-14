#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IMPORT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DEFAULT_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-session-map.json");

const STOPWORDS = new Set([
  "and",
  "copy",
  "demo",
  "file",
  "hours",
  "meet",
  "meeting",
  "notes",
  "office",
  "part",
  "presentation",
  "project",
  "raw",
  "salon",
  "session",
  "standup",
  "transcript",
  "txt",
  "weekly",
  "with",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-transcript-session-map.mjs --env-file .env.calendar.local [--plan import-plan.json] [--sessions sessions.json] [--out session-map.json] [--summary-out summary.md]",
    "",
    "Builds a dry-run transcript-to-session map. Only high-confidence same-day title matches are safe for automatic source_artifact linkage.",
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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function dateOf(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : null;
}

function fileMatchText(file) {
  return [
    file.preferred_drive_name,
    file.canonical_name,
    file.vault_id,
    file.calendar_match?.matched_tokens?.join(" "),
  ].filter(Boolean).join(" ");
}

function sessionMatchText(session) {
  return [
    session.title,
    session.public_title,
    session.session_type,
  ].filter(Boolean).join(" ");
}

function isTranscriptCandidate(file) {
  return !!file?.source_artifact_manifest
    && file.needs_manual_review !== true
    && file.calendar_match?.status === "matched";
}

function scoreCandidate(file, session) {
  const fileTokens = [...new Set(tokens(fileMatchText(file)))];
  const sessionTokens = new Set(tokens(sessionMatchText(session)));
  const matchedTokens = fileTokens.filter((token) => sessionTokens.has(token));
  const score = matchedTokens.length * 10;
  return {
    session_id: session.id,
    title: session.title,
    public_title: session.public_title || null,
    session_type: session.session_type || null,
    starts_at: session.starts_at || null,
    matched_tokens: matchedTokens,
    score,
  };
}

function bestCandidate(file, sessions) {
  const fileDate = file.inferred_date || file.calendar_match?.date || file.calendar_match?.inferred_date || null;
  const sameDay = (sessions || []).filter((session) => dateOf(session.starts_at) === fileDate);
  const scored = sameDay
    .map((session) => scoreCandidate(file, session))
    .filter((candidate) => candidate.session_id)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
  const best = scored[0] || null;
  const safe = !!best && best.score >= 20 && best.matched_tokens.length >= 2;
  return {
    safe,
    confidence: safe ? "high" : scored.length ? "review" : "none",
    candidates: scored.slice(0, 5),
  };
}

function reviewReason(match) {
  if (!match.candidates.length) return "no_same_day_session";
  const best = match.candidates[0];
  if (!best.matched_tokens.length) return "date_bucket_session_only";
  return "weak_title_token_match";
}

export function buildTranscriptSessionMap(importPlan, sessions, { generatedAt = new Date().toISOString() } = {}) {
  if (!importPlan || typeof importPlan !== "object") throw new Error("import plan is required");
  if (!Array.isArray(sessions)) throw new Error("sessions array is required");

  const safeLinks = [];
  const reviewLinks = [];
  const byDriveFileId = {};
  const byStorageRef = {};
  const byPreferredDriveName = {};
  const byVaultId = {};

  for (const file of importPlan.files || []) {
    if (!isTranscriptCandidate(file)) continue;
    const match = bestCandidate(file, sessions);
    const row = {
      drive_file_id: file.drive_file_id,
      storage_ref: file.source_artifact_manifest?.storage_ref || (file.drive_file_id ? `drive://${file.drive_file_id}` : null),
      vault_id: file.vault_id || null,
      preferred_drive_name: file.preferred_drive_name || null,
      inferred_date: file.inferred_date || null,
      inferred_session_type: file.inferred_session_type || null,
      calendar_status: file.calendar_match?.status || null,
      confidence: match.confidence,
      candidates: match.candidates,
    };
    if (match.safe) {
      const sessionId = match.candidates[0].session_id;
      safeLinks.push({ ...row, session_id: sessionId, matched_tokens: match.candidates[0].matched_tokens });
      if (file.drive_file_id) byDriveFileId[file.drive_file_id] = sessionId;
      if (row.storage_ref) byStorageRef[row.storage_ref] = sessionId;
      if (file.preferred_drive_name) byPreferredDriveName[file.preferred_drive_name] = sessionId;
      if (file.vault_id) byVaultId[file.vault_id] = sessionId;
    } else {
      reviewLinks.push({ ...row, review_reason: reviewReason(match) });
    }
  }

  return {
    generated_at: generatedAt,
    operation_mode: "dry_run",
    source_plan_generated_at: importPlan.generated_at || null,
    counts: {
      transcript_candidates: safeLinks.length + reviewLinks.length,
      safe_links: safeLinks.length,
      review_links: reviewLinks.length,
      sessions_considered: sessions.length,
    },
    session_map: {
      by_drive_file_id: byDriveFileId,
      by_storage_ref: byStorageRef,
      by_preferred_drive_name: byPreferredDriveName,
      by_vault_id: byVaultId,
    },
    safe_links: safeLinks,
    review_links: reviewLinks,
  };
}

export function renderTranscriptSessionMapSummary(plan) {
  const lines = [
    "# Transcript Session Map Plan",
    "",
    `Generated: ${plan.generated_at}`,
    "",
    "This is a dry-run plan. It does not mutate Supabase or Google Drive.",
    "",
    "## Counts",
    "",
    `- Transcript candidates: ${plan.counts.transcript_candidates}`,
    `- Safe session links: ${plan.counts.safe_links}`,
    `- Review session links: ${plan.counts.review_links}`,
    `- Supabase sessions considered: ${plan.counts.sessions_considered}`,
    "",
    "## Safe Links",
    "",
    "| File | Session | Matched tokens |",
    "| --- | --- | --- |",
  ];
  for (const item of plan.safe_links || []) {
    const session = item.candidates?.[0];
    lines.push(`| ${String(item.preferred_drive_name || item.drive_file_id || "").replaceAll("|", "\\|")} | ${String(session?.title || item.session_id || "").replaceAll("|", "\\|")} | ${(item.matched_tokens || []).join(", ")} |`);
  }

  lines.push("", "## Review Links", "");
  lines.push("| File | Date | Reason | Best candidate | Tokens |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of plan.review_links || []) {
    const best = item.candidates?.[0];
    lines.push(`| ${String(item.preferred_drive_name || item.drive_file_id || "").replaceAll("|", "\\|")} | ${item.inferred_date || ""} | ${item.review_reason || ""} | ${String(best?.title || "").replaceAll("|", "\\|")} | ${(best?.matched_tokens || []).join(", ")} |`);
  }
  return lines.join("\n");
}

async function fetchSessionsFromSupabase({ supabaseUrl, serviceRoleKey, orgId } = {}) {
  if (!supabaseUrl || !serviceRoleKey || !orgId) {
    throw new Error("--env-file or env must provide SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ORG_ID when --sessions is omitted");
  }
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    query: {
      select: "id,title,public_title,session_type,starts_at,ends_at,google_event_id,transcript_status",
      org_id: `eq.${orgId}`,
      order: "starts_at.asc",
      limit: "500",
    },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }
  const envFile = arg("--env-file", argv);
  if (envFile) loadEnvFile(envFile, { cwd: ROOT });
  const importPlanPath = path.resolve(arg("--plan", argv) || DEFAULT_IMPORT_PLAN_PATH);
  const sessionsPath = arg("--sessions", argv);
  const sessions = sessionsPath
    ? readJson(sessionsPath)
    : await fetchSessionsFromSupabase({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      orgId: process.env.ORG_ID,
    });
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const summaryOutPath = arg("--summary-out", argv)
    ? path.resolve(arg("--summary-out", argv))
    : path.join(path.dirname(outPath), "transcript-session-map-summary.md");
  const plan = buildTranscriptSessionMap(readJson(importPlanPath), sessions);
  writeJson(outPath, plan);
  writeText(summaryOutPath, renderTranscriptSessionMapSummary(plan));
  console.log(`prepared transcript session map (${plan.counts.safe_links} safe, ${plan.counts.review_links} review)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`wrote ${path.relative(ROOT, summaryOutPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

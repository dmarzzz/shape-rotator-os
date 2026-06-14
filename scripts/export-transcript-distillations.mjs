#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, "cohort-data", "artifacts", "transcript-distillations", "generated", "manifest.json");

const FORBIDDEN_PATTERNS = [
  /raw-scripts[\\/]/i,
  /local_private[\\/]/i,
  /\b[A-Z]:[\\/]+Users[\\/]/i,
  /\/Users\/[^/\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\bSpeaker\s+\d+\s+\d{1,2}:\d{2}\b/i,
];

function usage() {
  return [
    "Usage:",
    "  node scripts/export-transcript-distillations.mjs --env-file .env.calendar.local [--out manifest.json] [--include-needs-review]",
    "",
    "Exports app-safe Supabase derived transcript artifacts into a generated manifest.",
    "By default, only reviewed/published T2 rows and published+approved T3 rows are exported.",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function compactText(value, max = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function assertNoRawLeak(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const matched = FORBIDDEN_PATTERNS.find((pattern) => pattern.test(text));
  if (matched) throw new Error(`${label} contains raw or private transcript material matching ${matched}`);
}

function exportableByDefault(row) {
  if (row.tier === "T2") return row.review_status === "reviewed" || row.review_status === "published";
  if (row.tier === "T3") return row.review_status === "published" && row.approval_state === "approved";
  return false;
}

function surfaceFor(row) {
  if (row.tier === "T3" && row.review_status === "published" && row.approval_state === "approved") return "public";
  if (row.tier === "T2") return "cohort";
  return "operator_review";
}

function normalizeDerivedArtifact(row, sessionById = new Map()) {
  const session = sessionById.get(String(row.session_id || "")) || {};
  const distillation = row.content_json?.distillation && typeof row.content_json.distillation === "object"
    ? row.content_json.distillation
    : {};
  const normalized = {
    artifact_id: row.id,
    artifact_kind: row.artifact_kind || "readout",
    session_id: row.session_id,
    session_title: session.public_title || session.title || row.content_json?.title || "Session readout",
    session_type: session.session_type || row.content_json?.session_type || null,
    starts_at: session.starts_at || null,
    tier: row.tier,
    surface: surfaceFor(row),
    review_status: row.review_status,
    approval_state: row.approval_state,
    confidence: row.confidence,
    source_transform: row.source_transform,
    summary: asArray(distillation.summary).map((item) => compactText(item)),
    themes: asArray(distillation.themes).map((item) => compactText(item, 120)),
    action_items: asArray(distillation.action_items).map((item) => compactText(item)),
    open_questions: asArray(distillation.open_questions).map((item) => compactText(item)),
    content_md: row.content_md || "",
    provenance: {
      source_artifact_id: row.source_artifact_id || null,
      processing_job_id: row.processing_job_id || null,
      raw_allowed: false,
      source_access: "private-vault",
    },
    created_at: row.created_at || null,
  };
  assertNoRawLeak(normalized, `derived artifact ${row.id}`);
  return normalized;
}

function buildDistillationManifest(rows, sessions = [], {
  generatedAt = new Date().toISOString(),
  includeNeedsReview = false,
  blockedArtifactIds = new Set(),
} = {}) {
  const sessionById = new Map(sessions.map((session) => [String(session.id), session]));
  // S5-5: re-check live gate status at export time. A distillation that was
  // legitimately published+approved and then had a gate retroactively flipped
  // (e.g. consent withdrawn) must NOT be re-exported just because its own
  // approval_state still reads 'approved' — exclude any artifact with a
  // non-cleared approval gate.
  const blocked = blockedArtifactIds instanceof Set ? blockedArtifactIds : new Set(blockedArtifactIds);
  const selectedRows = rows.filter(
    (row) => !blocked.has(String(row.id)) && (includeNeedsReview || exportableByDefault(row)),
  );
  const artifacts = selectedRows
    .map((row) => normalizeDerivedArtifact(row, sessionById))
    .sort((a, b) => `${a.starts_at || ""}:${a.artifact_id}`.localeCompare(`${b.starts_at || ""}:${b.artifact_id}`));
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "supabase.derived_artifacts",
    default_export_policy: includeNeedsReview
      ? "operator review export; includes needs_review rows"
      : "T2 reviewed/published and T3 published+approved only",
    artifact_count: artifacts.length,
    cohort_count: artifacts.filter((item) => item.surface === "cohort").length,
    public_count: artifacts.filter((item) => item.surface === "public").length,
    operator_review_count: artifacts.filter((item) => item.surface === "operator_review").length,
    artifacts,
  };
}

async function fetchDerivedArtifacts({ supabaseUrl, serviceRoleKey, orgId, fetchImpl = fetch }) {
  return await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "derived_artifacts",
    query: {
      select: "id,session_id,source_artifact_id,processing_job_id,artifact_kind,tier,source_transform,review_status,approval_state,confidence,content_json,content_md,created_at",
      org_id: `eq.${orgId}`,
      order: "created_at.desc",
    },
    fetchImpl,
  });
}

async function fetchSessions({ supabaseUrl, serviceRoleKey, sessionIds, fetchImpl = fetch }) {
  const ids = Array.from(new Set(asArray(sessionIds).map(String).filter(Boolean)));
  if (!ids.length) return [];
  return await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    query: {
      select: "id,title,public_title,session_type,starts_at",
      id: `in.(${ids.join(",")})`,
    },
    fetchImpl,
  });
}

async function fetchBlockedArtifactIds({ supabaseUrl, serviceRoleKey, artifactIds, fetchImpl = fetch }) {
  const ids = Array.from(new Set(asArray(artifactIds).map(String).filter(Boolean)));
  if (!ids.length) return new Set();
  const gates = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "approval_gates",
    query: {
      select: "derived_artifact_id,gate_status",
      derived_artifact_id: `in.(${ids.join(",")})`,
      gate_status: "not.in.(approved,not_required)",
    },
    fetchImpl,
  });
  return new Set(asArray(gates).map((gate) => String(gate.derived_artifact_id || "")).filter(Boolean));
}

function writeManifest(outPath, manifest) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  if (hasFlag("--help", argv) || hasFlag("-h", argv)) {
    console.log(usage());
    return;
  }
  const envFile = arg("--env-file", argv);
  if (envFile) loadEnvFile(envFile, { env: process.env });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const orgId = process.env.ORG_ID;
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  if (!orgId) throw new Error("ORG_ID is required");

  const rows = await fetchDerivedArtifacts({ supabaseUrl, serviceRoleKey, orgId });
  const blockedArtifactIds = await fetchBlockedArtifactIds({
    supabaseUrl,
    serviceRoleKey,
    artifactIds: rows.map((row) => row.id),
  });
  const sessions = await fetchSessions({
    supabaseUrl,
    serviceRoleKey,
    sessionIds: rows.map((row) => row.session_id),
  });
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT);
  const manifest = buildDistillationManifest(rows, sessions, {
    includeNeedsReview: hasFlag("--include-needs-review", argv),
    blockedArtifactIds,
  });
  writeManifest(outPath, manifest);
  console.log(JSON.stringify({
    ok: true,
    out: path.relative(ROOT, outPath).replace(/\\/g, "/"),
    artifact_count: manifest.artifact_count,
    cohort_count: manifest.cohort_count,
    public_count: manifest.public_count,
    operator_review_count: manifest.operator_review_count,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildDistillationManifest,
  exportableByDefault,
  normalizeDerivedArtifact,
};

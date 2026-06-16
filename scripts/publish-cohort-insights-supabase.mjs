#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "./lib/env-file.cjs";
import { executeSupabaseRequests } from "./lib/supabase-rest.cjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(ROOT, "cohort-data", "artifacts", "cohort-insights", "generated", "manifest.json");

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/publish-cohort-insights-supabase.mjs --org-id ORG_ID --supabase-url URL",
    "  node scripts/publish-cohort-insights-supabase.mjs --org-id ORG_ID --env-file .env.calendar.local --apply",
    "",
    "Dry-run mode prints the PostgREST upsert request. --apply requires SUPABASE_SERVICE_ROLE_KEY.",
  ].join("\n");
}

function readOptions(argv = process.argv.slice(2), env = process.env) {
  return {
    help: hasArg(argv, "--help") || hasArg(argv, "-h"),
    apply: hasArg(argv, "--apply"),
    input: path.resolve(arg(argv, "--input", DEFAULT_INPUT)),
    envFile: arg(argv, "--env-file"),
    orgId: arg(argv, "--org-id", env.SHAPE_SUPABASE_ORG_ID || env.ORG_ID),
    supabaseUrl: arg(argv, "--supabase-url", env.SHAPE_SUPABASE_URL || env.SUPABASE_URL),
    serviceRoleKey: arg(argv, "--service-role-key", env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

function readManifest(inputPath = DEFAULT_INPUT) {
  const manifest = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (manifest?.artifact_kind !== "cohort_insight_bundle") {
    throw new Error(`expected cohort_insight_bundle manifest at ${inputPath}`);
  }
  return manifest;
}

function normalizeApprovalState(value) {
  const state = String(value || "not_reviewed").trim();
  return state || "not_reviewed";
}

function cardToSupabaseRow(card, { orgId, generatedAt = null } = {}) {
  if (!orgId) throw new Error("orgId is required");
  if (!card?.id) throw new Error("card id is required");
  return {
    org_id: orgId,
    id: String(card.id),
    kind: String(card.kind || ""),
    subject_type: String(card.subject_type || ""),
    subject_ids: Array.isArray(card.subject_ids) ? card.subject_ids.map(String) : [],
    title: String(card.title || ""),
    claim_text: String(card.claim_text || ""),
    summary: card.summary == null ? null : String(card.summary),
    evidence_level: String(card.evidence_level || ""),
    confidence: String(card.confidence || "low"),
    surface_tier: String(card.surface_tier || "cohort"),
    source_boundary: String(card.source_boundary || "public_bundle"),
    review_status: String(card.review_status || "generated"),
    approval_state: normalizeApprovalState(card.approval_state),
    raw_allowed: false,
    source_refs: Array.isArray(card.source_refs) ? card.source_refs : [],
    content_json: card.content_json && typeof card.content_json === "object" && !Array.isArray(card.content_json)
      ? card.content_json
      : {},
    generated_by: String(card.generated_by || "scripts/lib/cohort-insight-engine.cjs"),
    generated_at: generatedAt || null,
  };
}

function manifestToSupabaseRows(manifest, { orgId } = {}) {
  const generatedAt = manifest.generated_at || null;
  return (Array.isArray(manifest.cards) ? manifest.cards : []).map(card => cardToSupabaseRow(card, { orgId, generatedAt }));
}

function trimBaseUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("supabaseUrl is required");
  return url;
}

function buildCohortInsightUpsertRequest({ supabaseUrl, rows }) {
  const body = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!body.length) return null;
  const url = new URL(`${trimBaseUrl(supabaseUrl)}/rest/v1/cohort_insight_cards`);
  url.searchParams.set("on_conflict", "org_id,id");
  return {
    table: "cohort_insight_cards",
    method: "POST",
    url: String(url),
    headers: {
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body,
  };
}

async function main(argv = process.argv.slice(2)) {
  const preOptions = readOptions(argv);
  if (preOptions.help) {
    console.log(usage());
    return;
  }
  if (preOptions.envFile) loadEnvFile(preOptions.envFile);
  const options = readOptions(argv);
  if (!options.orgId || !options.supabaseUrl) {
    console.error(usage());
    process.exit(2);
  }

  const manifest = readManifest(options.input);
  const rows = manifestToSupabaseRows(manifest, { orgId: options.orgId });
  const request = buildCohortInsightUpsertRequest({ supabaseUrl: options.supabaseUrl, rows });
  const requests = request ? [request] : [];
  if (!options.apply) {
    process.stdout.write(JSON.stringify({
      ok: true,
      apply: false,
      row_count: rows.length,
      requests,
    }, null, 2) + "\n");
    return;
  }

  if (!options.serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY or --service-role-key is required with --apply");
    process.exit(2);
  }
  const results = await executeSupabaseRequests({
    requests,
    serviceRoleKey: options.serviceRoleKey,
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    apply: true,
    row_count: rows.length,
    results: results.map(result => ({
      table: result.table,
      status: result.status,
      row_count: Array.isArray(result.rows) ? result.rows.length : null,
    })),
  }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildCohortInsightUpsertRequest,
  cardToSupabaseRow,
  main,
  manifestToSupabaseRows,
  readManifest,
};

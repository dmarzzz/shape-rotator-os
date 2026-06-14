#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvFile } = require("./lib/env-file.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-worker-vault-secrets.sql");
const DEFAULT_SUMMARY_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-worker-vault-secrets-summary.md");

const SECRET_NAMES = {
  projectUrl: "shape_transcript_worker_project_url",
  workerToken: "shape_transcript_worker_token",
  orgId: "shape_transcript_worker_org_id",
  limit: "shape_transcript_worker_limit",
};

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-transcript-worker-vault-sql.mjs --env-file .env.calendar.local [--out private.sql] [--summary-out summary.md] [--limit 5]",
    "",
    "Writes an ignored SQL file that seeds Supabase Vault secrets for the transcript worker cron job.",
    "The SQL file contains secret values. Keep it under cohort-data/.private/ and do not print it.",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function requireValue(value, label) {
  const out = String(value || "").trim();
  if (!out) throw new Error(`${label} is required`);
  return out;
}

function secretRowSql({ value, name, description }) {
  return `select vault.create_secret(${sqlString(value)}, ${sqlString(name)}, ${sqlString(description)});`;
}

function buildVaultSecretSql({
  projectUrl,
  workerToken,
  orgId,
  limit = 5,
}) {
  const rows = [
    {
      value: requireValue(projectUrl, "SUPABASE_URL"),
      name: SECRET_NAMES.projectUrl,
      description: "Shape Rotator transcript worker Supabase project URL",
    },
    {
      value: requireValue(workerToken, "TRANSCRIPT_WORKER_TOKEN"),
      name: SECRET_NAMES.workerToken,
      description: "Shape Rotator transcript worker bearer token",
    },
    {
      value: requireValue(orgId, "ORG_ID"),
      name: SECRET_NAMES.orgId,
      description: "Shape Rotator transcript worker org id",
    },
    {
      value: String(Math.max(1, Math.min(25, Number(limit) || 5))),
      name: SECRET_NAMES.limit,
      description: "Shape Rotator transcript worker jobs per cron tick",
    },
  ];

  return [
    "-- Private operator SQL. Contains secret values; do not commit.",
    "-- Run after applying supabase/migrations/202606130001_transcript_worker_schedule.sql.",
    "begin;",
    `delete from vault.secrets where name in (${Object.values(SECRET_NAMES).map(sqlString).join(", ")});`,
    ...rows.map(secretRowSql),
    "commit;",
    "",
    "select private.ensure_process_transcript_jobs_schedule();",
    "",
    "-- Optional smoke test; returns a pg_net request id if the Vault secrets are readable.",
    "-- select private.invoke_process_transcript_jobs();",
    "",
  ].join("\n");
}

function buildSummary({ outPath, summaryPath, limit }) {
  return [
    "# Transcript Worker Vault SQL",
    "",
    `Generated private SQL: \`${path.relative(ROOT, outPath).replace(/\\/g, "/")}\``,
    `Summary file: \`${path.relative(ROOT, summaryPath).replace(/\\/g, "/")}\``,
    "",
    "Vault secret names:",
    ...Object.values(SECRET_NAMES).map((name) => `- \`${name}\``),
    "",
    `Worker limit per cron tick: ${Math.max(1, Math.min(25, Number(limit) || 5))}`,
    "",
    "This summary intentionally omits secret values. The SQL file is ignored under `cohort-data/.private/`.",
  ].join("\n");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

async function main(argv = process.argv.slice(2)) {
  if (hasFlag("--help", argv) || hasFlag("-h", argv)) {
    console.log(usage());
    return;
  }
  const envFile = arg("--env-file", argv);
  if (envFile) loadEnvFile(envFile, { env: process.env });
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const summaryPath = path.resolve(arg("--summary-out", argv) || DEFAULT_SUMMARY_PATH);
  const limit = arg("--limit", argv) || process.env.TRANSCRIPT_WORKER_LIMIT || "5";
  const sql = buildVaultSecretSql({
    projectUrl: arg("--project-url", argv) || process.env.SUPABASE_URL,
    workerToken: arg("--worker-token", argv) || process.env.TRANSCRIPT_WORKER_TOKEN || process.env.SHAPE_TRANSCRIPT_WORKER_TOKEN,
    orgId: arg("--org-id", argv) || process.env.ORG_ID,
    limit,
  });
  writeText(outPath, sql);
  writeText(summaryPath, buildSummary({ outPath, summaryPath, limit }));
  console.log(JSON.stringify({
    ok: true,
    out: path.relative(ROOT, outPath).replace(/\\/g, "/"),
    summary: path.relative(ROOT, summaryPath).replace(/\\/g, "/"),
    secret_names: Object.values(SECRET_NAMES),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  SECRET_NAMES,
  buildSummary,
  buildVaultSecretSql,
  sqlString,
};

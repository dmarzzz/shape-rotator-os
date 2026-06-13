import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SECRET_NAMES,
  buildSummary,
  buildVaultSecretSql,
  sqlString,
} from "./prepare-transcript-worker-vault-sql.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(ROOT, "supabase", "migrations", "202606130001_transcript_worker_schedule.sql"),
  "utf8",
);
const rescheduleMigration = fs.readFileSync(
  path.join(ROOT, "supabase", "migrations", "202606130002_transcript_worker_half_hour_schedule.sql"),
  "utf8",
);
const evidenceOpsMigration = fs.readFileSync(
  path.join(ROOT, "supabase", "migrations", "202606140000_transcript_evidence_operations.sql"),
  "utf8",
);
const drivePollFunction = fs.readFileSync(
  path.join(ROOT, "supabase", "functions", "poll-drive-artifacts", "index.ts"),
  "utf8",
);

test("transcript worker schedule invokes the deployed Edge Function from Supabase cron", () => {
  assert.match(migration, /create extension if not exists pg_net/i);
  assert.match(migration, /create extension if not exists pg_cron/i);
  assert.match(migration, /create extension if not exists supabase_vault/i);
  assert.match(migration, /cron\.schedule\(/);
  assert.match(migration, /ensure_process_transcript_jobs_schedule/);
  assert.match(migration, /Vault secrets are missing; cron schedule not enabled yet/);
  assert.match(migration, /net\.http_post\(/);
  assert.match(migration, /\/functions\/v1\/process-transcript-jobs/);
  assert.match(migration, /Authorization', 'Bearer ' \|\| worker_token/);
  assert.match(migration, /vault\.decrypted_secrets/);
  assert.match(migration, new RegExp(SECRET_NAMES.workerToken));
  assert.doesNotMatch(migration, /TRANSCRIPT_WORKER_TOKEN=/);
  assert.doesNotMatch(migration, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("transcript worker current schedule runs on the hour and half hour", () => {
  assert.match(rescheduleMigration, /ensure_process_transcript_jobs_schedule/);
  assert.match(rescheduleMigration, /cron\.unschedule\('process-transcript-jobs-every-5-minutes'\)/);
  assert.match(rescheduleMigration, /process-transcript-jobs-every-30-minutes/);
  assert.match(rescheduleMigration, /'0,30 \* \* \* \*'/);
  assert.match(rescheduleMigration, /private\.invoke_process_transcript_jobs\(\)/);
  assert.doesNotMatch(rescheduleMigration, /'\*\/5 \* \* \* \*'/);
  assert.doesNotMatch(rescheduleMigration, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("Drive artifact watcher runs from Supabase cron without a local PC", () => {
  assert.match(evidenceOpsMigration, /invoke_poll_drive_artifacts/);
  assert.match(evidenceOpsMigration, /ensure_poll_drive_artifacts_schedule/);
  assert.match(evidenceOpsMigration, /shape_drive_artifact_folder_id/);
  assert.match(evidenceOpsMigration, /poll-drive-artifacts-every-15-minutes/);
  assert.match(evidenceOpsMigration, /\/functions\/v1\/poll-drive-artifacts/);
  assert.match(evidenceOpsMigration, /Authorization', 'Bearer ' \|\| worker_token/);
  assert.doesNotMatch(evidenceOpsMigration, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(drivePollFunction, /TRANSCRIPT_WORKER_TOKEN/);
  assert.match(drivePollFunction, /Google Drive files\.list/);
  assert.match(drivePollFunction, /storage_ref:\s*`drive:\/\/\$\{file\.id\}`/);
  assert.doesNotMatch(drivePollFunction, /export\?mimeType=text\/plain[\s\S]+fetch\(/);
});

test("vault secret SQL generator quotes values and keeps summaries secret-free", () => {
  const sql = buildVaultSecretSql({
    projectUrl: "https://project-ref.supabase.co",
    workerToken: "tok'en",
    orgId: "org-id",
    limit: 99,
  });

  assert.match(sql, /delete from vault\.secrets/);
  assert.match(sql, /select vault\.create_secret/);
  assert.match(sql, /select private\.ensure_process_transcript_jobs_schedule\(\)/);
  assert.match(sql, /tok''en/);
  assert.match(sql, /'25'/);
  for (const name of Object.values(SECRET_NAMES)) {
    assert.match(sql, new RegExp(name));
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-worker-schedule-"));
  const summary = buildSummary({
    outPath: path.join(dir, "worker.sql"),
    summaryPath: path.join(dir, "summary.md"),
    limit: 3,
  });
  assert.match(summary, /shape_transcript_worker_token/);
  assert.doesNotMatch(summary, /tok'en/);
  assert.doesNotMatch(summary, /https:\/\/project-ref\.supabase\.co/);
});

test("sqlString escapes single quotes", () => {
  assert.equal(sqlString("a'b"), "'a''b'");
});

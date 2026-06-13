import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202606130004_transcript_app_access_boundary.sql", import.meta.url),
  "utf8",
);

test("source artifacts are coordinator-only at the RLS boundary", () => {
  assert.match(migration, /drop policy if exists "source artifact private read"/);
  assert.match(migration, /create policy "coordinators read source artifacts"/);
  assert.match(migration, /on public\.source_artifacts for select/);
  assert.match(migration, /using \(public\.is_org_coordinator\(org_id\)\)/);
  assert.doesNotMatch(migration, /uploaded_by\s*=\s*auth\.uid\(\)/);
});

test("derived artifact table reads are coordinator-only", () => {
  assert.match(migration, /drop policy if exists "derived artifact tiered read"/);
  assert.match(migration, /create policy "coordinators read derived artifacts"/);
  assert.match(migration, /on public\.derived_artifacts for select/);
  assert.match(migration, /using \(public\.is_org_coordinator\(org_id\)\)/);
});

test("app transcript view exposes only reviewed distillation columns", () => {
  const viewMatch = migration.match(/create view public\.app_transcript_distillations[\s\S]+?revoke all/s);
  assert.ok(viewMatch, "app transcript distillation view is defined");
  const viewSql = viewMatch[0];

  assert.match(viewSql, /public\.is_org_member\(org_id\)/);
  assert.match(viewSql, /tier = 'T2'[\s\S]+review_status in \('reviewed', 'published'\)/);
  assert.match(viewSql, /tier = 'T3'[\s\S]+review_status = 'published'[\s\S]+approval_state = 'approved'/);
  assert.match(viewSql, /source_transform in \('paraphrased_distillation', 'aggregate', 'public_edit'\)/);

  for (const privateColumn of [
    "source_artifact_id",
    "processing_job_id",
    "storage_ref",
    "raw_available_to_server",
    "source_hash",
    "capture_artifact_id",
  ]) {
    assert.doesNotMatch(viewSql, new RegExp(`\\b${privateColumn}\\b`));
  }
});

test("app transcript view is not exposed to anonymous users", () => {
  assert.match(migration, /revoke all on public\.app_transcript_distillations from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.app_transcript_distillations to authenticated, service_role/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202606130004_transcript_app_access_boundary.sql", import.meta.url),
  "utf8",
);
const evidenceOpsMigration = readFileSync(
  new URL("../supabase/migrations/202606140000_transcript_evidence_operations.sql", import.meta.url),
  "utf8",
);
const publicEvidenceMigration = readFileSync(
  new URL("../supabase/migrations/202606150000_public_transcript_evidence_cards.sql", import.meta.url),
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

test("evidence cards keep private provenance behind coordinator-only table access", () => {
  assert.match(evidenceOpsMigration, /create table if not exists public\.evidence_cards/);
  assert.match(evidenceOpsMigration, /alter table public\.evidence_cards enable row level security/);
  assert.match(evidenceOpsMigration, /create policy "coordinators read evidence cards"/);
  assert.match(evidenceOpsMigration, /using \(public\.is_org_coordinator\(org_id\)\)/);
  assert.match(evidenceOpsMigration, /check \(not \(content_json \? 'source_artifact_id'\)\)/);
  assert.match(evidenceOpsMigration, /check \(not \(content_json \? 'storage_ref'\)\)/);

  const viewMatch = evidenceOpsMigration.match(/create view public\.app_transcript_evidence_cards[\s\S]+?revoke all/s);
  assert.ok(viewMatch, "app transcript evidence-card view is defined");
  const viewSql = viewMatch[0];
  assert.match(viewSql, /public\.is_org_member\(org_id\)/);
  assert.match(viewSql, /surface_tier = 'T2'[\s\S]+review_status in \('reviewed', 'published'\)/);
  assert.match(viewSql, /surface_tier = 'T3'[\s\S]+review_status = 'published'[\s\S]+approval_state = 'approved'/);
  assert.match(viewSql, /public_anonymous = true/);
  assert.match(viewSql, /public_article_mode = 'generalized_no_named_insights'/);

  for (const privateColumn of [
    "source_artifact_id",
    "processing_job_id",
    "derived_artifact_id",
    "source_boundary",
  ]) {
    assert.doesNotMatch(viewSql, new RegExp(`\\b${privateColumn}\\b`));
  }
});

test("anonymous public evidence-card view strips routing and provenance fields", () => {
  assert.match(publicEvidenceMigration, /create view public\.public_transcript_evidence_cards/);
  assert.match(publicEvidenceMigration, /grant select on public\.public_transcript_evidence_cards to anon, authenticated, service_role/);
  assert.match(publicEvidenceMigration, /surface_tier = 'T3'/);
  assert.match(publicEvidenceMigration, /review_status = 'published'/);
  assert.match(publicEvidenceMigration, /approval_state = 'approved'/);
  assert.match(publicEvidenceMigration, /public_anonymous = true/);
  assert.match(publicEvidenceMigration, /public_article_mode = 'generalized_no_named_insights'/);
  assert.match(publicEvidenceMigration, /'anonymous_public'::text as attribution_scope/);
  assert.match(publicEvidenceMigration, /'named_entities_allowed', false/);
  assert.match(publicEvidenceMigration, /'raw_allowed', false/);
  assert.doesNotMatch(publicEvidenceMigration, /'teams'/);
  assert.doesNotMatch(publicEvidenceMigration, /'people'/);
  assert.doesNotMatch(publicEvidenceMigration, /source_artifact_id/);
  assert.doesNotMatch(publicEvidenceMigration, /processing_job_id/);
  assert.doesNotMatch(publicEvidenceMigration, /storage_ref/);
});

test("private invite contacts are coordinator/admin-only and never anonymous", () => {
  assert.match(evidenceOpsMigration, /create table if not exists public\.private_invite_contacts/);
  assert.match(evidenceOpsMigration, /alter table public\.private_invite_contacts enable row level security/);
  assert.match(evidenceOpsMigration, /create policy "coordinators read private invite contacts"/);
  assert.match(evidenceOpsMigration, /create policy "admins manage private invite contacts"/);
  assert.doesNotMatch(evidenceOpsMigration, /grant select on public\.private_invite_contacts to anon/);
});

test("T3 evidence and publication guards require no-name public mode", () => {
  assert.match(evidenceOpsMigration, /T3 evidence cards must be anonymous public insights/);
  assert.match(evidenceOpsMigration, /generalized_no_named_insights/);
  assert.match(evidenceOpsMigration, /private-source or direct-contact markers/);
  assert.match(evidenceOpsMigration, /T3 publication blocked by private-source or direct-contact markers/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildCohortInsightUpsertRequest,
  cardToSupabaseRow,
  manifestToSupabaseRows,
} from "./publish-cohort-insights-supabase.mjs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/202606160000_cohort_insight_cards.sql", import.meta.url),
  "utf8",
);
const projectIdentityKindMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260616143000_cohort_insight_project_identity_kind.sql", import.meta.url),
  "utf8",
);

const sampleCard = {
  id: "cohort-insight:say-did-shipped:alpha",
  kind: "say_did_shipped",
  subject_type: "team",
  subject_ids: ["alpha"],
  title: "Alpha: say / did / shipped",
  claim_text: "Alpha has declared current intent plus observable public movement.",
  summary: "Public trace observed.",
  evidence_level: "observed_public_metadata",
  confidence: "medium",
  surface_tier: "cohort",
  source_boundary: "public_bundle",
  review_status: "generated",
  approval_state: "not_reviewed",
  source_refs: [{ kind: "team_record", record_id: "alpha" }],
  content_json: { observed_status: "public_signal_observed" },
  generated_by: "scripts/lib/cohort-insight-engine.cjs",
};

test("cohort insight migration creates base table with app and public views", () => {
  assert.match(migration, /create table if not exists public\.cohort_insight_cards/);
  assert.match(migration, /primary key \(org_id, id\)/);
  assert.match(migration, /alter table public\.cohort_insight_cards enable row level security/);
  assert.match(migration, /create policy "coordinators read cohort insight cards"/);
  assert.match(migration, /create policy "coordinators manage cohort insight cards"/);
  assert.match(migration, /create view public\.app_cohort_insight_cards/);
  assert.match(migration, /create view public\.public_cohort_insight_cards/);
});

test("cohort insight migration allows project identity cards", () => {
  assert.match(projectIdentityKindMigration, /drop constraint if exists cohort_insight_cards_kind_check/);
  assert.match(projectIdentityKindMigration, /add constraint cohort_insight_cards_kind_check/);
  assert.match(projectIdentityKindMigration, /'project_identity'/);
});

test("cohort insight migration keeps base table private and views scoped", () => {
  assert.match(migration, /revoke all on public\.cohort_insight_cards from anon/);
  assert.match(migration, /grant all privileges on public\.cohort_insight_cards to service_role/);
  assert.match(migration, /revoke all on public\.app_cohort_insight_cards from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.app_cohort_insight_cards to authenticated, service_role/);
  assert.match(migration, /grant select on public\.public_cohort_insight_cards to anon, authenticated, service_role/);
  assert.match(migration, /public\.is_org_member\(card\.org_id\)/);
  assert.match(migration, /surface_tier = 'cohort'/);
  assert.match(migration, /surface_tier = 'public'/);
  assert.match(migration, /review_status = 'published'/);
  assert.match(migration, /approval_state = 'approved'/);
  assert.match(migration, /source_boundary = 'public_bundle'/);
});

test("cohort insight migration blocks raw/private provenance markers", () => {
  assert.match(migration, /check \(raw_allowed = false\)/);
  assert.match(migration, /check \(not \(content_json \? 'source_artifact_id'\)\)/);
  assert.match(migration, /check \(not \(content_json \? 'storage_ref'\)\)/);
  assert.match(migration, /check \(not \(content_json \? 'drive_file_id'\)\)/);
  assert.match(migration, /private\.transcript_public_text_has_private_markers/);
  assert.match(migration, /cohort insight card contains private-source or direct-contact markers/);
});

test("cohort insight publisher maps engine cards to Supabase rows", () => {
  const row = cardToSupabaseRow(sampleCard, {
    orgId: "00000000-0000-0000-0000-000000000001",
    generatedAt: "2026-06-16T00:00:00.000Z",
  });

  assert.equal(row.org_id, "00000000-0000-0000-0000-000000000001");
  assert.equal(row.id, sampleCard.id);
  assert.equal(row.kind, "say_did_shipped");
  assert.deepEqual(row.subject_ids, ["alpha"]);
  assert.equal(row.raw_allowed, false);
  assert.equal(row.source_boundary, "public_bundle");
  assert.deepEqual(row.source_refs, sampleCard.source_refs);
  assert.deepEqual(row.content_json, sampleCard.content_json);
});

test("cohort insight publisher builds PostgREST upsert request", () => {
  const manifest = {
    artifact_kind: "cohort_insight_bundle",
    generated_at: "2026-06-16T00:00:00.000Z",
    cards: [sampleCard],
  };
  const rows = manifestToSupabaseRows(manifest, { orgId: "00000000-0000-0000-0000-000000000001" });
  const request = buildCohortInsightUpsertRequest({
    supabaseUrl: "https://project.supabase.co/",
    rows,
  });

  assert.equal(request.table, "cohort_insight_cards");
  assert.equal(request.method, "POST");
  assert.match(request.url, /\/rest\/v1\/cohort_insight_cards/);
  assert.match(request.url, /on_conflict=org_id%2Cid/);
  assert.equal(request.headers.prefer, "resolution=merge-duplicates,return=representation");
  assert.equal(request.body.length, 1);
  assert.equal(request.body[0].generated_at, "2026-06-16T00:00:00.000Z");
});

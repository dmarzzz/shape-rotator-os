import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildTranscriptSupabasePlan,
  renderTranscriptSupabaseSummary,
} from "./prepare-transcript-supabase-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const GENERATED_AT = "2026-06-13T00:00:00.000Z";

const IMPORT_PLAN = {
  generated_at: "2026-06-12T00:00:00.000Z",
  policy: { version: "2026-06-12" },
  source_drive: {
    shared_drive_id: "shared_drive",
    raw_folder_id: "raw_folder",
  },
  files: [
    {
      drive_file_id: "drive_ready",
      drive_url: "https://drive.google.com/file/d/drive_ready/view",
      original_name: "Copy of WDYDLW with Shaw Transcript Jun 8.txt",
      canonical_name: "WDYDLW with Shaw Transcript Jun 8.txt",
      vault_id: "wdydlw-shaw",
      mime_type: "text/plain",
      inferred_date: "2026-06-08",
      inferred_session_type: "weekly_standup",
      routing: { max_tier: "T2" },
      preferred_drive_name: "weekly_standup_shaw_2026-06-08.txt",
      drive_route: {
        path: "raw_transcripts/weekly_standup",
        derived_path: "operator_review_exports/weekly_standup",
      },
      calendar_match: {
        status: "matched",
        confidence: "moderate",
        confidence_pct: 76,
        matched_tokens: ["shaw"],
      },
      type_confidence_pct: 88,
      group_confidence_pct: 86,
      understanding_confidence_pct: 82,
      classification_confidence: {
        label: "moderate",
        basis: {
          type: ["calendar matched"],
          group: ["Drive route matches inferred type"],
          understanding: ["76% calendar confidence"],
        },
      },
      source_artifact_manifest: {
        source_kind: "drive_doc",
        source_tier: "T0",
        storage_mode: "external_ref",
        storage_ref: "drive://drive_ready",
        mime_type: "text/plain",
        raw_available_to_server: false,
        source_confidence_pct: 52,
      },
      needs_manual_review: false,
      manual_review_reasons: ["drive_copy_prefix_stripped_in_manifest"],
    },
    {
      drive_file_id: "drive_link_needed",
      original_name: "Copy of Agentic Organizations with Sreeram Transcript Jun 8.txt",
      canonical_name: "Agentic Organizations with Sreeram Transcript Jun 8.txt",
      vault_id: "agentic-organizations-sreeram",
      mime_type: "text/plain",
      inferred_date: "2026-06-08",
      inferred_session_type: "salon",
      routing: { max_tier: "T3" },
      preferred_drive_name: "salon_agentic-organizations-sreeram_2026-06-08.txt",
      drive_route: {
        path: "raw_transcripts/salon",
        derived_path: "operator_review_exports/salon",
      },
      calendar_match: {
        status: "matched",
        confidence: "moderate",
        matched_tokens: ["agentic", "organizations"],
      },
      source_artifact_manifest: {
        source_kind: "drive_doc",
        source_tier: "T0",
        storage_mode: "external_ref",
        storage_ref: "drive://drive_link_needed",
        mime_type: "text/plain",
        raw_available_to_server: false,
      },
      needs_manual_review: false,
      manual_review_reasons: ["drive_copy_prefix_stripped_in_manifest"],
    },
    {
      drive_file_id: "drive_review",
      original_name: "Copy of Info Markets Design B2B Transcript Jan 10.txt",
      canonical_name: "Info Markets Design B2B Transcript Jan 10.txt",
      vault_id: "info-markets-design-b2b",
      mime_type: "text/plain",
      inferred_date: "2026-01-10",
      inferred_session_type: "salon",
      preferred_drive_name: "salon_info-markets-design-b2b_2026-01-10.txt",
      drive_route: {
        path: "raw_transcripts/salon",
        derived_path: "operator_review_exports/salon",
      },
      calendar_match: { status: "date_conflict_title_candidate" },
      source_artifact_manifest: {
        source_kind: "drive_doc",
        source_tier: "T0",
        storage_mode: "external_ref",
        storage_ref: "drive://drive_review",
        mime_type: "text/plain",
        raw_available_to_server: false,
      },
      needs_manual_review: true,
      manual_review_reasons: ["calendar_date_conflict_title_candidate"],
    },
    {
      drive_file_id: "drive_index",
      original_name: "Copy of _TRANSCRIPT-INDEX__public-private-map.md",
      canonical_name: "_TRANSCRIPT-INDEX__public-private-map.md",
      vault_id: "index-map",
      calendar_match: { status: "unknown_date" },
      needs_manual_review: true,
      manual_review_reasons: ["index_or_non_transcript"],
    },
  ],
};

test("builds apply-ready Supabase rows only when session ids are resolved", () => {
  const plan = buildTranscriptSupabasePlan(IMPORT_PLAN, {
    orgId: ORG_ID,
    generatedAt: GENERATED_AT,
    sessionMap: {
      by_drive_file_id: {
        drive_ready: "22222222-2222-2222-2222-222222222222",
      },
    },
  });

  assert.equal(plan.operation_mode, "dry_run");
  assert.equal(plan.counts.strong_source_candidates, 2);
  assert.equal(plan.counts.ready_source_artifacts, 1);
  assert.equal(plan.counts.session_link_required, 1);
  assert.equal(plan.counts.manual_review_required, 1);
  assert.equal(plan.counts.skipped_files, 1);

  assert.equal(plan.sourceArtifacts.length, 1);
  assert.match(plan.sourceArtifacts[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(plan.sourceArtifacts[0].org_id, ORG_ID);
  assert.equal(plan.sourceArtifacts[0].session_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(plan.sourceArtifacts[0].source_kind, "drive_doc");
  assert.equal(plan.sourceArtifacts[0].storage_mode, "external_ref");
  assert.equal(plan.sourceArtifacts[0].storage_ref, "drive://drive_ready");
  assert.equal(plan.sourceArtifacts[0].raw_available_to_server, false);
  assert.equal(plan.sourceArtifacts[0].metadata.type_confidence_pct, 88);
  assert.equal(plan.sourceArtifacts[0].metadata.group_confidence_pct, 86);
  assert.equal(plan.sourceArtifacts[0].metadata.understanding_confidence_pct, 82);
  assert.deepEqual(plan.sourceArtifacts[0].metadata.confidence_basis.type, ["calendar matched"]);

  assert.equal(plan.ingestionEvents.length, 1);
  assert.equal(plan.ingestionEvents[0].event_type, "drive_doc.submitted");
  assert.equal(plan.ingestionEvents[0].event_json.preferred_drive_name, "weekly_standup_shaw_2026-06-08.txt");
  assert.equal(plan.ingestionEvents[0].event_json.type_confidence_pct, 88);

  assert.equal(plan.processingJobs.length, 1);
  assert.equal(plan.processingJobs[0].source_artifact_id, plan.sourceArtifacts[0].id);
  assert.equal(plan.processingJobs[0].job_kind, "artifact_fetch");
  assert.equal(plan.processingJobs[0].processor_mode, "local");
  assert.equal(plan.processingJobs[0].policy_version, "2026-06-12");
});

test("keeps unresolved matched transcripts in the session-link queue", () => {
  const plan = buildTranscriptSupabasePlan(IMPORT_PLAN, {
    orgId: ORG_ID,
    generatedAt: GENERATED_AT,
  });

  assert.equal(plan.sourceArtifacts.length, 0);
  assert.equal(plan.processingJobs.length, 0);
  assert.equal(plan.session_link_queue.length, 2);
  assert.deepEqual(
    plan.session_link_queue.map((item) => item.drive_file_id),
    ["drive_ready", "drive_link_needed"],
  );
  assert.ok(plan.session_link_queue.every((item) => item.reason === "session_id_required_before_queueing_processing_job"));
});

test("accepts session maps produced by transcript session-map planner", () => {
  const plan = buildTranscriptSupabasePlan(IMPORT_PLAN, {
    orgId: ORG_ID,
    generatedAt: GENERATED_AT,
    sessionMap: {
      session_map: {
        by_drive_file_id: {
          drive_ready: "22222222-2222-2222-2222-222222222222",
        },
      },
    },
  });

  assert.equal(plan.counts.ready_source_artifacts, 1);
  assert.equal(plan.counts.session_link_required, 1);
  assert.equal(plan.sourceArtifacts[0].session_id, "22222222-2222-2222-2222-222222222222");
});

test("renders a dry-run summary without raw transcript content", () => {
  const plan = buildTranscriptSupabasePlan(IMPORT_PLAN, {
    orgId: ORG_ID,
    generatedAt: GENERATED_AT,
    sessionMap: { drive_ready: "22222222-2222-2222-2222-222222222222" },
  });
  const summary = renderTranscriptSupabaseSummary(plan);

  assert.match(summary, /Transcript Supabase Bridge Plan/);
  assert.match(summary, /artifact_fetch/);
  assert.match(summary, /session_id_required_before_queueing_processing_job/);
  assert.doesNotMatch(summary, /alice@example\.com/);
});

test("throws when org id is missing", () => {
  assert.throws(
    () => buildTranscriptSupabasePlan(IMPORT_PLAN, { generatedAt: GENERATED_AT }),
    /orgId is required/,
  );
});

test("CLI can load org id from an explicit env file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-supabase-plan-"));
  const planPath = path.join(tmp, "import-plan.json");
  const envPath = path.join(tmp, ".env.calendar.local");
  const outPath = path.join(tmp, "supabase-plan.json");
  const summaryPath = path.join(tmp, "supabase-plan.md");
  fs.writeFileSync(planPath, JSON.stringify(IMPORT_PLAN), "utf8");
  fs.writeFileSync(envPath, `ORG_ID=${ORG_ID}\nSUPABASE_SERVICE_ROLE_KEY=not-printed\n`, "utf8");

  const output = execFileSync(process.execPath, [
    "scripts/prepare-transcript-supabase-plan.mjs",
    "--env-file", envPath,
    "--plan", planPath,
    "--out", outPath,
    "--summary-out", summaryPath,
  ], {
    cwd: ROOT,
    encoding: "utf8",
  });

  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(plan.org_id, ORG_ID);
  assert.match(output, /prepared transcript Supabase bridge/);
  assert.doesNotMatch(output, /not-printed/);
  assert.doesNotMatch(fs.readFileSync(summaryPath, "utf8"), /not-printed/);
});

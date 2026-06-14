import test from "node:test";
import assert from "node:assert/strict";
import { buildTranscriptCalendarCoverageAudit } from "./audit-transcript-calendar-coverage.mjs";

function fixtureCalendar() {
  return {
    last_refresh: "2026-06-13T16:12:46.618673+00:00",
    tabs: {
      "May 18 Start": [
        ["Week", "Dates", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        ["", "", "", "", "", "", "", "", ""],
        [
          "1",
          "May 18-23",
          "12:00-13:00 Project Intros\n\n14:00-14:30 tea on roof",
          "16:00-17:00 Founder Night",
          "16:00-17:00 Missing Workshop",
          "",
          "17:15-18:30 Introduce Tina + interactive recap / Project Mappings",
          "",
          "",
        ],
        [
          "2",
          "Jun 8-13",
          "16:00-17:00 WDYDLW with Shaw",
          "20:00-21:00 Info Markets Design",
          "15:30-16:30 ICP research for Private Inference",
          "16:30-17:30 Future Design Thinking Workshop",
          "",
          "",
          "",
        ],
      ],
    },
  };
}

function fixtureImportPlan() {
  return {
    generated_at: "2026-06-13T19:58:56.257Z",
    counts: {
      total_files: 3,
      transcript_files: 3,
      matched: 1,
      date_only: 0,
      title_only_candidate: 1,
      date_conflict_title_candidate: 1,
      unknown_date: 0,
      needs_manual_review: 2,
      rename_recommended: 3,
    },
    files: [
      {
        drive_file_id: "drive_wdydlw",
        canonical_name: "WDYDLW with Shaw Transcript Jun 8.txt",
        vault_id: "wdydlw-shaw-2026-06-08",
        inferred_date: "2026-06-08",
        inferred_session_type: "weekly_standup",
        routing: { max_tier: "T2", cohort_mode: "aggregate_only", public_allowed: false },
        preferred_drive_name: "weekly_standup_shaw_2026-06-08.txt",
        preferred_name_matches: false,
        drive_route: { path: "raw_transcripts/weekly_standup", derived_path: "operator_review_exports/weekly_standup" },
        calendar_match: { status: "matched", confidence: "high" },
        source_artifact_manifest: {
          source_kind: "drive_doc",
          storage_ref: "drive://drive_wdydlw",
          raw_available_to_server: false,
        },
        manual_review_reasons: ["drive_copy_prefix_stripped_in_manifest"],
        needs_manual_review: false,
      },
      {
        drive_file_id: "drive_private_inference",
        canonical_name: "ICP Research Private Inference Transcript.txt",
        vault_id: "icp-private-inference",
        inferred_date: null,
        inferred_session_type: "user_interview",
        routing: { max_tier: "T2", cohort_mode: "aggregate_only", public_allowed: false },
        preferred_drive_name: "user_interview_inference_unknown-date.txt",
        preferred_name_matches: false,
        drive_route: { path: "raw_transcripts/user_interview", derived_path: "operator_review_exports/user_interview" },
        calendar_match: {
          status: "title_only_candidate",
          confidence: "low",
          candidate: { date: "2026-06-10" },
        },
        source_artifact_manifest: {
          source_kind: "drive_doc",
          storage_ref: "drive://drive_private_inference",
          raw_available_to_server: false,
        },
        manual_review_reasons: ["calendar_title_only_candidate"],
        needs_manual_review: true,
      },
      {
        drive_file_id: "1hadEvWnIGsmFhaWnoGFFLLx5ypghRNuW",
        canonical_name: "2026-05-22__group-room__shape-rotator-project-map-guests.txt",
        vault_id: "05-22-shape-rotator-project-map-guests",
        inferred_date: "2026-05-22",
        inferred_session_type: "office_hours",
        routing: { max_tier: "T2", cohort_mode: "distilled_readout", public_allowed: false },
        preferred_drive_name: "office_hours_shape-rotator-project-map-guests_2026-05-22.txt",
        preferred_name_matches: false,
        drive_route: { path: "raw_transcripts/office_hours", derived_path: "operator_review_exports/office_hours" },
        calendar_match: { status: "date_only", confidence: "low" },
        source_artifact_manifest: {
          source_kind: "drive_doc",
          storage_ref: "drive://1hadEvWnIGsmFhaWnoGFFLLx5ypghRNuW",
          raw_available_to_server: false,
        },
        manual_review_reasons: ["calendar_date_only"],
        needs_manual_review: true,
      },
      {
        drive_file_id: "drive_info_markets",
        canonical_name: "Info Markets Design B2B Transcript Jan 10.txt",
        vault_id: "info-markets-design-b2b",
        inferred_date: "2026-01-10",
        inferred_session_type: "salon",
        routing: { max_tier: "T3", cohort_mode: "distilled_readout", public_allowed: true },
        preferred_drive_name: "salon_info-markets-design-b2b_2026-01-10.txt",
        preferred_name_matches: false,
        drive_route: { path: "raw_transcripts/salon", derived_path: "operator_review_exports/salon" },
        calendar_match: {
          status: "date_conflict_title_candidate",
          confidence: "low",
          candidate: { date: "2026-06-09" },
        },
        source_artifact_manifest: {
          source_kind: "drive_doc",
          storage_ref: "drive://drive_info_markets",
          raw_available_to_server: false,
        },
        manual_review_reasons: ["calendar_date_conflict_title_candidate"],
        needs_manual_review: true,
      },
    ],
  };
}

test("buildTranscriptCalendarCoverageAudit classifies calendar transcript coverage", () => {
  const audit = buildTranscriptCalendarCoverageAudit({
    calendar: fixtureCalendar(),
    importPlan: fixtureImportPlan(),
    sessionMap: {
      generated_at: "2026-06-13T21:12:44.974Z",
      counts: { safe_links: 1, review_links: 2 },
      safe_links: [{ preferred_drive_name: "weekly_standup_shaw_2026-06-08.txt" }],
      review_links: [
        { preferred_drive_name: "user_interview_inference_unknown-date.txt" },
        { preferred_drive_name: "salon_info-markets-design-b2b_2026-01-10.txt" },
      ],
    },
    supabasePlan: {
      generated_at: "2026-06-13T21:13:43.916Z",
      sourceArtifacts: [{ storage_ref: "drive://drive_wdydlw" }],
    },
    fetchManifest: {
      generated_at: "2026-06-13T21:43:56.747Z",
      items: [{ source_storage_ref: "drive://drive_wdydlw", status: "fetched" }],
    },
    driveOperationsPlan: {
      generated_at: "2026-06-13T20:01:48.330Z",
      counts: { rename_actions: 3, move_actions: 3, safe_file_operations: 1, review_file_operations: 2 },
    },
    driveApplyResult: {
      apply: true,
      counts: { files_updated: 0, files_unchanged: 1 },
      files: [{ drive_file_id: "drive_wdydlw", action: "unchanged" }],
    },
    readouts: [{
      file: "cohort-data/session-readouts/project-intros.md",
      filename: "project-intros.md",
      date: "2026-05-18",
      title: "Project Intros",
      vault_id: "project-intros-2026-05-18",
    }, {
      file: "cohort-data/session-readouts/shape-rotator-project-map-guests-2026-05-22.md",
      filename: "shape-rotator-project-map-guests-2026-05-22.md",
      date: "2026-05-22",
      title: "Project Map Walkthrough with Guests: Clusters, Synergies, and PMF Discipline",
      vault_id: "shape-rotator-project-map-guests-2026-05-22",
    }],
    auditDate: "2026-06-10",
    generatedAt: "2026-06-13T22:00:00.000Z",
  });

  assert.equal(audit.counts.calendar_blocks, 9);
  assert.equal(audit.counts.transcript_refs, 4);
  assert.equal(audit.counts.readouts, 2);
  assert.equal(audit.counts.naming_issue_rows, 2);
  assert.equal(audit.counts.manual_drive_corrections, 1);
  assert.equal(audit.sources.drive_operations_plan_generated_at, "2026-06-13T20:01:48.330Z");
  assert.equal(audit.sources.drive_operations_apply_recorded, true);

  const rowsByTitle = new Map(audit.calendar_coverage.map((row) => [row.title, row]));
  assert.equal(rowsByTitle.get("Project Intros").coverage_status, "derived_readout");
  assert.equal(rowsByTitle.get("tea on roof").coverage_status, "not_expected");
  assert.equal(rowsByTitle.get("Missing Workshop").coverage_status, "missing");
  assert.equal(rowsByTitle.get("WDYDLW with Shaw").coverage_status, "covered");
  assert.equal(rowsByTitle.get("Introduce Tina + interactive recap / Project Mappings").coverage_status, "covered");
  assert.equal(rowsByTitle.get("Info Markets Design").coverage_status, "candidate_needs_review");
  assert.equal(rowsByTitle.get("ICP research for Private Inference").coverage_status, "candidate_needs_review");
  assert.equal(rowsByTitle.get("Future Design Thinking Workshop").coverage_status, "future");

  assert.ok(audit.transcript_inventory.every((item) => item.raw_available_to_server === false));
  const projectMap = audit.transcript_inventory.find((item) => item.drive_file_id === "1hadEvWnIGsmFhaWnoGFFLLx5ypghRNuW");
  assert.equal(projectMap.session_type, "salon");
  assert.equal(projectMap.preferred_drive_name, "salon_shape-rotator-project-map-guests_2026-05-22.txt");
});

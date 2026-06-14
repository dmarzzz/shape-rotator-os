import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDriveOperationsPlan,
  renderDriveOperationsSummary,
} from "./prepare-transcript-drive-operations.mjs";

const IMPORT_PLAN = {
  generated_at: "2026-06-13T00:00:00.000Z",
  source_drive: {
    shared_drive_id: "shared_drive",
    raw_folder_id: "raw_folder",
  },
  naming: {
    preferred_pattern: "type_project_name_date",
  },
  drive_permissions: {
    shared_drive_name: "Shape Rotator Transcript Vault",
    admin_role: "manager",
    admins: [
      { name: "Tina", email: "admin-one@example.com" },
      { name: "Dmarz", email: "admin-two@example.com" },
    ],
  },
  files: [
    {
      drive_file_id: "drive_safe",
      original_name: "Copy of WDYDLW with Shaw Transcript Jun 8.txt",
      canonical_name: "WDYDLW with Shaw Transcript Jun 8.txt",
      preferred_drive_name: "weekly_standup_shaw_2026-06-08.txt",
      inferred_session_type: "weekly_standup",
      inferred_date: "2026-06-08",
      calendar_match: { status: "matched" },
      drive_route: {
        path: "10_raw_transcripts_T0/weekly_standup",
        derived_path: "40_derived_review/weekly_standup",
      },
      manual_review_reasons: ["drive_copy_prefix_stripped_in_manifest"],
      needs_manual_review: false,
    },
    {
      drive_file_id: "drive_review",
      original_name: "Copy of Info Markets Design B2B Transcript Jan 10.txt",
      canonical_name: "Info Markets Design B2B Transcript Jan 10.txt",
      preferred_drive_name: "salon_info-markets-design-b2b_2026-01-10.txt",
      inferred_session_type: "salon",
      inferred_date: "2026-01-10",
      calendar_match: { status: "date_conflict_title_candidate" },
      drive_route: {
        path: "10_raw_transcripts_T0/salon",
        derived_path: "40_derived_review/salon",
      },
      manual_review_reasons: ["calendar_date_conflict_title_candidate"],
      needs_manual_review: true,
    },
    {
      drive_file_id: "drive_strategy",
      original_name: "Copy of Strategy 1-1 Jun 9.txt",
      canonical_name: "Strategy 1-1 Jun 9.txt",
      preferred_drive_name: "planning_strategy_strategy_2026-06-09.txt",
      inferred_session_type: "planning_strategy",
      inferred_date: "2026-06-09",
      calendar_match: { status: "date_only" },
      drive_route: {
        path: "90_do_not_publish/planning_strategy",
        derived_path: "90_do_not_publish/planning_strategy",
      },
      manual_review_reasons: ["planning_strategy_stops_at_core", "calendar_date_only"],
      needs_manual_review: true,
    },
    {
      drive_file_id: "drive_private_1on1",
      original_name: "Copy of 1-1 May 29 Transcript.txt",
      canonical_name: "1-1 May 29 Transcript.txt",
      preferred_drive_name: "private_1on1_session_2026-05-29.txt",
      inferred_session_type: "private_1on1",
      inferred_date: "2026-05-29",
      calendar_match: { status: "date_only" },
      drive_route: {
        path: "90_do_not_publish/private_1on1",
        derived_path: "90_do_not_publish/private_1on1",
      },
      manual_review_reasons: ["drive_copy_prefix_stripped_in_manifest", "calendar_date_only"],
      needs_manual_review: true,
    },
  ],
};

test("builds Drive operation plan with folder ensures and manager grants", () => {
  const plan = buildDriveOperationsPlan(IMPORT_PLAN, { generatedAt: "2026-06-13T00:00:00.000Z" });

  assert.equal(plan.operation_mode, "dry_run");
  assert.equal(plan.counts.manager_grants, 2);
  assert.deepEqual(plan.admin_operations.map((operation) => operation.email), [
    "admin-one@example.com",
    "admin-two@example.com",
  ]);
  assert.ok(plan.admin_operations.every((operation) => operation.drive_api_role === "organizer"));
  assert.ok(plan.folder_operations.some((operation) => operation.path === "10_raw_transcripts_T0"));
  assert.ok(plan.folder_operations.some((operation) => operation.path === "10_raw_transcripts_T0/weekly_standup"));
  assert.ok(plan.folder_operations.some((operation) => operation.path === "90_do_not_publish/planning_strategy"));
  assert.ok(plan.folder_operations.some((operation) => operation.path === "90_do_not_publish/private_1on1"));
  assert.equal(
    plan.folder_operations.find((operation) => operation.path === "10_raw_transcripts_T0").known_folder_id,
    "raw_folder",
  );
});

test("separates safe file operations from review-held operations", () => {
  const plan = buildDriveOperationsPlan(IMPORT_PLAN, { generatedAt: "2026-06-13T00:00:00.000Z" });

  assert.equal(plan.counts.total_files, 4);
  assert.equal(plan.counts.safe_file_operations, 2);
  assert.equal(plan.counts.review_file_operations, 2);
  assert.equal(plan.counts.rename_actions, 4);
  assert.equal(plan.counts.move_actions, 4);
  assert.equal(plan.counts.duplicate_target_paths, 0);

  const safe = plan.safe_file_operations[0];
  assert.equal(safe.drive_file_id, "drive_safe");
  assert.deepEqual(safe.actions, ["rename", "move"]);
  assert.equal(safe.target_path, "10_raw_transcripts_T0/weekly_standup/weekly_standup_shaw_2026-06-08.txt");

  const strategy = plan.review_file_operations.find((operation) => operation.drive_file_id === "drive_strategy");
  assert.equal(strategy.disposition, "quarantine_review");
  assert.equal(strategy.safe_to_apply, false);
  assert.equal(strategy.target_folder_path, "90_do_not_publish/planning_strategy");

  const privateOneOnOne = plan.safe_file_operations.find((operation) => operation.drive_file_id === "drive_private_1on1");
  assert.equal(privateOneOnOne.safe_to_apply, true);
  assert.equal(privateOneOnOne.target_folder_path, "90_do_not_publish/private_1on1");
  assert.deepEqual(privateOneOnOne.manual_review_reasons, ["drive_copy_prefix_stripped_in_manifest", "calendar_date_only"]);
});

test("renders a human-readable dry-run summary", () => {
  const plan = buildDriveOperationsPlan(IMPORT_PLAN, { generatedAt: "2026-06-13T00:00:00.000Z" });
  const summary = renderDriveOperationsSummary(plan);

  assert.match(summary, /dry-run plan/);
  assert.match(summary, /weekly_standup_shaw_2026-06-08\.txt/);
  assert.match(summary, /admin-two@example\.com/);
  assert.match(summary, /quarantine_review/);
});

test("holds duplicate target paths for manual review", () => {
  const duplicatePlan = {
    ...IMPORT_PLAN,
    files: [
      IMPORT_PLAN.files[0],
      {
        ...IMPORT_PLAN.files[0],
        drive_file_id: "drive_duplicate",
        original_name: "Copy of Duplicate WDYDLW.txt",
      },
    ],
  };
  const plan = buildDriveOperationsPlan(duplicatePlan, { generatedAt: "2026-06-13T00:00:00.000Z" });

  assert.equal(plan.counts.duplicate_target_paths, 1);
  assert.equal(plan.counts.safe_file_operations, 0);
  assert.equal(plan.counts.review_file_operations, 2);
  assert.ok(plan.review_file_operations.every((operation) => operation.disposition === "target_conflict_review"));
  assert.ok(plan.review_file_operations.every((operation) => operation.manual_review_reasons.includes("target_path_conflict")));
});

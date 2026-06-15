#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DEFAULT_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "drive-operations-plan.json");
const ROOT_FOLDER_LEGACY_NAMES = {
  inbox: ["00_inbox"],
  raw_transcripts: ["10_raw_transcripts_T0", "raw_transcripts_T0"],
  calendar_matched: ["20_calendar_matched"],
  needs_calendar_match: ["30_needs_calendar_match"],
  operator_review_exports: ["40_derived_review", "40_operator_review_exports"],
  do_not_publish: ["90_do_not_publish"],
};

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-transcript-drive-operations.mjs [--plan import-plan.json] [--out drive-operations-plan.json] [--summary-out summary.md]",
    "",
    "Builds a dry-run Google Drive operation plan from the transcript vault import plan.",
    "The output contains folder ensures, manager grants, safe file operations, and review-held operations.",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeDrivePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function folderPrefixes(folderPath) {
  const parts = normalizeDrivePath(folderPath).split("/").filter(Boolean);
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    out.push(parts.slice(0, index + 1).join("/"));
  }
  return out;
}

function stripCopyPrefix(name) {
  return String(name || "").replace(/^Copy of\s+/i, "").trim();
}

function fallbackTargetName(file) {
  return file.preferred_drive_name || file.canonical_name || stripCopyPrefix(file.original_name);
}

function legacyNamesForFolderPath(folderPath, name) {
  const pathParts = normalizeDrivePath(folderPath).split("/").filter(Boolean);
  if (pathParts.length !== 1) return [];
  return ROOT_FOLDER_LEGACY_NAMES[name] || [];
}

function isDefaultRawRoot(folderPath) {
  return normalizeDrivePath(folderPath) === "raw_transcripts";
}

function reviewDisposition(file) {
  const reasons = file.manual_review_reasons || [];
  const targetFolderPath = normalizeDrivePath(file.drive_route?.path || "");
  if (
    file.inferred_session_type === "private_1on1"
    && targetFolderPath === "do_not_publish/private_1on1"
  ) {
    return "safe_to_apply";
  }
  if (
    file.inferred_session_type === "leadership_meeting"
    && targetFolderPath === "do_not_publish/leadership_meeting"
  ) {
    return "safe_to_apply";
  }
  if (reasons.includes("planning_strategy_stops_at_core")) return "quarantine_review";
  if (file.needs_manual_review) return "review_required";
  return "safe_to_apply";
}

function buildFolderOperations(plan) {
  const paths = new Set();
  for (const folderPath of Object.values(plan.drive_permissions?.root_folders || {})) {
    paths.add(normalizeDrivePath(folderPath));
  }
  for (const file of plan.files || []) {
    const route = file.drive_route || {};
    for (const folderPath of [route.path, route.derived_path]) {
      for (const prefix of folderPrefixes(folderPath)) paths.add(prefix);
    }
  }

  return Array.from(paths)
    .sort((a, b) => a.localeCompare(b))
    .map((folderPath) => {
      const parts = folderPath.split("/");
      const name = parts.at(-1);
      return {
        operation: "ensure_folder",
        path: folderPath,
        name,
        legacy_names: legacyNamesForFolderPath(folderPath, name),
        parent_path: parts.length > 1 ? parts.slice(0, -1).join("/") : null,
        shared_drive_id: plan.source_drive?.shared_drive_id || null,
        known_folder_id: isDefaultRawRoot(folderPath) ? plan.source_drive?.raw_folder_id || null : null,
      };
    });
}

function buildAdminOperations(plan) {
  const admins = plan.drive_permissions?.admins || [];
  return admins.map((admin) => ({
    operation: "ensure_shared_drive_manager",
    shared_drive_id: plan.source_drive?.shared_drive_id || null,
    shared_drive_name: plan.drive_permissions?.shared_drive_name || "Shape Rotator Transcript Vault",
    name: admin.name,
    email: admin.email,
    ui_role: plan.drive_permissions?.admin_role || "manager",
    drive_api_role: "organizer",
  }));
}

function buildFileOperation(file, plan) {
  const targetFolderPath = normalizeDrivePath(file.drive_route?.path || "needs_calendar_match");
  const targetName = fallbackTargetName(file);
  const currentName = file.original_name;
  const currentFolderPath = "raw_transcripts";
  const actions = [];
  if (targetName && targetName !== currentName) actions.push("rename");
  if (targetFolderPath && targetFolderPath !== currentFolderPath) actions.push("move");
  const disposition = reviewDisposition(file);

  return {
    operation: "move_or_rename_file",
    drive_file_id: file.drive_file_id,
    current_name: currentName,
    target_name: targetName,
    current_folder_path: currentFolderPath,
    target_folder_path: targetFolderPath,
    target_path: `${targetFolderPath}/${targetName}`,
    inferred_session_type: file.inferred_session_type,
    inferred_date: file.inferred_date,
    calendar_status: file.calendar_match?.status || "unknown",
    needs_manual_review: !!file.needs_manual_review,
    manual_review_reasons: file.manual_review_reasons || [],
    disposition,
    safe_to_apply: disposition === "safe_to_apply",
    actions,
    source_drive: {
      shared_drive_id: plan.source_drive?.shared_drive_id || null,
      raw_folder_id: plan.source_drive?.raw_folder_id || null,
    },
  };
}

function buildCopyPrefixCleanupOperation(operation) {
  const strippedName = stripCopyPrefix(operation.current_name);
  if (!/^Copy of\s+/i.test(operation.current_name || "")) return null;
  if (!strippedName || strippedName === operation.current_name) return null;
  if (operation.safe_to_apply) return null;
  return {
    operation: "strip_copy_prefix_in_place",
    drive_file_id: operation.drive_file_id,
    current_name: operation.current_name,
    target_name: strippedName,
    current_folder_path: operation.current_folder_path,
    final_target_name: operation.target_name,
    final_target_folder_path: operation.target_folder_path,
    final_target_path: operation.target_path,
    inferred_session_type: operation.inferred_session_type,
    inferred_date: operation.inferred_date,
    calendar_status: operation.calendar_status,
    needs_manual_review: operation.needs_manual_review,
    manual_review_reasons: operation.manual_review_reasons || [],
    disposition: "copy_prefix_cleanup_only",
    safe_to_apply: true,
    actions: ["rename_in_place"],
    source_drive: operation.source_drive,
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item) || "none";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildDriveOperationsPlan(importPlan, { generatedAt = new Date().toISOString() } = {}) {
  if (!importPlan || typeof importPlan !== "object") throw new Error("import plan is required");
  const folderOperations = buildFolderOperations(importPlan);
  const adminOperations = buildAdminOperations(importPlan);
  const rawFileOperations = (importPlan.files || []).map((file) => buildFileOperation(file, importPlan));
  const targetCounts = countBy(rawFileOperations, (operation) => operation.target_path);
  const duplicateTargets = new Set(Object.entries(targetCounts).filter(([, count]) => count > 1).map(([target]) => target));
  const fileOperations = rawFileOperations.map((operation) => {
    if (!duplicateTargets.has(operation.target_path)) return operation;
    return {
      ...operation,
      disposition: "target_conflict_review",
      safe_to_apply: false,
      needs_manual_review: true,
      manual_review_reasons: unique([...operation.manual_review_reasons, "target_path_conflict"]),
    };
  });
  const safeFileOperations = fileOperations.filter((operation) => operation.safe_to_apply);
  const reviewFileOperations = fileOperations.filter((operation) => !operation.safe_to_apply);
  const copyPrefixCleanupOperations = reviewFileOperations
    .map(buildCopyPrefixCleanupOperation)
    .filter(Boolean);

  return {
    generated_at: generatedAt,
    operation_mode: "dry_run",
    source_plan_generated_at: importPlan.generated_at || null,
    source_drive: importPlan.source_drive || {},
    naming: importPlan.naming || {},
    counts: {
      total_files: fileOperations.length,
      safe_file_operations: safeFileOperations.length,
      review_file_operations: reviewFileOperations.length,
      copy_prefix_cleanup_operations: copyPrefixCleanupOperations.length,
      folder_ensures: folderOperations.length,
      manager_grants: adminOperations.length,
      rename_actions: fileOperations.filter((operation) => operation.actions.includes("rename")).length,
      copy_prefix_cleanup_rename_actions: copyPrefixCleanupOperations.length,
      move_actions: fileOperations.filter((operation) => operation.actions.includes("move")).length,
      duplicate_target_paths: duplicateTargets.size,
      by_disposition: countBy(fileOperations, (operation) => operation.disposition),
      by_target_folder: countBy(fileOperations, (operation) => operation.target_folder_path),
    },
    folder_operations: folderOperations,
    admin_operations: adminOperations,
    safe_file_operations: safeFileOperations,
    review_file_operations: reviewFileOperations,
    copy_prefix_cleanup_operations: copyPrefixCleanupOperations,
  };
}

export function renderDriveOperationsSummary(plan) {
  const lines = [
    "# Transcript Drive Operations Plan",
    "",
    `Generated: ${plan.generated_at}`,
    "",
    "This is a dry-run plan. It does not mutate Google Drive.",
    "",
    "## Counts",
    "",
    `- Files: ${plan.counts.total_files}`,
    `- Safe file operations: ${plan.counts.safe_file_operations}`,
    `- Review-held file operations: ${plan.counts.review_file_operations}`,
    `- Copy-prefix cleanup operations: ${plan.counts.copy_prefix_cleanup_operations || 0}`,
    `- Folder ensures: ${plan.counts.folder_ensures}`,
    `- Manager grants: ${plan.counts.manager_grants}`,
    `- Rename actions: ${plan.counts.rename_actions}`,
    `- Move actions: ${plan.counts.move_actions}`,
    `- Duplicate target paths: ${plan.counts.duplicate_target_paths}`,
    "",
    "## Manager Grants",
    "",
  ];
  for (const operation of plan.admin_operations) {
    lines.push(`- ${operation.name}: ${operation.email} (${operation.ui_role})`);
  }

  lines.push("", "## Folder Ensures", "");
  for (const operation of plan.folder_operations) {
    lines.push(`- ${operation.path}${operation.known_folder_id ? ` (${operation.known_folder_id})` : ""}`);
  }

  lines.push("", "## Safe File Operations", "");
  lines.push("| Current | Target | Actions |");
  lines.push("| --- | --- | --- |");
  for (const operation of plan.safe_file_operations) {
    lines.push(`| ${operation.current_name.replaceAll("|", "\\|")} | ${operation.target_path.replaceAll("|", "\\|")} | ${operation.actions.join(", ")} |`);
  }

  lines.push("", "## Review-Held File Operations", "");
  lines.push("| Current | Proposed target | Disposition | Reasons |");
  lines.push("| --- | --- | --- | --- |");
  for (const operation of plan.review_file_operations) {
    lines.push(`| ${operation.current_name.replaceAll("|", "\\|")} | ${operation.target_path.replaceAll("|", "\\|")} | ${operation.disposition} | ${operation.manual_review_reasons.join(", ").replaceAll("|", "\\|")} |`);
  }

  lines.push("", "## Copy-Prefix Cleanup Operations", "");
  lines.push("These operations only strip `Copy of ` from review-held files in place. They do not move files or apply the final preferred transcript name.");
  lines.push("");
  lines.push("| Current | In-place cleanup name | Final target still pending review | Reasons |");
  lines.push("| --- | --- | --- | --- |");
  for (const operation of plan.copy_prefix_cleanup_operations || []) {
    lines.push(`| ${operation.current_name.replaceAll("|", "\\|")} | ${operation.target_name.replaceAll("|", "\\|")} | ${operation.final_target_path.replaceAll("|", "\\|")} | ${operation.manual_review_reasons.join(", ").replaceAll("|", "\\|")} |`);
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }
  const planPath = path.resolve(arg("--plan", argv) || DEFAULT_PLAN_PATH);
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const summaryOutPath = arg("--summary-out", argv)
    ? path.resolve(arg("--summary-out", argv))
    : path.join(path.dirname(outPath), "drive-operations-summary.md");
  const plan = buildDriveOperationsPlan(readJson(planPath));
  writeJson(outPath, plan);
  writeText(summaryOutPath, renderDriveOperationsSummary(plan));
  console.log(`prepared transcript Drive operations (${plan.counts.safe_file_operations} safe, ${plan.counts.review_file_operations} review-held)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`wrote ${path.relative(ROOT, summaryOutPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

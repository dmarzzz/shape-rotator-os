#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import envFile from "./lib/env-file.cjs";

const { loadEnvFile } = envFile;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "drive-operations-plan.json");
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-transcript-drive-operations.mjs [--plan drive-operations-plan.json] [--env-file .env.calendar.local] [--apply] [--out apply-result.json]",
    "",
    "Applies safe transcript Drive operations: folder ensures, safe file",
    "rename/move actions, and in-place Copy-of prefix cleanup for review-held",
    "files. Review-held final move/classification operations are never applied.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_REFRESH_TOKEN + GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function flag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeDrivePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function queryParams(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  return search;
}

function driveUrl(pathname, params = {}) {
  const url = new URL(`${DRIVE_API}${pathname}`);
  for (const [key, value] of queryParams(params)) url.searchParams.set(key, value);
  return url;
}

async function refreshGoogleAccessToken({ env = process.env, fetchImpl = fetch } = {}) {
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return null;
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const error = new Error(`Google OAuth token refresh ${response.status}`);
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload.access_token;
}

export async function resolveGoogleAccessToken({ accessToken, env = process.env, fetchImpl = fetch } = {}) {
  if (accessToken) return accessToken;
  const refreshed = await refreshGoogleAccessToken({ env, fetchImpl });
  return refreshed || env.GOOGLE_CALENDAR_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || null;
}

async function driveRequest({ accessToken, method = "GET", url, body, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Drive ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function listFoldersByName({ accessToken, sharedDriveId, parentId, name, fetchImpl = fetch }) {
  const q = [
    `'${escapeDriveQueryValue(parentId)}' in parents`,
    "trashed=false",
    `mimeType='${FOLDER_MIME_TYPE}'`,
    `name='${escapeDriveQueryValue(name)}'`,
  ].join(" and ");
  const url = driveUrl("/files", {
    q,
    fields: "files(id,name,parents)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    ...(sharedDriveId ? { driveId: sharedDriveId, corpora: "drive" } : {}),
  });
  const data = await driveRequest({ accessToken, url, fetchImpl });
  return data.files || [];
}

async function createFolder({ accessToken, sharedDriveId, parentId, name, fetchImpl = fetch }) {
  const url = driveUrl("/files", {
    fields: "id,name,parents",
    supportsAllDrives: "true",
  });
  return driveRequest({
    accessToken,
    method: "POST",
    url,
    body: {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId],
      ...(sharedDriveId ? { driveId: sharedDriveId } : {}),
    },
    fetchImpl,
  });
}

async function getFileMetadata({ accessToken, fileId, fetchImpl = fetch }) {
  const url = driveUrl(`/files/${encodeURIComponent(fileId)}`, {
    fields: "id,name,parents",
    supportsAllDrives: "true",
  });
  return driveRequest({ accessToken, url, fetchImpl });
}

async function updateFile({ accessToken, fileId, body, addParents, removeParents, fetchImpl = fetch }) {
  const url = driveUrl(`/files/${encodeURIComponent(fileId)}`, {
    fields: "id,name,parents",
    supportsAllDrives: "true",
    ...(addParents ? { addParents } : {}),
    ...(removeParents ? { removeParents } : {}),
  });
  return driveRequest({ accessToken, method: "PATCH", url, body, fetchImpl });
}

function safeFileOperations(plan) {
  return (plan.safe_file_operations || []).filter((operation) => operation?.safe_to_apply === true);
}

function copyPrefixCleanupOperations(plan) {
  return (plan.copy_prefix_cleanup_operations || [])
    .filter((operation) => operation?.safe_to_apply === true && operation?.operation === "strip_copy_prefix_in_place");
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function legacyNames(operation) {
  return unique(operation?.legacy_names || []).filter((name) => name !== operation.name);
}

function assertPlanSafe(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Drive operations plan is required");
  const operations = safeFileOperations(plan);
  for (const operation of operations) {
    if (!operation.drive_file_id) throw new Error(`safe operation missing drive_file_id: ${operation.target_path || ""}`);
    if (!operation.target_name) throw new Error(`safe operation missing target_name: ${operation.drive_file_id}`);
    if (!operation.target_folder_path) throw new Error(`safe operation missing target_folder_path: ${operation.drive_file_id}`);
    if (
      operation.inferred_session_type === "private_1on1"
      && normalizeDrivePath(operation.target_folder_path) !== "do_not_publish/private_1on1"
    ) {
      throw new Error(`private_1on1 safe operation must target do_not_publish/private_1on1: ${operation.drive_file_id}`);
    }
  }
  for (const operation of copyPrefixCleanupOperations(plan)) {
    if (!operation.drive_file_id) throw new Error(`cleanup operation missing drive_file_id: ${operation.current_name || ""}`);
    if (!operation.target_name) throw new Error(`cleanup operation missing target_name: ${operation.drive_file_id}`);
    if (/^Copy of\s+/i.test(operation.target_name)) {
      throw new Error(`cleanup operation target still has Copy of prefix: ${operation.drive_file_id}`);
    }
  }
}

async function ensureFolders({ plan, accessToken, apply = false, fetchImpl = fetch }) {
  const sharedDriveId = plan.source_drive?.shared_drive_id || null;
  const folderIds = new Map();
  const results = [];

  for (const operation of plan.folder_operations || []) {
    const folderPath = normalizeDrivePath(operation.path);
    if (!folderPath) continue;
    if (operation.known_folder_id) {
      folderIds.set(folderPath, operation.known_folder_id);
      if (!apply) {
        results.push({ path: folderPath, action: "known", id: operation.known_folder_id });
        continue;
      }
      const current = await getFileMetadata({ accessToken, fileId: operation.known_folder_id, fetchImpl });
      if (current.name === operation.name) {
        results.push({ path: folderPath, action: "known", id: operation.known_folder_id, name: current.name });
        continue;
      }
      const updated = await updateFile({
        accessToken,
        fileId: operation.known_folder_id,
        body: { name: operation.name },
        fetchImpl,
      });
      results.push({
        path: folderPath,
        action: "renamed",
        id: operation.known_folder_id,
        previous_name: current.name,
        name: updated.name,
      });
      continue;
    }
    const parentPath = normalizeDrivePath(operation.parent_path || "");
    const parentId = parentPath
      ? folderIds.get(parentPath)
      : sharedDriveId || plan.source_drive?.raw_folder_id || null;
    if (!parentId) throw new Error(`cannot resolve parent folder for ${folderPath}`);
    if (!apply) {
      const dryRunId = `dry-run:${folderPath}`;
      folderIds.set(folderPath, dryRunId);
      results.push({ path: folderPath, action: "would_ensure", id: dryRunId, parent_id: parentId });
      continue;
    }
    const existing = await listFoldersByName({
      accessToken,
      sharedDriveId,
      parentId,
      name: operation.name,
      fetchImpl,
    });
    if (existing[0]) {
      const folder = existing[0];
      folderIds.set(folderPath, folder.id);
      results.push({
        path: folderPath,
        action: "unchanged",
        id: folder.id,
        parent_id: parentId,
      });
      continue;
    }

    let legacyFolder = null;
    for (const name of legacyNames(operation)) {
      const matches = await listFoldersByName({
        accessToken,
        sharedDriveId,
        parentId,
        name,
        fetchImpl,
      });
      if (matches[0]) {
        legacyFolder = matches[0];
        break;
      }
    }
    if (legacyFolder) {
      const updated = await updateFile({
        accessToken,
        fileId: legacyFolder.id,
        body: { name: operation.name },
        fetchImpl,
      });
      folderIds.set(folderPath, legacyFolder.id);
      results.push({
        path: folderPath,
        action: "renamed",
        id: legacyFolder.id,
        parent_id: parentId,
        previous_name: legacyFolder.name,
        name: updated.name,
      });
      continue;
    }

    const folder = await createFolder({
      accessToken,
      sharedDriveId,
      parentId,
      name: operation.name,
      fetchImpl,
    });
    folderIds.set(folderPath, folder.id);
    results.push({
      path: folderPath,
      action: "created",
      id: folder.id,
      parent_id: parentId,
    });
  }

  return { folderIds, results };
}

async function applyFileOperations({ plan, accessToken, folderIds, apply = false, fetchImpl = fetch }) {
  const results = [];
  for (const operation of safeFileOperations(plan)) {
    const targetFolderPath = normalizeDrivePath(operation.target_folder_path);
    const targetFolderId = folderIds.get(targetFolderPath);
    if (!targetFolderId) throw new Error(`target folder not resolved for ${operation.target_path}`);
    if (!apply) {
      results.push({
        drive_file_id: operation.drive_file_id,
        action: "would_update",
        target_name: operation.target_name,
        target_folder_path: targetFolderPath,
      });
      continue;
    }
    const current = await getFileMetadata({ accessToken, fileId: operation.drive_file_id, fetchImpl });
    const parents = current.parents || [];
    const renameNeeded = current.name !== operation.target_name;
    const moveNeeded = !parents.includes(targetFolderId);
    if (!renameNeeded && !moveNeeded) {
      results.push({
        drive_file_id: operation.drive_file_id,
        action: "unchanged",
        name: current.name,
        target_folder_path: targetFolderPath,
      });
      continue;
    }
    const removeParents = moveNeeded ? parents.filter((parent) => parent !== targetFolderId).join(",") : null;
    const updated = await updateFile({
      accessToken,
      fileId: operation.drive_file_id,
      body: renameNeeded ? { name: operation.target_name } : {},
      addParents: moveNeeded ? targetFolderId : null,
      removeParents,
      fetchImpl,
    });
    results.push({
      drive_file_id: operation.drive_file_id,
      action: "updated",
      renamed: renameNeeded,
      moved: moveNeeded,
      name: updated.name,
      target_folder_path: targetFolderPath,
    });
  }
  return results;
}

async function applyCopyPrefixCleanupOperations({ plan, accessToken, apply = false, fetchImpl = fetch }) {
  const results = [];
  for (const operation of copyPrefixCleanupOperations(plan)) {
    if (!apply) {
      results.push({
        drive_file_id: operation.drive_file_id,
        action: "would_cleanup_copy_prefix",
        target_name: operation.target_name,
      });
      continue;
    }
    const current = await getFileMetadata({ accessToken, fileId: operation.drive_file_id, fetchImpl });
    if (!/^Copy of\s+/i.test(current.name || "")) {
      results.push({
        drive_file_id: operation.drive_file_id,
        action: "unchanged",
        name: current.name,
        reason: "copy_prefix_already_absent",
      });
      continue;
    }
    const updated = await updateFile({
      accessToken,
      fileId: operation.drive_file_id,
      body: { name: operation.target_name },
      fetchImpl,
    });
    results.push({
      drive_file_id: operation.drive_file_id,
      action: "updated",
      renamed: true,
      moved: false,
      name: updated.name,
      final_target_path_pending_review: operation.final_target_path,
    });
  }
  return results;
}

export async function runTranscriptDriveOperations({
  plan,
  accessToken,
  apply = false,
  fetchImpl = fetch,
} = {}) {
  assertPlanSafe(plan);
  if (apply && !accessToken) throw new Error("accessToken is required with apply=true");
  const folderResult = await ensureFolders({ plan, accessToken, apply, fetchImpl });
  const fileResults = await applyFileOperations({
    plan,
    accessToken,
    folderIds: folderResult.folderIds,
    apply,
    fetchImpl,
  });
  const cleanupResults = await applyCopyPrefixCleanupOperations({
    plan,
    accessToken,
    apply,
    fetchImpl,
  });
  return {
    apply: !!apply,
    planned_safe_file_operations: safeFileOperations(plan).length,
    planned_copy_prefix_cleanup_operations: copyPrefixCleanupOperations(plan).length,
    review_file_operations_skipped: (plan.review_file_operations || []).length,
    folders: folderResult.results,
    files: fileResults,
    copy_prefix_cleanup_files: cleanupResults,
    counts: {
      folders_created: folderResult.results.filter((item) => item.action === "created").length,
      folders_renamed: folderResult.results.filter((item) => item.action === "renamed").length,
      folders_unchanged: folderResult.results.filter((item) => item.action === "unchanged" || item.action === "known").length,
      files_updated: fileResults.filter((item) => item.action === "updated").length,
      files_unchanged: fileResults.filter((item) => item.action === "unchanged").length,
      copy_prefix_cleanup_updated: cleanupResults.filter((item) => item.action === "updated").length,
      copy_prefix_cleanup_unchanged: cleanupResults.filter((item) => item.action === "unchanged").length,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  const envPath = arg("--env-file", argv);
  if (envPath) loadEnvFile(envPath, { override: true });
  const planPath = path.resolve(arg("--plan", argv) || DEFAULT_PLAN_PATH);
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const accessToken = await resolveGoogleAccessToken({ accessToken: arg("--access-token", argv) });
  const result = await runTranscriptDriveOperations({
    plan: readJson(planPath),
    accessToken,
    apply,
  });
  const outPath = arg("--out", argv);
  if (outPath) writeJson(path.resolve(outPath), result);
  console.log(JSON.stringify({
    apply: result.apply,
    planned_safe_file_operations: result.planned_safe_file_operations,
    planned_copy_prefix_cleanup_operations: result.planned_copy_prefix_cleanup_operations,
    review_file_operations_skipped: result.review_file_operations_skipped,
    counts: result.counts,
    ...(outPath ? { wrote: path.relative(ROOT, path.resolve(outPath)) } : {}),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

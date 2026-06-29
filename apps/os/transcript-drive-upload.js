const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POLICY_PATH = path.join(REPO_ROOT, "cohort-data", "policies", "transcript-routing-policy.json");
const PRIVATE_VAULT_PLAN_PATH = path.join(REPO_ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const DEFAULT_POLICY = {
  policy_key: "transcript-routing",
  version: "fallback",
  drive_vault: {
    shared_drive_name: "Shape Rotator Transcript Vault",
    root_folders: {
      raw: "raw_transcripts",
      do_not_publish: "do_not_publish",
      needs_calendar_match: "needs_calendar_match",
    },
    folder_routes: {
      weekly_standup: { path: "raw_transcripts/weekly_standup" },
      office_hours: { path: "raw_transcripts/office_hours" },
      private_1on1: { path: "do_not_publish/private_1on1" },
      salon: { path: "raw_transcripts/salon" },
      rd_jam: { path: "raw_transcripts/rd_jam" },
      demo_presentation: { path: "raw_transcripts/demo_presentation" },
      user_interview: { path: "raw_transcripts/user_interview" },
      planning_strategy: { path: "do_not_publish/planning_strategy" },
      unknown: { path: "needs_calendar_match" },
    },
  },
  session_types: {
    weekly_standup: { label: "Weekly standup", description: "Individual status session." },
    office_hours: { label: "Office hours", description: "Project support or product office-hours session." },
    private_1on1: { label: "Private 1:1", description: "Private coaching, coordinator feedback, or sensitive one-on-one." },
    salon: { label: "Salon", description: "Topic-led or speaker-led session." },
    rd_jam: { label: "R&D / jam", description: "Product or technical idea-stage session." },
    demo_presentation: { label: "Demo / presentation", description: "Project or product demo." },
    user_interview: { label: "User interview", description: "External subject interview." },
    planning_strategy: { label: "Planning / strategy", description: "Coordinator governance or strategy session." },
  },
};

const EXT_MIME = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".vtt", "text/vtt"],
  [".srt", "application/x-subrip"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pdf", "application/pdf"],
  [".rtf", "application/rtf"],
]);

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseEnvLineValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === "\""
      ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
      : inner;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseEnvFile(text) {
  const values = {};
  String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) return;
      values[match[1]] = parseEnvLineValue(match[2]);
    });
  return values;
}

function mergedEnv(baseEnv = process.env) {
  const out = { ...baseEnv };
  const candidates = [
    path.join(REPO_ROOT, ".env.calendar.local"),
    path.join(REPO_ROOT, ".env.local"),
    path.join(REPO_ROOT, "cohort-data", ".private", "google-oauth.env"),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = parseEnvFile(fs.readFileSync(filePath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (out[key] == null || out[key] === "") out[key] = value;
      }
    } catch {
      // Ignore optional local env files; the upload call reports missing auth.
    }
  }
  return out;
}

function loadTranscriptPolicy({ policyPath = POLICY_PATH } = {}) {
  const policy = readJson(policyPath, null);
  if (policy && policy.session_types && policy.drive_vault) return policy;
  return DEFAULT_POLICY;
}

function sessionTypeEntries(policy = loadTranscriptPolicy()) {
  return Object.entries(policy.session_types || DEFAULT_POLICY.session_types)
    .map(([key, value]) => ({
      key,
      label: value?.label || key.replace(/_/g, " "),
      description: value?.description || "",
      maxTier: value?.max_tier || "",
      publicAllowed: !!value?.public_allowed,
      routePath: driveRouteForTranscriptType(policy, key).path,
    }));
}

function getTranscriptUploadOptions() {
  const policy = loadTranscriptPolicy();
  return {
    ok: true,
    policyKey: policy.policy_key || "transcript-routing",
    policyVersion: policy.version || "",
    sessionTypes: sessionTypeEntries(policy),
  };
}

function normalizeDrivePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function driveRouteForTranscriptType(policy, sessionType) {
  const key = String(sessionType || "").trim();
  const routes = policy?.drive_vault?.folder_routes || DEFAULT_POLICY.drive_vault.folder_routes;
  if (!key || !policy?.session_types?.[key]) {
    const error = new Error("Choose a transcript type before uploading.");
    error.code = "invalid_session_type";
    throw error;
  }
  const route = routes[key] || routes.unknown;
  const routePath = normalizeDrivePath(route?.path || "needs_calendar_match");
  return { ...route, path: routePath };
}

function safeSlug(value, fallback = "transcript") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 90);
  return slug || fallback;
}

function suggestTranscriptDriveName({ sessionType, originalName, label }) {
  const ext = path.extname(String(originalName || "")).toLowerCase() || ".txt";
  const base = path.basename(String(originalName || "transcript"), path.extname(String(originalName || "")));
  const stem = safeSlug(label || base, "transcript");
  const type = safeSlug(sessionType, "unknown").replace(/-/g, "_");
  const prefixed = stem.startsWith(`${type}_`) || stem.startsWith(`${type}-`);
  return `${prefixed ? stem : `${type}_${stem}`}${ext}`;
}

function mimeTypeForFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return EXT_MIME.get(ext) || "application/octet-stream";
}

function validateUploadFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    const error = new Error("Selected path is not a file.");
    error.code = "not_file";
    throw error;
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    const error = new Error(`Transcript upload is limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
    error.code = "file_too_large";
    throw error;
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!EXT_MIME.has(ext)) {
    const error = new Error("Choose a transcript text, caption, document, or PDF file.");
    error.code = "unsupported_file_type";
    throw error;
  }
  return { resolved, stat, ext };
}

async function refreshGoogleAccessToken({ env, fetchImpl = fetch }) {
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
    const error = new Error(`Google OAuth token refresh failed (${response.status}).`);
    error.code = "google_oauth_refresh_failed";
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload.access_token;
}

async function resolveGoogleAccessToken({ env, fetchImpl = fetch }) {
  const refreshed = await refreshGoogleAccessToken({ env, fetchImpl });
  return refreshed || env.GOOGLE_CALENDAR_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || null;
}

function driveUrl(base, pathname, params = {}) {
  const url = new URL(`${base}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveJson({ accessToken, method = "GET", url, body, fetchImpl = fetch }) {
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
    const error = new Error(`Google Drive ${method} failed (${response.status}).`);
    error.code = "google_drive_request_failed";
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data || {};
}

async function findSharedDriveByName({ accessToken, name, fetchImpl = fetch }) {
  if (!name) return null;
  const url = driveUrl(DRIVE_API, "/drives", {
    q: `name='${escapeDriveQueryValue(name)}'`,
    pageSize: "10",
    fields: "drives(id,name)",
  });
  const data = await driveJson({ accessToken, url, fetchImpl });
  const match = (data.drives || []).find((drive) => drive?.name === name) || (data.drives || [])[0];
  return match?.id || null;
}

async function listFoldersByName({ accessToken, driveId, parentId, name, fetchImpl = fetch }) {
  const q = [
    `'${escapeDriveQueryValue(parentId)}' in parents`,
    "trashed=false",
    `mimeType='${FOLDER_MIME_TYPE}'`,
    `name='${escapeDriveQueryValue(name)}'`,
  ].join(" and ");
  const url = driveUrl(DRIVE_API, "/files", {
    q,
    fields: "files(id,name,parents)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    ...(driveId ? { driveId, corpora: "drive" } : {}),
  });
  const data = await driveJson({ accessToken, url, fetchImpl });
  return data.files || [];
}

async function createFolder({ accessToken, driveId, parentId, name, fetchImpl = fetch }) {
  const url = driveUrl(DRIVE_API, "/files", {
    supportsAllDrives: "true",
    ...(driveId ? { driveId } : {}),
    fields: "id,name,parents",
  });
  return driveJson({
    accessToken,
    method: "POST",
    url,
    body: {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId],
    },
    fetchImpl,
  });
}

async function ensureFolderPath({ accessToken, driveId, parentId, folderPath, fetchImpl = fetch }) {
  let currentParent = parentId;
  const parts = normalizeDrivePath(folderPath).split("/").filter(Boolean);
  for (const part of parts) {
    const existing = await listFoldersByName({ accessToken, driveId, parentId: currentParent, name: part, fetchImpl });
    const folder = existing[0] || await createFolder({ accessToken, driveId, parentId: currentParent, name: part, fetchImpl });
    currentParent = folder.id;
  }
  return currentParent;
}

function loadVaultPlan() {
  return readJson(PRIVATE_VAULT_PLAN_PATH, {});
}

async function resolveDriveContext({ accessToken, env, policy, fetchImpl = fetch }) {
  const plan = loadVaultPlan();
  const sourceDrive = plan && typeof plan === "object" ? plan.source_drive || {} : {};
  const driveName = policy?.drive_vault?.shared_drive_name || DEFAULT_POLICY.drive_vault.shared_drive_name;
  const explicitRootFolderId =
    env.GOOGLE_TRANSCRIPT_DRIVE_ROOT_FOLDER_ID ||
    env.GOOGLE_TRANSCRIPT_VAULT_ROOT_FOLDER_ID ||
    env.GOOGLE_DRIVE_TRANSCRIPT_ROOT_FOLDER_ID ||
    env.GOOGLE_TRANSCRIPT_DRIVE_FOLDER_ID ||
    env.GOOGLE_TRANSCRIPT_VAULT_FOLDER_ID ||
    "";
  let driveId =
    env.GOOGLE_TRANSCRIPT_DRIVE_ID ||
    env.GOOGLE_TRANSCRIPT_VAULT_DRIVE_ID ||
    env.GOOGLE_DRIVE_TRANSCRIPT_VAULT_ID ||
    sourceDrive.shared_drive_id ||
    env.GOOGLE_DRIVE_ID ||
    "";
  if (!driveId && !explicitRootFolderId) {
    driveId = await findSharedDriveByName({ accessToken, name: driveName, fetchImpl });
  }
  const rootFolderId = explicitRootFolderId || driveId || "";
  const rawFolderId =
    env.GOOGLE_TRANSCRIPT_RAW_FOLDER_ID ||
    env.GOOGLE_DRIVE_TRANSCRIPT_RAW_FOLDER_ID ||
    sourceDrive.raw_folder_id ||
    "";
  if (!rootFolderId) {
    const error = new Error("No transcript Drive target is configured.");
    error.code = "missing_google_drive_target";
    throw error;
  }
  return { driveId, rootFolderId, rawFolderId };
}

async function ensureRouteFolder({ accessToken, driveId, rootFolderId, rawFolderId, routePath, fetchImpl = fetch }) {
  const normalized = normalizeDrivePath(routePath);
  if (rawFolderId && normalized === "raw_transcripts") return rawFolderId;
  if (rawFolderId && normalized.startsWith("raw_transcripts/")) {
    return ensureFolderPath({
      accessToken,
      driveId,
      parentId: rawFolderId,
      folderPath: normalized.slice("raw_transcripts/".length),
      fetchImpl,
    });
  }
  return ensureFolderPath({ accessToken, driveId, parentId: rootFolderId, folderPath: normalized, fetchImpl });
}

async function uploadMultipartFile({ accessToken, driveId, filePath, metadata, mimeType, fetchImpl = fetch }) {
  const boundary = `sros_${crypto.randomBytes(12).toString("hex")}`;
  const fileBuffer = fs.readFileSync(filePath);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, fileBuffer, tail]);
  const url = driveUrl(DRIVE_UPLOAD_API, "/files", {
    uploadType: "multipart",
    supportsAllDrives: "true",
    ...(driveId ? { driveId } : {}),
    fields: "id,name,mimeType,parents,webViewLink,webContentLink",
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": `multipart/related; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.id) {
    const error = new Error(`Google Drive upload failed (${response.status}).`);
    error.code = "google_drive_upload_failed";
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function uploadTranscriptFile({
  filePath,
  sessionType,
  label = "",
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const policy = loadTranscriptPolicy();
  const route = driveRouteForTranscriptType(policy, sessionType);
  const { resolved, stat } = validateUploadFile(filePath);
  const resolvedEnv = mergedEnv(env);
  const accessToken = await resolveGoogleAccessToken({ env: resolvedEnv, fetchImpl });
  if (!accessToken) {
    return {
      ok: false,
      reason: "missing_google_drive_auth",
      detail: "Set GOOGLE_OAUTH_REFRESH_TOKEN with GOOGLE_OAUTH_CLIENT_ID/SECRET, or GOOGLE_ACCESS_TOKEN.",
    };
  }
  let driveContext;
  try {
    driveContext = await resolveDriveContext({ accessToken, env: resolvedEnv, policy, fetchImpl });
  } catch (error) {
    if (error.code === "missing_google_drive_target") {
      return {
        ok: false,
        reason: error.code,
        detail: "Set GOOGLE_TRANSCRIPT_DRIVE_ID, GOOGLE_TRANSCRIPT_DRIVE_ROOT_FOLDER_ID, or GOOGLE_DRIVE_ID for the transcript vault.",
      };
    }
    throw error;
  }
  const parentId = await ensureRouteFolder({
    accessToken,
    driveId: driveContext.driveId,
    rootFolderId: driveContext.rootFolderId,
    rawFolderId: driveContext.rawFolderId,
    routePath: route.path,
    fetchImpl,
  });
  const driveName = suggestTranscriptDriveName({
    sessionType,
    originalName: path.basename(resolved),
    label,
  });
  const uploadedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const metadata = {
    name: driveName,
    parents: [parentId],
    appProperties: {
      shape_source: "shape_rotator_os",
      declared_session_type: String(sessionType),
      transcript_route_path: route.path,
      uploaded_at: uploadedAt,
    },
  };
  const uploaded = await uploadMultipartFile({
    accessToken,
    driveId: driveContext.driveId,
    filePath: resolved,
    metadata,
    mimeType: mimeTypeForFile(resolved),
    fetchImpl,
  });
  return {
    ok: true,
    sessionType,
    routePath: route.path,
    targetPath: `${route.path}/${driveName}`,
    name: uploaded.name || driveName,
    driveFileId: uploaded.id,
    webViewLink: uploaded.webViewLink || null,
    webContentLink: uploaded.webContentLink || null,
    sizeBytes: stat.size,
  };
}

async function pickAndUploadTranscript({ browserWindow, dialogImpl, sessionType, label = "", env = process.env, fetchImpl = fetch } = {}) {
  const policy = loadTranscriptPolicy();
  driveRouteForTranscriptType(policy, sessionType);
  const dialogApi = dialogImpl || require("electron").dialog;
  const selection = await dialogApi.showOpenDialog(browserWindow, {
    title: "Add transcript",
    properties: ["openFile"],
    filters: [
      { name: "Transcripts", extensions: ["txt", "md", "markdown", "vtt", "srt", "csv", "json", "doc", "docx", "pdf", "rtf"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (selection?.canceled || !selection?.filePaths?.[0]) return { ok: false, reason: "canceled" };
  return uploadTranscriptFile({ filePath: selection.filePaths[0], sessionType, label, env, fetchImpl });
}

module.exports = {
  DEFAULT_POLICY,
  DRIVE_API,
  DRIVE_UPLOAD_API,
  MAX_UPLOAD_BYTES,
  getTranscriptUploadOptions,
  loadTranscriptPolicy,
  driveRouteForTranscriptType,
  suggestTranscriptDriveName,
  uploadTranscriptFile,
  pickAndUploadTranscript,
};

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  buildProcessingJobsFromSourceArtifacts,
  captureArtifactToSourceArtifact,
  meetArtifactRowsFromManifest,
} = require("./lib/calendar-integration.cjs");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");

const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_MATCH_WINDOW_HOURS = 72;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_DEPTH = 6;
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function usage() {
  return [
    "Usage:",
    "  node scripts/poll-google-drive-artifacts.js --drive-folder-id FOLDER_ID --access-token TOKEN --sessions sessions.json",
    "  node scripts/poll-google-drive-artifacts.js --drive-folder-id FOLDER_ID --access-token TOKEN --org-id ORG_ID --supabase-url URL --service-role-key KEY --apply",
    "",
    "Options:",
    "  --apply                         Persist capture/source artifacts, queue jobs, and mark sessions source_ready",
    "  --sessions sessions.json          Fixture sessions; use '-' for stdin",
    "  --org-id ORG_ID",
    "  --drive-folder-id FOLDER_ID       Drive folder to scan for Meet/Gemini artifacts",
    "  --drive-id DRIVE_ID               Shared Drive id, when scanning a shared drive",
    "  --modified-after ISO_DATETIME     Optional Drive modifiedTime lower bound",
    "  --lookback-hours N                Supabase session lookback, default 168",
    "  --match-window-hours N            Match files created/modified within N hours after session end, default 72",
    "  --page-size N                     Drive page size, default 100",
    "  --recursive                       Scan child folders below --drive-folder-id",
    "  --max-depth N                     Max child-folder depth when --recursive is set, default 6",
    "  --out rows.json",
    "  --env-file FILE                   Load local KEY=value secrets before env fallbacks",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_REFRESH_TOKEN + GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET",
    "  SHAPE_SUPABASE_URL or SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  ORG_ID",
  ].join("\n");
}

async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch } = {}) {
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

async function resolveGoogleAccessToken({ accessToken, env = process.env, fetchImpl = fetch } = {}) {
  if (accessToken) return accessToken;
  if (env.GOOGLE_OAUTH_REFRESH_TOKEN && env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return await refreshGoogleAccessToken({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      fetchImpl,
    });
  }
  return env.GOOGLE_CALENDAR_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || null;
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function intArg(name, fallback, argv = process.argv) {
  const value = arg(name, argv);
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeIntArg(name, fallback, argv = process.argv) {
  const value = arg(name, argv);
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function readJson(filePath) {
  if (!filePath || filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  const json = JSON.stringify(value, null, 2) + "\n";
  if (!filePath || filePath === "-") process.stdout.write(json);
  else fs.writeFileSync(path.resolve(filePath), json);
}

function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildDriveFilesListUrl({
  folderId,
  driveId,
  pageToken,
  modifiedAfter,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  if (!folderId) throw new Error("drive folder id is required");
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  const query = [`'${escapeDriveQueryValue(folderId)}' in parents`, "trashed=false"];
  if (modifiedAfter) query.push(`modifiedTime > '${escapeDriveQueryValue(modifiedAfter)}'`);
  url.searchParams.set("q", query.join(" and "));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("fields", [
    "nextPageToken",
    "files(id,name,mimeType,size,webViewLink,webContentLink,createdTime,modifiedTime,parents,description)",
  ].join(","));
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (driveId) {
    url.searchParams.set("driveId", driveId);
    url.searchParams.set("corpora", "drive");
  }
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

function isDriveFolder(file) {
  return file?.mimeType === DRIVE_FOLDER_MIME_TYPE;
}

function withDrivePath(file, { parentFolderId, parentPath = "", depth = 1 } = {}) {
  const name = String(file?.name || file?.id || "untitled");
  const drivePath = parentPath ? `${parentPath}/${name}` : name;
  return {
    ...file,
    parent_folder_id: parentFolderId || null,
    drive_path: drivePath,
    depth,
  };
}

async function listDriveFolderChildren({
  folderId,
  driveId,
  accessToken,
  modifiedAfter,
  pageSize = DEFAULT_PAGE_SIZE,
  fetchImpl = fetch,
} = {}) {
  if (!accessToken) throw new Error("Google access token is required");
  const files = [];
  let nextPageToken = null;
  do {
    const url = buildDriveFilesListUrl({
      folderId,
      driveId,
      pageToken: nextPageToken,
      modifiedAfter,
      pageSize,
    });
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Google Drive files.list ${response.status}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    files.push(...(data.files || []));
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  return files;
}

async function fetchDriveFileInventory({
  folderId,
  driveId,
  accessToken,
  modifiedAfter,
  pageSize = DEFAULT_PAGE_SIZE,
  recursive = false,
  maxDepth = DEFAULT_MAX_DEPTH,
  fetchImpl = fetch,
} = {}) {
  if (!folderId) throw new Error("drive folder id is required");
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a non-negative integer");
  const queue = [{ id: folderId, path: "", depth: 0, root: true }];
  const scannedFolders = [];
  const folders = [];
  const files = [];
  const truncatedFolders = [];
  const seenFolders = new Set();

  while (queue.length) {
    const folder = queue.shift();
    if (seenFolders.has(folder.id)) continue;
    seenFolders.add(folder.id);
    scannedFolders.push(folder);
    const children = await listDriveFolderChildren({
      folderId: folder.id,
      driveId,
      accessToken,
      modifiedAfter,
      pageSize,
      fetchImpl,
    });
    for (const child of children) {
      const item = withDrivePath(child, {
        parentFolderId: folder.id,
        parentPath: folder.path,
        depth: folder.depth + 1,
      });
      if (isDriveFolder(item)) {
        folders.push(item);
        if (recursive && folder.depth < maxDepth) {
          queue.push({ id: item.id, path: item.drive_path, depth: item.depth, root: false });
        } else if (recursive) {
          truncatedFolders.push(item);
        }
        continue;
      }
      files.push(item);
    }
  }

  const allItems = [...folders, ...files];
  return {
    root_folder_id: folderId,
    drive_id: driveId || null,
    recursive: !!recursive,
    max_depth: recursive ? maxDepth : 0,
    scanned_folder_count: scannedFolders.length,
    folder_count: folders.length,
    file_count: files.length,
    max_observed_depth: allItems.reduce((max, item) => Math.max(max, item.depth || 0), 0),
    scanned_folders: scannedFolders,
    folders,
    files,
    truncated_folders: truncatedFolders,
  };
}

async function fetchDriveFiles(options = {}) {
  if (!options.recursive) {
    return listDriveFolderChildren(options);
  }
  const inventory = await fetchDriveFileInventory(options);
  return inventory.files;
}

function normalizeCode(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !["meeting", "transcript", "notes", "google", "meet", "gemini"].includes(token));
}

function classifyDriveArtifact(file) {
  const name = String(file?.name || "").toLowerCase();
  const mime = String(file?.mimeType || "").toLowerCase();
  if (/\b(attendance|attendees|participants)\b/.test(name)) return "attendance";
  if (/\b(recording|video)\b/.test(name) || mime.startsWith("video/")) return "recording";
  if (/\b(smart\s*notes?|gemini|meeting\s*notes?|summary|recap|action\s*items?)\b/.test(name)) return "smart_notes";
  if (/\b(transcript|captions?|closed\s*captions?)\b/.test(name)) return "transcript";
  if (mime === "text/plain" || mime === "text/vtt") return "transcript";
  if (mime === "application/vnd.google-apps.document" && /\b(notes?|transcript|summary|recap)\b/.test(name)) {
    return /\b(transcript|captions?)\b/.test(name) ? "transcript" : "smart_notes";
  }
  return null;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item) || "none";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function confidencePctForLabel(label) {
  switch (String(label || "").toLowerCase()) {
    case "high":
      return 92;
    case "moderate":
    case "medium":
      return 76;
    case "low":
      return 52;
    case "none":
      return 0;
    default:
      return 35;
  }
}

function driveMetadataText(file) {
  return [
    file?.name,
    file?.description,
    file?.mimeType,
    file?.webViewLink,
    file?.webContentLink,
    file?.drive_path,
    file?.provider,
    file?.source_provider,
    file?.source_system,
    file?.source_kind,
  ].filter(Boolean).join(" ");
}

function classifyDriveSourceSystem(file) {
  const raw = driveMetadataText(file);
  const lower = raw.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const explicitProvider = String(file?.provider || file?.source_provider || file?.source_system || "").toLowerCase();
  const explicitSourceKind = String(file?.source_kind || "").toLowerCase();
  const artifactKind = classifyDriveArtifact(file);
  const signals = [];

  if (explicitProvider === "otter" || explicitSourceKind.startsWith("otter_")) signals.push("explicit_otter_source");
  if (/\botter\b|otter\.ai|otter_ai/.test(lower) || /\botter\b/.test(normalized)) signals.push("otter_metadata_marker");

  if (["google_meet", "gmeet", "meet"].includes(explicitProvider) || explicitSourceKind.startsWith("meet_")) {
    signals.push("explicit_google_meet_source");
  }
  if (/\bgoogle meet\b|\bgmeet\b|meet\.google\.com|conferencerecords|conference_records/.test(lower)) {
    signals.push("google_meet_metadata_marker");
  }
  if (/\b(gemini|smart notes|smartnotes)\b/.test(normalized)) signals.push("google_meet_notes_marker");
  if (artifactKind && !signals.some((signal) => signal.includes("otter"))) signals.push("google_meet_artifact_candidate");

  const hasOtter = signals.some((signal) => signal.includes("otter"));
  const hasMeet = signals.some((signal) => signal.includes("google_meet"));
  if (hasOtter && !hasMeet) {
    const sourceKind = /\b(summary|summaries|notes|recap)\b/.test(normalized)
      ? "otter_summary"
      : /\b(slide|slides|screenshot|screenshots|screen capture|screen captures|image|images)\b/.test(normalized)
        ? "otter_slide"
        : "otter_transcript";
    const confidence = signals.includes("explicit_otter_source") ? "high" : "moderate";
    return {
      source_system: "otter",
      provider: "otter",
      source_kind: sourceKind,
      artifact_kind: sourceKind === "otter_summary" ? "summary" : sourceKind === "otter_slide" ? "slides" : "transcript",
      confidence,
      confidence_pct: confidencePctForLabel(confidence),
      signals: [...new Set(signals)],
    };
  }
  if (hasMeet && !hasOtter) {
    const sourceKind = artifactKind === "smart_notes" ? "meet_smart_notes" : "meet_transcript";
    const confidence = signals.some((signal) => [
      "explicit_google_meet_source",
      "google_meet_metadata_marker",
      "google_meet_notes_marker",
      "google_meet_artifact_candidate",
    ].includes(signal))
      ? "high"
      : "low";
    return {
      source_system: "google_meet",
      provider: "google_meet",
      source_kind: sourceKind,
      artifact_kind: artifactKind || "transcript",
      confidence,
      confidence_pct: confidencePctForLabel(confidence),
      signals: [...new Set(signals)],
    };
  }
  if (hasOtter && hasMeet) {
    return {
      source_system: "ambiguous",
      provider: "manual",
      source_kind: "drive_doc",
      artifact_kind: artifactKind || null,
      confidence: "low",
      confidence_pct: confidencePctForLabel("low"),
      signals: [...new Set(signals)],
    };
  }
  return {
    source_system: "drive",
    provider: "manual",
    source_kind: "drive_doc",
    artifact_kind: artifactKind || null,
    confidence: "low",
    confidence_pct: confidencePctForLabel("low"),
    signals: [],
  };
}

function buildDriveInventoryAudit(inventory) {
  const classifiedFiles = (inventory.files || []).map((file) => ({
    id: file.id || null,
    name: file.name || null,
    mimeType: file.mimeType || null,
    drive_path: file.drive_path || file.name || null,
    depth: file.depth || 0,
    ...classifyDriveSourceSystem(file),
  }));
  return {
    root_folder_id: inventory.root_folder_id,
    drive_id: inventory.drive_id || null,
    recursive: !!inventory.recursive,
    max_depth: inventory.max_depth,
    scanned_folder_count: inventory.scanned_folder_count,
    folder_count: inventory.folder_count,
    file_count: inventory.file_count,
    max_observed_depth: inventory.max_observed_depth,
    truncated_folder_count: (inventory.truncated_folders || []).length,
    by_depth: countBy(classifiedFiles, (file) => String(file.depth || 0)),
    by_source_system: countBy(classifiedFiles, (file) => file.source_system),
    by_source_kind: countBy(classifiedFiles, (file) => file.source_kind),
    by_artifact_kind: countBy(classifiedFiles, (file) => file.artifact_kind || "unclassified"),
    deepest_files: classifiedFiles
      .slice()
      .sort((a, b) => (b.depth || 0) - (a.depth || 0) || String(a.drive_path).localeCompare(String(b.drive_path)))
      .slice(0, 10),
    files: classifiedFiles,
  };
}

function fileEventTime(file) {
  const value = file?.createdTime || file?.modifiedTime;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sessionTimeWindowScore(file, session, { matchWindowHours = DEFAULT_MATCH_WINDOW_HOURS } = {}) {
  const fileTime = fileEventTime(file);
  const end = new Date(session?.ends_at || session?.end || session?.end_time);
  const start = new Date(session?.starts_at || session?.start || session?.start_time || end);
  if (!fileTime || !Number.isFinite(end.getTime())) return 0;
  const earliest = Number.isFinite(start.getTime()) ? start.getTime() - 6 * 60 * 60 * 1000 : end.getTime() - 6 * 60 * 60 * 1000;
  const latest = end.getTime() + matchWindowHours * 60 * 60 * 1000;
  if (fileTime.getTime() < earliest || fileTime.getTime() > latest) return 0;
  return 20;
}

function titleOverlapScore(file, session) {
  const fileTokens = new Set(tokenize(file?.name));
  const titleTokens = tokenize(session?.public_title || session?.title);
  if (!fileTokens.size || !titleTokens.length) return 0;
  const hits = titleTokens.filter((token) => fileTokens.has(token)).length;
  const ratio = hits / Math.max(1, titleTokens.length);
  return ratio >= 0.5 ? 40 + Math.round(ratio * 20) : 0;
}

function meetingCodeScore(file, session) {
  const code = normalizeCode(session?.google_meeting_code);
  if (!code) return 0;
  const haystack = normalizeCode([file?.name, file?.description, file?.webViewLink].filter(Boolean).join(" "));
  return haystack.includes(code) ? 100 : 0;
}

function scoreDriveFileForSession(file, session, options = {}) {
  const code = meetingCodeScore(file, session);
  if (code) return code + sessionTimeWindowScore(file, session, options);
  const time = sessionTimeWindowScore(file, session, options);
  if (!time) return 0;
  return time + titleOverlapScore(file, session);
}

function matchDriveFileToSession(file, sessions, options = {}) {
  const kind = classifyDriveArtifact(file);
  if (!kind) return null;
  let best = null;
  for (const session of sessions || []) {
    const score = scoreDriveFileForSession(file, session, options);
    if (!best || score > best.score) best = { session, score };
  }
  if (!best || best.score < 50) return null;
  return { session: best.session, kind, score: best.score };
}

function driveExportUri(file) {
  if (file?.mimeType === "application/vnd.google-apps.document") {
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`;
  }
  return file?.webContentLink || null;
}

function driveFileToMeetArtifact(file, { kind, score } = {}) {
  const sourceInfo = classifyDriveSourceSystem(file);
  return {
    kind,
    provider_resource_name: `drive:${file.id}`,
    drive_file_id: file.id,
    drive_export_uri: driveExportUri(file),
    storage_ref: `drive://${file.id}`,
    title: file.name || null,
    mime_type: file.mimeType || null,
    size_bytes: file.size ? Number(file.size) : null,
    generated_at: file.createdTime || file.modifiedTime || null,
    status: "detected",
    match_score: score,
    web_view_link: file.webViewLink || null,
    metadata: {
      confidence_schema_version: 1,
      source_system: sourceInfo.source_system,
      source_kind: sourceInfo.source_kind,
      source_confidence: sourceInfo.confidence,
      source_confidence_pct: sourceInfo.confidence_pct,
      source_signals: sourceInfo.signals,
      session_match_score: score,
    },
  };
}

function buildDriveArtifactPlan({ orgId, sessions = [], files = [], matchWindowHours = DEFAULT_MATCH_WINDOW_HOURS } = {}) {
  const grouped = new Map();
  const unmatchedFiles = [];
  for (const file of files || []) {
    const match = matchDriveFileToSession(file, sessions, { matchWindowHours });
    if (!match) {
      unmatchedFiles.push({
        id: file.id || null,
        name: file.name || null,
        mimeType: file.mimeType || null,
        reason: classifyDriveArtifact(file) ? "no matching session" : "unrecognized artifact kind",
      });
      continue;
    }
    const sessionId = match.session.id;
    if (!grouped.has(sessionId)) grouped.set(sessionId, { session: match.session, artifacts: [] });
    grouped.get(sessionId).artifacts.push(driveFileToMeetArtifact(file, {
      kind: match.kind,
      score: match.score,
    }));
  }

  const manifests = [];
  const rows = {
    ingestionEvents: [],
    captureArtifacts: [],
    sourceArtifacts: [],
    processingJobs: [],
  };
  for (const { session, artifacts } of grouped.values()) {
    const manifest = {
      provider: "google_meet",
      meet_space: session.google_meet_space || null,
      conference_record: session.google_meet_space || session.google_meeting_code || session.google_event_id || null,
      source: "google_drive_poll",
      artifacts,
    };
    manifests.push({ session_id: session.id, manifest });
    const sessionRows = meetArtifactRowsFromManifest({
      orgId: orgId || session.org_id,
      sessionId: session.id,
      manifest,
      fetchedRaw: false,
    });
    rows.ingestionEvents.push(...sessionRows.ingestionEvents);
    rows.captureArtifacts.push(...sessionRows.captureArtifacts);
    rows.sourceArtifacts.push(...sessionRows.sourceArtifacts);
  }

  return {
    provider: "google_drive",
    matchedSessions: manifests.length,
    matchedFiles: rows.captureArtifacts.length,
    manifests,
    unmatchedFiles,
    ...rows,
  };
}

function captureKey(row) {
  return [
    row?.session_id || "",
    row?.provider || "",
    row?.artifact_kind || "",
    row?.provider_resource_name || "",
  ].join("\u0001");
}

function sourceSignature(row) {
  return [
    row?.source_kind || "",
    row?.storage_ref || "",
    row?.source_hash || "",
    row?.mime_type || "",
  ].join("\u0001");
}

function linkedSourceArtifacts({ orgId, rows, persistedCaptureArtifacts }) {
  const wanted = new Set((rows.sourceArtifacts || []).map(sourceSignature));
  const persistedByKey = new Map((persistedCaptureArtifacts || []).map((row) => [captureKey(row), row]));
  return (rows.captureArtifacts || [])
    .map((captureArtifact) => {
      const persisted = persistedByKey.get(captureKey(captureArtifact));
      if (!persisted?.id) return null;
      const candidate = captureArtifactToSourceArtifact({
        orgId: captureArtifact.org_id || orgId,
        sessionId: captureArtifact.session_id,
        captureArtifact: {
          ...captureArtifact,
          ...persisted,
          metadata: persisted.metadata || captureArtifact.metadata,
        },
        fetchedRaw: false,
      });
      return wanted.has(sourceSignature(candidate)) ? candidate : null;
    })
    .filter(Boolean);
}

async function upsertRows({ supabaseUrl, serviceRoleKey, table, rows, onConflict, fetchImpl }) {
  const body = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!body.length) return [];
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "POST",
    query: onConflict ? { on_conflict: onConflict } : {},
    prefer: onConflict ? "resolution=merge-duplicates,return=representation" : "return=representation",
    body,
    fetchImpl,
  });
}

function sourceArtifactConflict(rows) {
  return rows.length && rows.every((row) => row.capture_artifact_id && row.source_kind)
    ? "capture_artifact_id,source_kind"
    : undefined;
}

async function markSessionsSourceReady({ supabaseUrl, serviceRoleKey, orgId, sourceArtifacts, fetchImpl }) {
  const now = new Date().toISOString();
  const sessionIds = Array.from(new Set(
    (sourceArtifacts || []).map((artifact) => artifact?.session_id).filter(Boolean),
  ));
  const updated = [];
  for (const sessionId of sessionIds) {
    const rows = await supabaseServiceRequest({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      method: "PATCH",
      query: { id: `eq.${sessionId}`, org_id: `eq.${orgId}` },
      body: {
        transcript_status: "source_ready",
        bot_status: "transcript_uploaded",
        first_source_artifact_at: now,
      },
      fetchImpl,
    });
    updated.push(...(Array.isArray(rows) ? rows : []));
  }
  return updated;
}

async function applyDriveArtifactPlan({ supabaseUrl, serviceRoleKey, orgId, plan, policyVersion, dueAt, fetchImpl = fetch } = {}) {
  const ingestionEvents = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "ingestion_events",
    rows: plan.ingestionEvents,
    fetchImpl,
  });
  const captureArtifacts = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "capture_artifacts",
    rows: plan.captureArtifacts,
    onConflict: "session_id,provider,artifact_kind,provider_resource_name",
    fetchImpl,
  });
  const sourceArtifactRows = linkedSourceArtifacts({
    orgId,
    rows: plan,
    persistedCaptureArtifacts: captureArtifacts,
  });
  const sourceArtifacts = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "source_artifacts",
    rows: sourceArtifactRows,
    onConflict: sourceArtifactConflict(sourceArtifactRows),
    fetchImpl,
  });
  const processingJobRows = buildProcessingJobsFromSourceArtifacts({
    orgId,
    sourceArtifacts,
    policyVersion,
    dueAt,
    processorMode: "local",
  });
  const processingJobs = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    rows: processingJobRows,
    onConflict: "source_artifact_id,job_kind,prompt_version",
    fetchImpl,
  });
  const updatedSessions = await markSessionsSourceReady({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    sourceArtifacts,
    fetchImpl,
  });
  return {
    ingestionEvents,
    captureArtifacts,
    sourceArtifacts,
    processingJobs,
    updatedSessions,
    sourceArtifactRows,
    processingJobRows,
  };
}

async function fetchCandidateSessions({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  limit = 100,
  includeSourceReady = false,
  fetchImpl = fetch,
} = {}) {
  const now = new Date();
  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();
  const statuses = includeSourceReady
    ? "in.(expected,artifact_detected,source_ready,failed)"
    : "in.(expected,artifact_detected,failed)";
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    method: "GET",
    query: {
      select: "id,org_id,title,public_title,session_type,status,starts_at,ends_at,google_meeting_code,google_meet_space,google_event_id,transcript_status",
      org_id: `eq.${orgId}`,
      status: "neq.cancelled",
      transcript_status: statuses,
      ends_at: `gte.${since}`,
      order: "ends_at.desc",
      limit,
    },
    fetchImpl,
  });
}

async function runDriveArtifactPoll({
  accessToken,
  folderId,
  driveId,
  modifiedAfter,
  pageSize,
  recursive = false,
  maxDepth = DEFAULT_MAX_DEPTH,
  sessions,
  supabaseUrl,
  serviceRoleKey,
  orgId,
  lookbackHours,
  matchWindowHours,
  apply = false,
  policyVersion,
  dueAt,
  fetchImpl = fetch,
} = {}) {
  if (!orgId) throw new Error("orgId is required");
  if (apply && (!supabaseUrl || !serviceRoleKey)) {
    throw new Error("--apply requires Supabase URL and service-role key");
  }
  const resolvedSessions = sessions || await fetchCandidateSessions({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    lookbackHours,
    fetchImpl,
  });
  const inventory = await fetchDriveFileInventory({
    folderId,
    driveId,
    accessToken,
    modifiedAfter,
    pageSize,
    recursive,
    maxDepth,
    fetchImpl,
  });
  const files = inventory.files;
  const plan = buildDriveArtifactPlan({
    orgId,
    sessions: resolvedSessions,
    files,
    matchWindowHours,
  });
  const persisted = apply
    ? await applyDriveArtifactPlan({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        plan,
        policyVersion,
        dueAt,
        fetchImpl,
      })
    : null;
  return {
    source: {
      provider: "google_drive",
      folder_id: folderId,
      drive_id: driveId || null,
      recursive: !!recursive,
      max_depth: recursive ? maxDepth : 0,
      live: true,
    },
    fetched: {
      sessions: resolvedSessions.length,
      files: files.length,
      folders: inventory.folder_count,
      scanned_folders: inventory.scanned_folder_count,
      max_observed_depth: inventory.max_observed_depth,
    },
    audit: buildDriveInventoryAudit(inventory),
    ...plan,
    persisted: persisted || undefined,
  };
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const supabaseUrl = arg("--supabase-url", argv) || process.env.SHAPE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sessionsPath = arg("--sessions", argv);
  const accessToken = await resolveGoogleAccessToken({
    accessToken: arg("--access-token", argv),
  });
  const output = await runDriveArtifactPoll({
    accessToken,
    folderId: arg("--drive-folder-id", argv) || process.env.GOOGLE_DRIVE_ARTIFACT_FOLDER_ID,
    driveId: arg("--drive-id", argv) || process.env.GOOGLE_DRIVE_ID,
    modifiedAfter: arg("--modified-after", argv),
    pageSize: intArg("--page-size", DEFAULT_PAGE_SIZE, argv),
    recursive: flag("--recursive", argv),
    maxDepth: nonNegativeIntArg("--max-depth", DEFAULT_MAX_DEPTH, argv),
    sessions: sessionsPath ? readJson(sessionsPath) : null,
    supabaseUrl,
    serviceRoleKey,
    orgId: arg("--org-id", argv) || process.env.ORG_ID,
    lookbackHours: intArg("--lookback-hours", DEFAULT_LOOKBACK_HOURS, argv),
    matchWindowHours: intArg("--match-window-hours", DEFAULT_MATCH_WINDOW_HOURS, argv),
    apply: flag("--apply", argv),
    policyVersion: arg("--policy-version", argv),
    dueAt: arg("--due-at", argv),
  });
  writeJson(arg("--out", argv), output);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildDriveFilesListUrl,
  fetchDriveFileInventory,
  fetchDriveFiles,
  classifyDriveArtifact,
  classifyDriveSourceSystem,
  buildDriveInventoryAudit,
  matchDriveFileToSession,
  buildDriveArtifactPlan,
  applyDriveArtifactPlan,
  fetchCandidateSessions,
  resolveGoogleAccessToken,
  runDriveArtifactPoll,
};

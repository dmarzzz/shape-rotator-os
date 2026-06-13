import {
  buildProcessingJobsFromSourceArtifacts,
  captureArtifactToSourceArtifact,
  meetArtifactRowsFromManifest,
} from "../_shared/calendar.ts";
import { bearerToken, requireOrgRole } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse, optionalEnv, readJson, requiredEnv } from "../_shared/http.ts";
import { supabaseRest, upsertRows } from "../_shared/supabase_rest.ts";

const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_MATCH_WINDOW_HOURS = 72;
const DEFAULT_PAGE_SIZE = 100;
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function statusError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function workerAuthorized(req: Request) {
  const expected = optionalEnv("TRANSCRIPT_WORKER_TOKEN") || optionalEnv("SHAPE_TRANSCRIPT_WORKER_TOKEN");
  return !!expected && bearerToken(req) === expected;
}

async function authorizeDrivePoller({
  req,
  supabaseUrl,
  serviceRoleKey,
  orgId,
}: {
  req: Request;
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
}) {
  if (workerAuthorized(req)) return { mode: "worker-token", role: "worker" };
  const requester = await requireOrgRole({
    req,
    supabaseUrl,
    serviceRoleKey,
    orgId,
    roles: ["coordinator", "admin"],
  });
  return { mode: "user-jwt", role: requester.role, userId: requester.userId };
}

async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken }: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const error = new Error(`Google OAuth token refresh ${response.status}`) as Error & { status?: number; body?: unknown };
    error.status = 500;
    error.body = payload;
    throw error;
  }
  return payload.access_token;
}

async function resolveGoogleAccessToken() {
  const refreshToken = optionalEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (refreshToken && clientId && clientSecret) {
    return await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken });
  }
  const googleAccessToken = optionalEnv("GOOGLE_CALENDAR_ACCESS_TOKEN") || optionalEnv("GOOGLE_ACCESS_TOKEN");
  if (googleAccessToken) return googleAccessToken;
  throw new Error("Google OAuth refresh credentials or access token are required");
}

function escapeDriveQueryValue(value: string) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveFilesListUrl({
  folderId,
  driveId,
  pageToken,
  modifiedAfter,
  pageSize,
}: {
  folderId: string;
  driveId?: string;
  pageToken?: string | null;
  modifiedAfter?: string | null;
  pageSize: number;
}) {
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

async function listDriveFolderChildren({
  folderId,
  driveId,
  accessToken,
  modifiedAfter,
  pageSize,
}: {
  folderId: string;
  driveId?: string;
  accessToken: string;
  modifiedAfter?: string | null;
  pageSize: number;
}) {
  const files = [];
  let nextPageToken: string | null = null;
  do {
    const url = driveFilesListUrl({ folderId, driveId, pageToken: nextPageToken, modifiedAfter, pageSize });
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Google Drive files.list ${response.status}`) as Error & { status?: number; body?: unknown };
      error.status = response.status;
      error.body = data;
      throw error;
    }
    files.push(...(data.files || []));
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  return files;
}

function isDriveFolder(file: Record<string, unknown>) {
  return file?.mimeType === DRIVE_FOLDER_MIME_TYPE;
}

function withDrivePath(file: Record<string, unknown>, {
  parentFolderId,
  parentPath = "",
  depth = 1,
}: {
  parentFolderId?: string;
  parentPath?: string;
  depth?: number;
}) {
  const name = String(file?.name || file?.id || "untitled");
  return {
    ...file,
    parent_folder_id: parentFolderId || null,
    drive_path: parentPath ? `${parentPath}/${name}` : name,
    depth,
  };
}

async function fetchDriveInventory({
  folderId,
  driveId,
  accessToken,
  modifiedAfter,
  pageSize,
  recursive,
  maxDepth,
}: {
  folderId: string;
  driveId?: string;
  accessToken: string;
  modifiedAfter?: string | null;
  pageSize: number;
  recursive: boolean;
  maxDepth: number;
}) {
  const queue = [{ id: folderId, path: "", depth: 0 }];
  const folders = [];
  const files = [];
  const scannedFolders = [];
  const seenFolders = new Set<string>();

  while (queue.length) {
    const folder = queue.shift()!;
    if (seenFolders.has(folder.id)) continue;
    seenFolders.add(folder.id);
    scannedFolders.push(folder);
    const children = await listDriveFolderChildren({
      folderId: folder.id,
      driveId,
      accessToken,
      modifiedAfter,
      pageSize,
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
          queue.push({ id: String(item.id), path: String(item.drive_path), depth: Number(item.depth || 0) });
        }
      } else {
        files.push(item);
      }
    }
  }

  return {
    root_folder_id: folderId,
    drive_id: driveId || null,
    scanned_folder_count: scannedFolders.length,
    folder_count: folders.length,
    file_count: files.length,
    files,
  };
}

function normalizeCode(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenize(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !["meeting", "transcript", "notes", "google", "meet", "gemini"].includes(token));
}

function classifyDriveArtifact(file: Record<string, unknown>) {
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

function fileEventTime(file: Record<string, unknown>) {
  const value = file?.createdTime || file?.modifiedTime;
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function timeScore(file: Record<string, unknown>, session: Record<string, unknown>, matchWindowHours: number) {
  const fileTime = fileEventTime(file);
  const end = new Date(String(session?.ends_at || session?.end || session?.end_time || ""));
  const start = new Date(String(session?.starts_at || session?.start || session?.start_time || end));
  if (!fileTime || !Number.isFinite(end.getTime())) return 0;
  const earliest = Number.isFinite(start.getTime()) ? start.getTime() - 6 * 60 * 60 * 1000 : end.getTime() - 6 * 60 * 60 * 1000;
  const latest = end.getTime() + matchWindowHours * 60 * 60 * 1000;
  if (fileTime.getTime() < earliest || fileTime.getTime() > latest) return 0;
  return 20;
}

function titleScore(file: Record<string, unknown>, session: Record<string, unknown>) {
  const fileTokens = new Set(tokenize(file?.name));
  const titleTokens = tokenize(session?.public_title || session?.title);
  if (!fileTokens.size || !titleTokens.length) return 0;
  const hits = titleTokens.filter((token) => fileTokens.has(token)).length;
  const ratio = hits / Math.max(1, titleTokens.length);
  return ratio >= 0.5 ? 40 + Math.round(ratio * 20) : 0;
}

function meetingCodeScore(file: Record<string, unknown>, session: Record<string, unknown>) {
  const code = normalizeCode(session?.google_meeting_code);
  if (!code) return 0;
  const haystack = normalizeCode([file?.name, file?.description, file?.webViewLink].filter(Boolean).join(" "));
  return haystack.includes(code) ? 100 : 0;
}

function scoreFileForSession(file: Record<string, unknown>, session: Record<string, unknown>, matchWindowHours: number) {
  const code = meetingCodeScore(file, session);
  if (code) return code + timeScore(file, session, matchWindowHours);
  const time = timeScore(file, session, matchWindowHours);
  if (!time) return 0;
  return time + titleScore(file, session);
}

function matchFileToSession(file: Record<string, unknown>, sessions: Record<string, unknown>[], matchWindowHours: number) {
  const kind = classifyDriveArtifact(file);
  if (!kind) return null;
  let best: { session: Record<string, unknown>; score: number } | null = null;
  for (const session of sessions || []) {
    const score = scoreFileForSession(file, session, matchWindowHours);
    if (!best || score > best.score) best = { session, score };
  }
  if (!best || best.score < 50) return null;
  return { session: best.session, kind, score: best.score };
}

function driveExportUri(file: Record<string, unknown>) {
  if (file?.mimeType === "application/vnd.google-apps.document") {
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(file.id))}/export?mimeType=text/plain`;
  }
  return file?.webContentLink || null;
}

function fileToMeetArtifact(file: Record<string, unknown>, kind: string, score: number) {
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
  };
}

function captureKey(row: Record<string, unknown>) {
  return [
    row?.session_id || "",
    row?.provider || "",
    row?.artifact_kind || "",
    row?.provider_resource_name || "",
  ].join("\u0001");
}

function sourceSignature(row: Record<string, unknown>) {
  return [
    row?.source_kind || "",
    row?.storage_ref || "",
    row?.source_hash || "",
    row?.mime_type || "",
  ].join("\u0001");
}

function sourceArtifactConflict(rows: Record<string, unknown>[]) {
  return rows.length && rows.every((row) => row.capture_artifact_id && row.source_kind)
    ? "capture_artifact_id,source_kind"
    : undefined;
}

function buildDrivePlan({
  orgId,
  sessions,
  files,
  matchWindowHours,
}: {
  orgId: string;
  sessions: Record<string, unknown>[];
  files: Record<string, unknown>[];
  matchWindowHours: number;
}) {
  const grouped = new Map<string, { session: Record<string, unknown>; artifacts: Record<string, unknown>[] }>();
  const unmatchedFiles = [];
  for (const file of files || []) {
    const match = matchFileToSession(file, sessions, matchWindowHours);
    if (!match) {
      unmatchedFiles.push({
        id: file.id || null,
        name: file.name || null,
        mimeType: file.mimeType || null,
        reason: classifyDriveArtifact(file) ? "no matching session" : "unrecognized artifact kind",
      });
      continue;
    }
    const sessionId = String(match.session.id || "");
    if (!grouped.has(sessionId)) grouped.set(sessionId, { session: match.session, artifacts: [] });
    grouped.get(sessionId)!.artifacts.push(fileToMeetArtifact(file, match.kind, match.score));
  }

  const rows = {
    ingestionEvents: [] as Record<string, unknown>[],
    captureArtifacts: [] as Record<string, unknown>[],
    sourceArtifacts: [] as Record<string, unknown>[],
  };
  for (const { session, artifacts } of grouped.values()) {
    const manifest = {
      provider: "google_meet",
      meet_space: session.google_meet_space || null,
      conference_record: session.google_meet_space || session.google_meeting_code || session.google_event_id || null,
      source: "google_drive_poll",
      artifacts,
    };
    const sessionRows = meetArtifactRowsFromManifest({
      orgId: String(session.org_id || orgId),
      sessionId: String(session.id),
      manifest,
      fetchedRaw: false,
    });
    rows.ingestionEvents.push(...sessionRows.ingestionEvents);
    rows.captureArtifacts.push(...sessionRows.captureArtifacts);
    rows.sourceArtifacts.push(...sessionRows.sourceArtifacts);
  }

  return {
    matchedSessions: grouped.size,
    matchedFiles: rows.captureArtifacts.length,
    unmatchedFiles,
    ...rows,
  };
}

function linkedSourceArtifacts({
  orgId,
  rows,
  persistedCaptureArtifacts,
}: {
  orgId: string;
  rows: { captureArtifacts: Record<string, unknown>[]; sourceArtifacts: Record<string, unknown>[] };
  persistedCaptureArtifacts: Record<string, unknown>[];
}) {
  const wanted = new Set((rows.sourceArtifacts || []).map(sourceSignature));
  const persistedByKey = new Map((persistedCaptureArtifacts || []).map((row) => [captureKey(row), row]));
  return (rows.captureArtifacts || [])
    .map((captureArtifact) => {
      const persisted = persistedByKey.get(captureKey(captureArtifact));
      if (!persisted?.id) return null;
      const candidate = captureArtifactToSourceArtifact({
        orgId: String(captureArtifact.org_id || orgId),
        sessionId: String(captureArtifact.session_id || ""),
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

async function fetchCandidateSessions({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  lookbackHours,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  lookbackHours: number;
}) {
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    method: "GET",
    query: {
      select: "id,org_id,title,public_title,session_type,status,starts_at,ends_at,google_meeting_code,google_meet_space,google_event_id,transcript_status",
      org_id: `eq.${orgId}`,
      status: "neq.cancelled",
      transcript_status: "in.(expected,artifact_detected,failed)",
      ends_at: `gte.${since}`,
      order: "ends_at.desc",
      limit: "100",
    },
  });
}

async function patchSessionSourceReady({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  sourceArtifacts,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  sourceArtifacts: Record<string, unknown>[];
}) {
  const now = new Date().toISOString();
  const sessionIds = Array.from(new Set((sourceArtifacts || []).map((artifact) => artifact?.session_id).filter(Boolean)));
  const updated = [];
  for (const sessionId of sessionIds) {
    const rows = await supabaseRest({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      method: "PATCH",
      query: {
        id: `eq.${sessionId}`,
        org_id: `eq.${orgId}`,
      },
      body: {
        transcript_status: "source_ready",
        bot_status: "transcript_uploaded",
        first_source_artifact_at: now,
      },
      prefer: "return=representation",
    });
    updated.push(...(Array.isArray(rows) ? rows : []));
  }
  return updated;
}

async function applyDrivePlan({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  plan,
  policyVersion,
  dueAt,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  plan: ReturnType<typeof buildDrivePlan>;
  policyVersion?: string | null;
  dueAt?: string | null;
}) {
  const ingestionEvents = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "ingestion_events",
    rows: plan.ingestionEvents,
  });
  const captureArtifacts = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "capture_artifacts",
    rows: plan.captureArtifacts,
    onConflict: "session_id,provider,artifact_kind,provider_resource_name",
  });
  const sourceArtifactRows = linkedSourceArtifacts({ orgId, rows: plan, persistedCaptureArtifacts: captureArtifacts });
  const sourceArtifacts = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "source_artifacts",
    rows: sourceArtifactRows,
    onConflict: sourceArtifactConflict(sourceArtifactRows),
  });
  const processingJobRows = buildProcessingJobsFromSourceArtifacts({
    orgId,
    sourceArtifacts,
    policyVersion,
    dueAt,
    processorMode: "ordinary_cloud",
  });
  const processingJobs = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    rows: processingJobRows,
    onConflict: "source_artifact_id,job_kind,prompt_version",
  });
  const updatedSessions = await patchSessionSourceReady({ supabaseUrl, serviceRoleKey, orgId, sourceArtifacts });
  return { ingestionEvents, captureArtifacts, sourceArtifacts, processingJobs, updatedSessions };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);
  try {
    const body = await readJson(req);
    const orgId = body.org_id || body.orgId || requiredEnv("ORG_ID");
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const auth = await authorizeDrivePoller({ req, supabaseUrl, serviceRoleKey, orgId });
    const folderId = String(body.drive_folder_id || body.driveFolderId || body.folder_id || optionalEnv("GOOGLE_DRIVE_ARTIFACT_FOLDER_ID") || "").trim();
    if (!folderId) throw statusError("drive_folder_id is required", 400);
    const driveId = String(body.drive_id || body.driveId || optionalEnv("GOOGLE_DRIVE_ID") || "").trim() || undefined;
    const lookbackHours = Math.max(1, Math.min(720, Number(body.lookback_hours || body.lookbackHours || DEFAULT_LOOKBACK_HOURS) || DEFAULT_LOOKBACK_HOURS));
    const matchWindowHours = Math.max(1, Math.min(168, Number(body.match_window_hours || body.matchWindowHours || DEFAULT_MATCH_WINDOW_HOURS) || DEFAULT_MATCH_WINDOW_HOURS));
    const pageSize = Math.max(10, Math.min(1000, Number(body.page_size || body.pageSize || DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
    const recursive = body.recursive === true;
    const maxDepth = Math.max(0, Math.min(10, Number(body.max_depth || body.maxDepth || 6) || 6));
    const apply = body.dry_run === true ? false : body.apply !== false;
    const accessToken = await resolveGoogleAccessToken();
    const sessions = await fetchCandidateSessions({ supabaseUrl, serviceRoleKey, orgId, lookbackHours });
    const inventory = await fetchDriveInventory({
      folderId,
      driveId,
      accessToken,
      modifiedAfter: body.modified_after || body.modifiedAfter || null,
      pageSize,
      recursive,
      maxDepth,
    });
    const plan = buildDrivePlan({
      orgId,
      sessions,
      files: inventory.files,
      matchWindowHours,
    });
    const persisted = apply
      ? await applyDrivePlan({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        plan,
        policyVersion: body.policy_version || body.policyVersion || null,
        dueAt: body.due_at || body.dueAt || null,
      })
      : null;

    return jsonResponse({
      ok: true,
      apply,
      auth_mode: auth.mode,
      source: {
        provider: "google_drive",
        folder_id: folderId,
        drive_id: driveId || null,
        recursive,
        max_depth: recursive ? maxDepth : 0,
      },
      fetched: {
        sessions: sessions.length,
        files: inventory.file_count,
        folders: inventory.folder_count,
        scanned_folders: inventory.scanned_folder_count,
      },
      matched_sessions: plan.matchedSessions,
      matched_files: plan.matchedFiles,
      unmatched_files: plan.unmatchedFiles.slice(0, 25),
      persisted,
    });
  } catch (error) {
    return errorResponse(error);
  }
});

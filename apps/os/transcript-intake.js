const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POLICY_PATH = path.join(REPO_ROOT, "cohort-data", "policies", "transcript-routing-policy.json");
const DEFAULT_INTAKE_ROOT = path.join(REPO_ROOT, "cohort-data", ".private", "transcript-intake");
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
      leadership_meeting: { path: "do_not_publish/leadership_meeting" },
      unknown: { path: "needs_calendar_match" },
    },
  },
  session_type_groups: {
    primary_event_types: ["weekly_standup", "office_hours", "salon", "rd_jam", "demo_presentation"],
    restricted_or_special_types: ["private_1on1", "user_interview", "planning_strategy", "leadership_meeting"],
  },
  session_types: {
    weekly_standup: { label: "Weekly standup", description: "Individual status session.", max_tier: "T2", cohort_mode: "aggregate_only", public_allowed: false },
    office_hours: { label: "Office hours", description: "Project support or product office-hours session.", max_tier: "T2", cohort_mode: "distilled_readout", public_allowed: false },
    private_1on1: { label: "Private 1:1", description: "Private coaching, coordinator feedback, or sensitive one-on-one.", max_tier: "T1", cohort_mode: "never", public_allowed: false },
    salon: { label: "Salon", description: "Topic-led or speaker-led session.", max_tier: "T3", cohort_mode: "distilled_readout", public_allowed: true },
    rd_jam: { label: "R&D / jam", description: "Product or technical idea-stage session.", max_tier: "T2", cohort_mode: "team_call_required", public_allowed: false },
    demo_presentation: { label: "Demo / presentation", description: "Project or product demo.", max_tier: "T3", cohort_mode: "distilled_readout", public_allowed: true },
    user_interview: { label: "User interview", description: "External subject interview.", max_tier: "T2", cohort_mode: "aggregate_only", public_allowed: false },
    planning_strategy: { label: "Planning / strategy", description: "Coordinator governance or strategy session.", max_tier: "T1", cohort_mode: "never", public_allowed: false },
    leadership_meeting: { label: "Leadership meeting", description: "Restricted leadership or steering conversation.", max_tier: "T1", cohort_mode: "never", public_allowed: false },
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

const CONFIDENCE = {
  sure: { label: "Sure", type: 95, group: 90, understanding: 85 },
  best_guess: { label: "Best guess", type: 70, group: 65, understanding: 60 },
  needs_review: { label: "Needs review", type: 35, group: 35, understanding: 35 },
};

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function loadTranscriptPolicy({ policyPath = POLICY_PATH } = {}) {
  const policy = readJson(policyPath, null);
  if (policy && policy.session_types && policy.drive_vault) return policy;
  return DEFAULT_POLICY;
}

function normalizeVaultPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function orderedSessionTypeKeys(policy) {
  const groups = policy.session_type_groups || {};
  const ordered = [
    ...(Array.isArray(groups.primary_event_types) ? groups.primary_event_types : []),
    ...(Array.isArray(groups.restricted_or_special_types) ? groups.restricted_or_special_types : []),
  ];
  const all = Object.keys(policy.session_types || {});
  return [...new Set([...ordered, ...all])].filter((key) => policy.session_types?.[key]);
}

function routeForTranscriptType(policy, sessionType) {
  const key = String(sessionType || "").trim();
  const routes = policy?.drive_vault?.folder_routes || DEFAULT_POLICY.drive_vault.folder_routes;
  if (!key || !policy?.session_types?.[key]) {
    const error = new Error("Choose a transcript type before submitting.");
    error.code = "invalid_session_type";
    throw error;
  }
  const route = routes[key] || routes.unknown;
  return {
    ...route,
    path: normalizeVaultPath(route?.path || "needs_calendar_match"),
    derived_path: normalizeVaultPath(route?.derived_path || route?.path || "needs_calendar_match"),
  };
}

function sessionTypeEntries(policy = loadTranscriptPolicy()) {
  return orderedSessionTypeKeys(policy)
    .map((key) => {
      const value = policy.session_types[key] || {};
      const route = routeForTranscriptType(policy, key);
      return {
        key,
        label: value.label || key.replace(/_/g, " "),
        description: value.description || "",
        maxTier: value.max_tier || "",
        cohortMode: value.cohort_mode || "",
        publicAllowed: !!value.public_allowed,
        routePath: route.path,
        derivedRoutePath: route.derived_path || route.path,
        accessNote: route.access_note || value.notes || "",
      };
    });
}

function getTranscriptIntakeOptions() {
  const policy = loadTranscriptPolicy();
  return {
    ok: true,
    policyKey: policy.policy_key || "transcript-routing",
    policyVersion: policy.version || "",
    sessionTypes: sessionTypeEntries(policy),
    confidenceOptions: Object.entries(CONFIDENCE).map(([key, value]) => ({ key, label: value.label })),
  };
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

function mimeTypeForFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return EXT_MIME.get(ext) || "application/octet-stream";
}

function validateTranscriptFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  // Reject symlinks before following them. The path can now come from the
  // renderer (drag-drop / file-first submit), not just the native picker, so a
  // planted symlink with an allowlisted extension (e.g. notes.txt -> ~/.ssh/id_rsa)
  // could otherwise smuggle an arbitrary file past the extension check below.
  // lstat does NOT follow the link; a real user pick is never a symlink.
  const lstat = fs.lstatSync(resolved);
  if (lstat.isSymbolicLink()) {
    const error = new Error("Selected path is a symbolic link.");
    error.code = "symlink_rejected";
    throw error;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    const error = new Error("Selected path is not a file.");
    error.code = "not_file";
    throw error;
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    const error = new Error(`Transcript intake is limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
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

// Validate a chosen file and return display info WITHOUT staging/uploading it.
// Lets the renderer show the picked file (name/size/type) before submit, and
// validates drag-and-drop paths the same way the native picker does.
function inspectTranscriptFile(filePath) {
  try {
    const { resolved, stat, ext } = validateTranscriptFile(filePath);
    return {
      ok: true,
      filePath: resolved,
      name: path.basename(resolved),
      sizeBytes: stat.size,
      ext,
      mimeType: mimeTypeForFile(resolved),
    };
  } catch (error) {
    return { ok: false, reason: error?.code || "invalid_file", detail: error?.message || String(error) };
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function suggestStagedFileName({ sessionType, originalName, label, sourceHash }) {
  const ext = path.extname(String(originalName || "")).toLowerCase() || ".txt";
  const base = path.basename(String(originalName || "transcript"), path.extname(String(originalName || "")));
  const type = safeSlug(sessionType, "unknown").replace(/-/g, "_");
  const stem = safeSlug(label || base, "transcript");
  return `${type}_${stem}_${String(sourceHash || "").slice(0, 12)}${ext}`;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== ""),
  );
}

function confidenceShape(value) {
  return CONFIDENCE[String(value || "").trim()] || CONFIDENCE.sure;
}

function stageTranscriptFile({
  filePath,
  sessionType,
  label = "",
  now = new Date(),
  intakeRoot = DEFAULT_INTAKE_ROOT,
  storageRefRoot = REPO_ROOT,
} = {}) {
  const { resolved, stat } = validateTranscriptFile(filePath);
  const sourceHash = sha256File(resolved);
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const dir = path.join(intakeRoot, date);
  fs.mkdirSync(dir, { recursive: true });
  const stagedName = suggestStagedFileName({
    sessionType,
    originalName: path.basename(resolved),
    label,
    sourceHash,
  });
  const stagedPath = path.join(dir, stagedName);
  fs.copyFileSync(resolved, stagedPath);
  const storageRef = normalizeVaultPath(path.relative(storageRefRoot, stagedPath));
  return {
    originalName: path.basename(resolved),
    stagedName,
    stagedPath,
    storageRef,
    sourceHash,
    mimeType: mimeTypeForFile(resolved),
    sizeBytes: stat.size,
  };
}

function buildTranscriptIntakeBody({
  policy = loadTranscriptPolicy(),
  orgId,
  sessionId = "",
  sessionType,
  confidence = "sure",
  declaredDate = "",
  label = "",
  relatedText = "",
  staged,
  now = new Date(),
} = {}) {
  const type = policy.session_types?.[sessionType] || {};
  const route = routeForTranscriptType(policy, sessionType);
  const score = confidenceShape(confidence);
  const submittedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const metadata = compactObject({
    source_surface: "shape_os_chat_wheel",
    declaration_source: "member_self_declaration",
    declared_session_type: sessionType,
    declared_session_type_label: type.label || sessionType,
    declared_session_type_confidence: confidence,
    declared_session_date: declaredDate || null,
    declared_label: label || null,
    related_hint: relatedText || null,
    original_file_name: staged.originalName,
    staged_file_name: staged.stagedName,
    target_drive_route: route.path,
    target_drive_derived_route: route.derived_path || route.path,
    drive_mirror_status: "pending",
    processing_hint: sessionId ? "queue_local_processing" : "needs_calendar_match",
    policy_key: policy.policy_key || "transcript-routing",
    policy_version: policy.version || "",
    max_tier: type.max_tier || "",
    cohort_mode: type.cohort_mode || "",
    public_allowed: !!type.public_allowed,
    route_access_note: route.access_note || type.notes || "",
    type_confidence_pct: score.type,
    group_confidence_pct: score.group,
    understanding_confidence_pct: score.understanding,
    confidence_basis: {
      type: ["member self-declared"],
      group: ["chat wheel transcript intake"],
      understanding: [confidence === "needs_review" ? "member requested review" : "member supplied type"],
    },
    submitted_at: submittedAt,
  });
  const artifact = compactObject({
    session_id: sessionId || undefined,
    source_kind: "manual_upload",
    source_tier: "T0",
    storage_mode: "local_only",
    storage_ref: staged.storageRef,
    raw_available_to_server: false,
    source_hash: staged.sourceHash,
    mime_type: staged.mimeType,
    size_bytes: staged.sizeBytes,
    metadata,
  });
  return compactObject({
    org_id: orgId,
    session_id: sessionId || undefined,
    provider: "manual",
    processor_mode: "local",
    policy_version: policy.version || undefined,
    manifest: {
      provider: "manual",
      source_tier: "T0",
      storage_mode: "local_only",
      raw_available_to_server: false,
      artifacts: [artifact],
    },
  });
}

function normalizeSupabaseConfig(config = {}) {
  return {
    supabaseUrl: String(config.supabaseUrl || config.url || "").replace(/\/+$/, ""),
    supabaseAnonKey: String(config.supabaseAnonKey || config.anonKey || "").trim(),
    accessToken: String(config.accessToken || config.access_token || "").trim(),
    orgId: String(config.orgId || config.org_id || "").trim(),
    ingestArtifactsUrl: String(config.ingestArtifactsUrl || "").trim(),
  };
}

function missingSupabaseFields(config) {
  const missing = [];
  if (!config.supabaseUrl && !config.ingestArtifactsUrl) missing.push("Supabase URL");
  if (!config.supabaseAnonKey) missing.push("anon key");
  if (!config.accessToken) missing.push("access token");
  if (!config.orgId) missing.push("org ID");
  return missing;
}

async function callIngestArtifacts({ config, body, fetchImpl = fetch }) {
  const url = config.ingestArtifactsUrl || `${config.supabaseUrl}/functions/v1/ingest-artifacts`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      authorization: `Bearer ${config.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`ingest-artifacts failed: ${response.status}`);
    error.code = "supabase_ingest_failed";
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data || {};
}

async function submitTranscriptIntake({
  filePath,
  sessionType,
  label = "",
  declaredDate = "",
  relatedText = "",
  confidence = "sure",
  sessionId = "",
  supabase = {},
  now = new Date(),
  intakeRoot = DEFAULT_INTAKE_ROOT,
  storageRefRoot = REPO_ROOT,
  fetchImpl = fetch,
} = {}) {
  const policy = loadTranscriptPolicy();
  const route = routeForTranscriptType(policy, sessionType);
  const staged = stageTranscriptFile({ filePath, sessionType, label, now, intakeRoot, storageRefRoot });
  const sidecar = {
    staged_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    session_type: sessionType,
    session_id: sessionId || null,
    label: label || null,
    declared_date: declaredDate || null,
    related_hint: relatedText || null,
    confidence,
    route_path: route.path,
    storage_ref: staged.storageRef,
    source_hash: staged.sourceHash,
    mime_type: staged.mimeType,
    size_bytes: staged.sizeBytes,
    original_file_name: staged.originalName,
  };
  fs.writeFileSync(`${staged.stagedPath}.manifest.json`, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  const config = normalizeSupabaseConfig(supabase);
  const missing = missingSupabaseFields(config);
  if (missing.length) {
    return {
      ok: false,
      reason: "missing_supabase_config",
      detail: `Missing ${missing.join(", ")}.`,
      missing,
      staged: true,
      storageRef: staged.storageRef,
      routePath: route.path,
      driveMirrorStatus: "pending",
    };
  }

  const body = buildTranscriptIntakeBody({
    policy,
    orgId: config.orgId,
    sessionId,
    sessionType,
    confidence,
    declaredDate,
    label,
    relatedText,
    staged,
    now,
  });

  try {
    const ingest = await callIngestArtifacts({ config, body, fetchImpl });
    const persisted = ingest.persisted || {};
    const processingJobs = Array.isArray(persisted.processingJobs) ? persisted.processingJobs : [];
    const sourceArtifacts = Array.isArray(persisted.sourceArtifacts) ? persisted.sourceArtifacts : [];
    return {
      ok: true,
      submittedToSupabase: true,
      sessionType,
      sessionId: sessionId || null,
      needsSessionMatch: !sessionId,
      processingQueued: processingJobs.length > 0,
      processingJobCount: processingJobs.length,
      sourceArtifactCount: sourceArtifacts.length || (Array.isArray(ingest.sourceArtifacts) ? ingest.sourceArtifacts.length : 0),
      routePath: route.path,
      derivedRoutePath: route.derived_path || route.path,
      storageRef: staged.storageRef,
      sourceHash: staged.sourceHash,
      sizeBytes: staged.sizeBytes,
      driveMirrorStatus: "pending",
      ingest,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code || "supabase_ingest_failed",
      detail: error?.message || String(error),
      status: error?.status,
      body: error?.body,
      staged: true,
      storageRef: staged.storageRef,
      routePath: route.path,
      driveMirrorStatus: "pending",
    };
  }
}

// Open the native file picker and return the validated file's display info
// (no staging/upload yet). The renderer calls this first so the user can see
// what they picked before filling in metadata and submitting.
async function pickTranscriptFile({ browserWindow, dialogImpl } = {}) {
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
  return inspectTranscriptFile(selection.filePaths[0]);
}

async function pickAndSubmitTranscriptIntake({ browserWindow, dialogImpl, ...opts } = {}) {
  const policy = loadTranscriptPolicy();
  routeForTranscriptType(policy, opts.sessionType);
  const picked = await pickTranscriptFile({ browserWindow, dialogImpl });
  if (!picked.ok) return picked;
  return submitTranscriptIntake({ ...opts, filePath: picked.filePath });
}

module.exports = {
  DEFAULT_INTAKE_ROOT,
  DEFAULT_POLICY,
  MAX_UPLOAD_BYTES,
  buildTranscriptIntakeBody,
  getTranscriptIntakeOptions,
  inspectTranscriptFile,
  loadTranscriptPolicy,
  normalizeSupabaseConfig,
  routeForTranscriptType,
  sessionTypeEntries,
  stageTranscriptFile,
  submitTranscriptIntake,
  pickTranscriptFile,
  pickAndSubmitTranscriptIntake,
};

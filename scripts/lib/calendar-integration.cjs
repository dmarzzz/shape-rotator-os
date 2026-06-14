const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TEXT_DISTILL_SOURCE_KINDS = new Set([
  "manual_upload",
  "meet_transcript",
  "meet_smart_notes",
  "otter_transcript",
  "otter_summary",
  "drive_doc",
  "router",
]);
const REVIEW_PREP_SOURCE_KINDS = new Set([
  "otter_slide",
  "audio",
  "video",
]);
const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function defaultPolicyPath(repoRoot = path.resolve(__dirname, "..", "..")) {
  return path.join(repoRoot, "cohort-data", "policies", "transcript-routing-policy.json");
}

function loadRoutingPolicy(filePath = defaultPolicyPath()) {
  return readJson(filePath);
}

function validateRoutingPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object") errors.push("policy must be an object");
  if (policy?.schema_version !== 1) errors.push("schema_version must be 1");
  if (!policy?.policy_key) errors.push("policy_key is required");
  if (!policy?.version) errors.push("version is required");
  const tiers = policy?.tiers || {};
  for (const tier of ["T0", "T1", "T2", "T3"]) {
    if (!tiers[tier]) errors.push(`missing tier ${tier}`);
  }
  const sessionTypes = policy?.session_types || {};
  if (!Object.keys(sessionTypes).length) errors.push("session_types must not be empty");
  for (const [key, value] of Object.entries(sessionTypes)) {
    if (!/^[a-z0-9_]+$/.test(key)) errors.push(`invalid session type key: ${key}`);
    if (!value.label) errors.push(`${key}: label is required`);
    if (!["T1", "T2", "T3"].includes(value.max_tier)) errors.push(`${key}: max_tier must be T1, T2, or T3`);
    if (typeof value.public_allowed !== "boolean") errors.push(`${key}: public_allowed boolean is required`);
    if (!Array.isArray(value.required_public_approvals)) errors.push(`${key}: required_public_approvals must be an array`);
  }
  return errors;
}

function requireNoPolicyErrors(policy) {
  const errors = validateRoutingPolicy(policy);
  if (errors.length) throw new Error(`invalid routing policy:\n- ${errors.join("\n- ")}`);
}

function policyDecisionForSession(policy, sessionType) {
  requireNoPolicyErrors(policy);
  const key = String(sessionType || "").trim();
  const sessionPolicy = policy.session_types[key];
  if (!sessionPolicy) {
    throw new Error(`unknown session_type "${key}". Add it to transcript-routing-policy.json before creating the event.`);
  }
  return {
    policy_key: policy.policy_key,
    policy_version: policy.version,
    session_type: key,
    label: sessionPolicy.label,
    max_tier: sessionPolicy.max_tier,
    cohort_mode: sessionPolicy.cohort_mode || "distilled_readout",
    public_allowed: !!sessionPolicy.public_allowed,
    default_auto_transcript: !!sessionPolicy.default_auto_transcript,
    required_public_approvals: [...sessionPolicy.required_public_approvals],
    notes: sessionPolicy.notes || "",
    calendar_event_defaults: {
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
      ...(policy.calendar_event_defaults || {}),
    },
  };
}

function addHoursIso(value, hours) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function sessionAutomationFields({ session, decision } = {}) {
  const transcriptExpected = !!decision?.default_auto_transcript;
  return {
    transcript_status: transcriptExpected ? "expected" : "not_expected",
    distill_due_at: transcriptExpected ? addHoursIso(session?.ends_at || session?.end || session?.end_time, 48) : null,
  };
}

function stableGoogleEventId(sessionId) {
  const base = String(sessionId || "")
    .toLowerCase()
    .replace(/[^a-v0-9]/g, "");
  if (base.length >= 5) return `sros${base}`.slice(0, 1024);
  return null;
}

function uuidFromStableKey(key) {
  const hash = crypto.createHash("sha1").update(String(key || "")).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function stableSessionIdForGoogleEvent(event, { orgId, calendarConnectionId } = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  if (privateProps.shape_session_id) return privateProps.shape_session_id;
  if (!event?.id || !orgId || !calendarConnectionId) return undefined;
  return uuidFromStableKey(`google-calendar-session:${orgId}:${calendarConnectionId}:${event.id}`);
}

function requireSessionTime(session) {
  const startsAt = session?.starts_at || session?.start || session?.start_time;
  const endsAt = session?.ends_at || session?.end || session?.end_time;
  if (!startsAt || !endsAt) throw new Error("session starts_at and ends_at are required");
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("session starts_at and ends_at must be valid datetimes");
  }
  if (end <= start) throw new Error("session ends_at must be after starts_at");
  return { startsAt, endsAt, start, end };
}

function normalizeAttendees(attendees = []) {
  const seen = new Set();
  const out = [];
  for (const item of attendees || []) {
    const email = String(item?.email || item || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const attendee = { email };
    if (item?.displayName || item?.name) attendee.displayName = item.displayName || item.name;
    if (item?.optional != null) attendee.optional = !!item.optional;
    out.push(attendee);
  }
  return out;
}

function safeDescription(session, decision) {
  const lines = [
    "Managed by Shape Rotator OS.",
    `Session type: ${decision.label}`,
    `Routing ceiling: ${decision.max_tier}`,
  ];
  if (decision.cohort_mode) lines.push(`Cohort mode: ${decision.cohort_mode}`);
  if (session.public_description) lines.push("", String(session.public_description));
  return lines.join("\n");
}

function buildGoogleCalendarEvent({ session, attendees = [], policy, botEmail, requestMeet } = {}) {
  if (!session || typeof session !== "object") throw new Error("session object is required");
  const decision = policyDecisionForSession(policy, session.session_type);
  const { startsAt, endsAt } = requireSessionTime(session);
  const timezone = session.timezone || "America/New_York";
  const attendeeInputs = [...(attendees || [])];
  if (session.bot_requested !== false && botEmail) attendeeInputs.push({ email: botEmail, attendee_role: "bot" });
  const normalizedAttendees = normalizeAttendees(attendeeInputs);

  const eventId = stableGoogleEventId(session.id || session.session_id);
  const defaults = decision.calendar_event_defaults;
  const body = {
    summary: session.public_title || session.title,
    description: safeDescription(session, decision),
    start: { dateTime: startsAt, timeZone: timezone },
    end: { dateTime: endsAt, timeZone: timezone },
    attendees: normalizedAttendees,
    guestsCanModify: defaults.guestsCanModify === true ? true : false,
    guestsCanInviteOthers: defaults.guestsCanInviteOthers === true ? true : false,
    guestsCanSeeOtherGuests: defaults.guestsCanSeeOtherGuests !== false,
    extendedProperties: {
      private: {
        shape_session_id: String(session.id || session.session_id || ""),
        shape_policy_key: decision.policy_key,
        shape_policy_version: decision.policy_version,
        shape_session_type: decision.session_type,
        shape_max_tier: decision.max_tier,
        shape_cohort_mode: decision.cohort_mode,
      },
    },
  };
  if (eventId) body.id = eventId;
  if (session.location) body.location = session.location;
  if (requestMeet !== false) {
    body.conferenceData = {
      createRequest: {
        requestId: `shape-${String(session.id || Date.now()).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  return {
    query: {
      sendUpdates: "all",
      conferenceDataVersion: requestMeet === false ? 0 : 1,
    },
    body,
    decision,
  };
}

function extractMeetingCode(value) {
  const text = String(value || "");
  const meet = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(text);
  if (meet) return meet[1].toLowerCase();
  const bare = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i.exec(text);
  return bare ? bare[1].toLowerCase() : null;
}

function googleEventToSessionRow(event, { orgId, calendarConnectionId, policy } = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const sessionType = privateProps.shape_session_type || "office_hours";
  const decision = policy ? policyDecisionForSession(policy, sessionType) : null;
  const meetUrl = event?.hangoutLink
    || event?.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri
    || null;
  return {
    id: stableSessionIdForGoogleEvent(event, { orgId, calendarConnectionId }),
    org_id: orgId,
    calendar_connection_id: calendarConnectionId,
    title: event?.summary || "Untitled session",
    public_title: event?.summary || null,
    session_type: sessionType,
    max_tier: privateProps.shape_max_tier || decision?.max_tier || "T2",
    status: event?.status === "cancelled" ? "cancelled" : "scheduled",
    starts_at: event?.start?.dateTime || event?.start?.date || null,
    ends_at: event?.end?.dateTime || event?.end?.date || null,
    timezone: event?.start?.timeZone || event?.end?.timeZone || "America/New_York",
    location: event?.location || null,
    google_calendar_id: event?.organizer?.email || null,
    google_event_id: event?.id || null,
    google_ical_uid: event?.iCalUID || event?.icalUID || null,
    google_etag: event?.etag || null,
    google_html_link: event?.htmlLink || null,
    google_meet_url: meetUrl,
    google_meeting_code: extractMeetingCode(meetUrl || event?.conferenceData?.conferenceId),
    guests_can_modify: !!event?.guestsCanModify,
    guests_can_invite_others: !!event?.guestsCanInviteOthers,
    guests_can_see_other_guests: event?.guestsCanSeeOtherGuests !== false,
    ...sessionAutomationFields({
      session: {
        ends_at: event?.end?.dateTime || event?.end?.date || null,
      },
      decision,
    }),
  };
}

function normalizeInviteStatus(status) {
  const value = String(status || "").trim();
  if (value === "needsAction") return "needs_action";
  if (["accepted", "declined", "tentative"].includes(value)) return value;
  return "pending";
}

function googleEventAttendeeRows(event, { orgId, sessionId, botEmail } = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const resolvedSessionId = sessionId || privateProps.shape_session_id || undefined;
  const bot = String(botEmail || "").trim().toLowerCase();
  return (event?.attendees || [])
    .map((attendee) => {
      const email = String(attendee?.email || "").trim().toLowerCase();
      if (!email) return null;
      return {
        org_id: orgId,
        session_id: resolvedSessionId,
        email,
        attendee_role: bot && email === bot ? "bot" : "guest",
        invite_status: normalizeInviteStatus(attendee.responseStatus),
        google_response_status: attendee.responseStatus || null,
      };
    })
    .filter(Boolean);
}

function googleEventsToSupabaseRows(events, { orgId, calendarConnectionId, policy, botEmail } = {}) {
  if (!Array.isArray(events)) throw new Error("events array is required");
  const sessions = [];
  const attendees = [];
  for (const event of events) {
    const session = googleEventToSessionRow(event, { orgId, calendarConnectionId, policy });
    sessions.push(session);
    attendees.push(...googleEventAttendeeRows(event, {
      orgId,
      sessionId: session.id,
      botEmail,
    }));
  }
  return { sessions, attendees };
}

function captureArtifactToSourceArtifact({ orgId, sessionId, captureArtifact, sourceKind, fetchedRaw = false } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const provider = captureArtifact?.provider || "google_meet";
  const artifactKind = captureArtifact?.artifact_kind || "transcript";
  const kind = sourceKind || defaultSourceKind(provider, artifactKind);
  if (![
    "meet_transcript",
    "meet_smart_notes",
    "otter_transcript",
    "otter_summary",
    "otter_slide",
    "audio",
    "video",
  ].includes(kind)) {
    throw new Error(`unsupported sourceKind: ${kind}`);
  }
  const metadata = captureArtifact?.metadata || {};
  return {
    org_id: orgId,
    session_id: sessionId,
    capture_artifact_id: captureArtifact?.id,
    source_kind: kind,
    source_tier: "T0",
    storage_mode: fetchedRaw ? "encrypted_object" : "external_ref",
    storage_ref: captureArtifact?.storage_ref
      || captureArtifact?.drive_file_id
      || captureArtifact?.provider_resource_name
      || captureArtifact?.conference_record
      || captureArtifact?.conversation_id
      || null,
    source_hash: captureArtifact?.source_hash || metadata.source_hash || metadata.hash || null,
    mime_type: captureArtifact?.mime_type || metadata.mime_type || metadata.mimeType || null,
    size_bytes: captureArtifact?.size_bytes || metadata.size_bytes || metadata.sizeBytes || null,
    raw_available_to_server: !!fetchedRaw,
  };
}

function defaultSourceKind(provider, artifactKind) {
  if (provider === "otter") {
    if (artifactKind === "slides" || artifactKind === "slide") return "otter_slide";
    if (artifactKind === "summary") return "otter_summary";
    if (artifactKind === "recording" || artifactKind === "audio") return "audio";
    if (artifactKind === "video") return "video";
    return "otter_transcript";
  }
  if (artifactKind === "smart_notes") return "meet_smart_notes";
  return "meet_transcript";
}

function meetArtifactToSourceArtifact({ orgId, sessionId, meetArtifact, sourceKind, fetchedRaw = false } = {}) {
  return captureArtifactToSourceArtifact({
    orgId,
    sessionId,
    captureArtifact: { provider: "google_meet", ...(meetArtifact || {}) },
    sourceKind,
    fetchedRaw,
  });
}

function normalizeMeetArtifactKind(kind) {
  const value = String(kind || "transcript").trim().toLowerCase();
  if (value === "smartnotes" || value === "smart_notes" || value === "gemini_notes") return "smart_notes";
  if (value === "recording" || value === "recordings") return "recording";
  if (value === "attendance" || value === "attendance_report") return "attendance";
  return "transcript";
}

function normalizeOtterArtifactKind(kind) {
  const value = String(kind || "transcript").trim().toLowerCase();
  if (["slide", "slides", "screenshot", "screenshots", "screen_capture", "screen_captures", "presentation", "image", "images"].includes(value)) return "slides";
  if (value === "summary" || value === "notes") return "summary";
  if (value === "recording" || value === "recordings" || value === "audio" || value === "video") return "recording";
  return "transcript";
}

function artifactStorageRef(item) {
  return item.storage_ref || item.storageRef || item.file || item.url || item.path || null;
}

function artifactMimeType(item) {
  return item.mime_type || item.mimeType || item.content_type || item.contentType || null;
}

function artifactSizeBytes(item) {
  const value = item.size_bytes ?? item.sizeBytes ?? item.bytes ?? null;
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function artifactHash(item) {
  return item.source_hash || item.sourceHash || item.hash || item.sha256 || item.digest || null;
}

function stableProviderResourceName({ provider, scope, artifactKind, item, index }) {
  const explicit = item.provider_resource_name || item.providerResourceName || item.resource_name || item.resourceName || item.name || item.id;
  if (explicit) return explicit;
  const stablePart = artifactHash(item) || artifactStorageRef(item) || `index-${index}`;
  const normalizedScope = String(scope || "unscoped").replace(/\s+/g, "-");
  const normalizedPart = String(stablePart).replace(/\s+/g, "-");
  return `${provider}:${normalizedScope}:${artifactKind}:${normalizedPart}`.slice(0, 240);
}

function pushManifestValue(rows, value, kind) {
  if (Array.isArray(value)) {
    value.forEach((item) => pushManifestValue(rows, item, kind));
    return;
  }
  if (!value) return;
  if (typeof value === "string") {
    rows.push({ artifact_kind: kind, file: value });
    return;
  }
  if (typeof value === "object") rows.push({ artifact_kind: kind, ...value });
}

function collectOtterManifestArtifacts(manifest) {
  const rows = Array.isArray(manifest.artifacts) ? [...manifest.artifacts] : [];
  const grouped = [
    ["transcript", "transcript"],
    ["transcripts", "transcript"],
    ["summary", "summary"],
    ["summaries", "summary"],
    ["notes", "summary"],
    ["slides", "slides"],
    ["slide_captures", "slides"],
    ["slideCaptures", "slides"],
    ["screenshots", "slides"],
    ["screen_captures", "slides"],
    ["screenCaptures", "slides"],
    ["images", "slides"],
    ["recording", "recording"],
    ["recordings", "recording"],
    ["audio", "recording"],
    ["video", "recording"],
  ];
  for (const [key, kind] of grouped) {
    pushManifestValue(rows, manifest[key], kind);
  }
  return rows;
}

function collectMeetManifestArtifacts(manifest) {
  const rows = Array.isArray(manifest.artifacts) ? [...manifest.artifacts] : [];
  const grouped = [
    ["transcripts", "transcript"],
    ["smart_notes", "smart_notes"],
    ["smartNotes", "smart_notes"],
    ["recordings", "recording"],
    ["attendance", "attendance"],
    ["attendance_reports", "attendance"],
  ];
  for (const [key, kind] of grouped) {
    if (Array.isArray(manifest[key])) {
      for (const item of manifest[key]) rows.push({ artifact_kind: kind, ...item });
    }
  }
  return rows;
}

function meetArtifactRowsFromManifest({ orgId, sessionId, manifest, fetchedRaw = false } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!manifest || typeof manifest !== "object") throw new Error("manifest object is required");
  const conferenceRecord = manifest.conference_record || manifest.conferenceRecord || manifest.name || null;
  const meetSpace = manifest.meet_space || manifest.meetSpace || null;
  const rawArtifacts = collectMeetManifestArtifacts(manifest);
  const captureArtifacts = rawArtifacts.map((item, index) => ({
    org_id: orgId,
    session_id: sessionId,
    provider: "google_meet",
    conference_record: item.conference_record || item.conferenceRecord || conferenceRecord,
    meet_space: item.meet_space || item.meetSpace || meetSpace,
    artifact_kind: normalizeMeetArtifactKind(item.artifact_kind || item.kind),
    provider_resource_name: item.provider_resource_name || item.resource_name || item.name || null,
    storage_ref: item.storage_ref || item.file || item.url || null,
    drive_file_id: item.drive_file_id || item.driveFileId || null,
    drive_export_uri: item.drive_export_uri || item.driveExportUri || item.export_uri || null,
    status: item.status || "detected",
    raw_retention_deadline: item.raw_retention_deadline || item.rawRetentionDeadline || manifest.raw_retention_deadline || null,
    metadata: {
      index,
      title: item.title || null,
      generated_at: item.generated_at || item.generatedAt || item.createTime || null,
      mime_type: item.mime_type || item.mimeType || null,
    },
  }));
  const detectedAt = new Date().toISOString();
  const ingestionEvents = captureArtifacts.map((artifact) => ({
    org_id: orgId,
    session_id: sessionId,
    provider: "google_meet",
    event_type: `${artifact.artifact_kind}.detected`,
    resource_name: artifact.provider_resource_name || artifact.conference_record || artifact.meet_space,
    event_json: {
      provider: "google_meet",
      artifact_kind: artifact.artifact_kind,
      conference_record: artifact.conference_record,
      meet_space: artifact.meet_space,
      provider_resource_name: artifact.provider_resource_name,
    },
    processing_status: "processed",
    received_at: detectedAt,
    processed_at: detectedAt,
  }));
  const sourceArtifacts = captureArtifacts
    .filter((artifact) => artifact.artifact_kind === "transcript" || artifact.artifact_kind === "smart_notes")
    .map((artifact) => captureArtifactToSourceArtifact({
      orgId,
      sessionId,
      captureArtifact: artifact,
      fetchedRaw,
    }));
  const processingJobs = buildProcessingJobsFromSourceArtifacts({ orgId, sourceArtifacts });
  return { ingestionEvents, captureArtifacts, sourceArtifacts, processingJobs };
}

function otterArtifactRowsFromManifest({ orgId, sessionId, manifest, fetchedRaw = false } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!manifest || typeof manifest !== "object") throw new Error("manifest object is required");
  const conversationId = manifest.conversation_id || manifest.conversationId || manifest.id || null;
  const rawArtifacts = collectOtterManifestArtifacts(manifest);
  const captureArtifacts = rawArtifacts.map((item, index) => ({
    org_id: orgId,
    session_id: sessionId,
    provider: "otter",
    artifact_kind: normalizeOtterArtifactKind(item.artifact_kind || item.kind),
    conversation_id: item.conversation_id || conversationId,
    storage_ref: artifactStorageRef(item),
    status: item.status || "detected",
    metadata: {
      index,
      title: item.title || null,
      captured_at: item.captured_at || item.capturedAt || item.timestamp || item.start_time || item.startTime || null,
      slide_number: item.slide_number || item.slideNumber || null,
      mime_type: artifactMimeType(item),
      size_bytes: artifactSizeBytes(item),
      source_hash: artifactHash(item),
      page_label: item.page_label || item.pageLabel || null,
      export_source: item.export_source || item.exportSource || manifest.export_source || manifest.exportSource || null,
    },
  }));
  captureArtifacts.forEach((artifact, index) => {
    artifact.provider_resource_name = stableProviderResourceName({
      provider: "otter",
      scope: artifact.conversation_id || sessionId,
      artifactKind: artifact.artifact_kind,
      item: rawArtifacts[index],
      index,
    });
  });
  const detectedAt = new Date().toISOString();
  const ingestionEvents = captureArtifacts.map((artifact) => ({
    org_id: orgId,
    session_id: sessionId,
    provider: "otter",
    event_type: `${artifact.artifact_kind}.detected`,
    resource_name: artifact.provider_resource_name || artifact.storage_ref || artifact.conversation_id,
    event_json: {
      provider: "otter",
      artifact_kind: artifact.artifact_kind,
      conversation_id: artifact.conversation_id,
      storage_ref: artifact.storage_ref,
      provider_resource_name: artifact.provider_resource_name,
    },
    processing_status: "processed",
    received_at: detectedAt,
    processed_at: detectedAt,
  }));
  const sourceArtifacts = captureArtifacts
    .filter((artifact) => ["transcript", "summary", "slides", "recording"].includes(artifact.artifact_kind))
    .map((artifact) => captureArtifactToSourceArtifact({
      orgId,
      sessionId,
      captureArtifact: artifact,
      fetchedRaw,
    }));
  const processingJobs = buildProcessingJobsFromSourceArtifacts({ orgId, sourceArtifacts });
  return { ingestionEvents, captureArtifacts, sourceArtifacts, processingJobs };
}

function normalizeManualSourceKind(kind) {
  const value = String(kind || "manual_upload").trim().toLowerCase();
  if (["drive", "google_drive", "doc", "document"].includes(value)) return "drive_doc";
  if (["repo", "github_repo", "github"].includes(value)) return "github";
  if (["router", "team_router"].includes(value)) return "router";
  if ([
    "audio",
    "video",
    "manual_upload",
    "meet_transcript",
    "meet_smart_notes",
    "otter_transcript",
    "otter_summary",
    "otter_slide",
    "drive_doc",
    "github",
    "router",
  ].includes(value)) return value;
  return "manual_upload";
}

function manualSourceArtifactRowsFromManifest({ orgId, sessionId, manifest } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest object is required");
  const rawArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const sourceArtifacts = rawArtifacts.map((item) => {
    const storageMode = item.storage_mode || manifest.storage_mode || "local_only";
    if (!["local_only", "encrypted_object", "tee_direct", "external_ref"].includes(storageMode)) {
      throw new Error(`unsupported storage_mode: ${storageMode}`);
    }
    return {
      org_id: orgId,
      session_id: item.session_id || sessionId || null,
      source_kind: normalizeManualSourceKind(item.source_kind || item.kind),
      source_tier: item.source_tier || manifest.source_tier || "T0",
      storage_mode: storageMode,
      storage_ref: item.storage_ref || item.file || item.url || item.path || null,
      source_hash: item.source_hash || item.hash || null,
      mime_type: item.mime_type || item.mimeType || null,
      size_bytes: item.size_bytes || item.sizeBytes || null,
      raw_available_to_server: !!(item.raw_available_to_server || manifest.raw_available_to_server),
    };
  });
  const ingestionEvents = sourceArtifacts.map((artifact) => ({
    org_id: orgId,
    session_id: artifact.session_id,
    provider: "manual",
    event_type: `${artifact.source_kind}.submitted`,
    resource_name: artifact.storage_ref || artifact.source_hash || null,
    event_json: {
      provider: "manual",
      source_kind: artifact.source_kind,
      storage_mode: artifact.storage_mode,
      source_hash: artifact.source_hash,
      mime_type: artifact.mime_type,
    },
    processing_status: "processed",
    received_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
  }));
  const processingJobs = buildProcessingJobsFromSourceArtifacts({ orgId, sourceArtifacts });
  return { ingestionEvents, sourceArtifacts, processingJobs };
}

function sourceArtifactHasReadableRaw(artifact, processorMode = "local") {
  if (processorMode === "local") return artifact?.storage_mode === "local_only";
  if (processorMode === "tee") {
    return artifact?.storage_mode === "tee_direct"
      || artifact?.storage_mode === "encrypted_object"
      || artifact?.raw_available_to_server === true;
  }
  if (processorMode === "ordinary_cloud") {
    return artifact?.storage_mode === "encrypted_object"
      || artifact?.raw_available_to_server === true;
  }
  return artifact?.raw_available_to_server === true && artifact?.storage_mode !== "external_ref";
}

function processingJobShapeForSourceArtifact(artifact, { processorMode = "local" } = {}) {
  if (!artifact?.session_id || !(artifact.id || artifact.source_artifact_id)) return null;
  if (TEXT_DISTILL_SOURCE_KINDS.has(artifact.source_kind)) {
    if (sourceArtifactHasReadableRaw(artifact, processorMode)) {
      return {
        job_kind: "distill",
        prompt_version: "local-distill-v1",
        model_provider: "local",
        model_name: "deterministic-distiller",
      };
    }
    return {
      job_kind: "artifact_fetch",
      prompt_version: "artifact-fetch-v1",
      model_provider: "local",
      model_name: "metadata-fetcher",
    };
  }
  if (REVIEW_PREP_SOURCE_KINDS.has(artifact.source_kind)) {
    if (sourceArtifactHasReadableRaw(artifact, processorMode)) {
      return {
        job_kind: "review_prepare",
        prompt_version: "artifact-review-v1",
        model_provider: "local",
        model_name: "metadata-review-prep",
      };
    }
    return {
      job_kind: "artifact_fetch",
      prompt_version: "artifact-fetch-v1",
      model_provider: "local",
      model_name: "metadata-fetcher",
    };
  }
  return null;
}

function buildProcessingJobsFromSourceArtifacts({ orgId, sourceArtifacts = [], policyVersion, dueAt, processorMode = "local" } = {}) {
  return (sourceArtifacts || [])
    .map((artifact) => {
      const shape = processingJobShapeForSourceArtifact(artifact, { processorMode });
      if (!shape) return null;
      return {
        org_id: artifact.org_id || orgId,
        source_artifact_id: artifact.id || artifact.source_artifact_id,
        job_kind: shape.job_kind,
        processor_mode: processorMode,
        processor_status: "queued",
        tee_required: false,
        due_at: dueAt || addHoursIso(new Date().toISOString(), 48),
        policy_version: policyVersion || null,
        prompt_version: shape.prompt_version,
        model_provider: shape.model_provider,
        model_name: shape.model_name,
      };
    })
    .filter(Boolean);
}

function textSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 24);
}

function sanitizeDistilledText(text) {
  return String(text || "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\d .().-]{7,}\d)\b/g, "[phone]")
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatchingSentences(sentences, pattern, limit) {
  return sentences
    .filter((sentence) => pattern.test(sentence))
    .slice(0, limit)
    .map(sanitizeDistilledText);
}

function distillTranscriptText(text, { mode = "distilled_readout", maxItems = 5 } = {}) {
  const sentences = textSentences(text).map(sanitizeDistilledText);
  const important = sentences
    .filter((sentence) => /\b(decided|decision|blocked|blocker|risk|next|ship|launched|user|customer|metric|deadline|follow[- ]?up|todo|action)\b/i.test(sentence))
    .slice(0, maxItems);
  const questions = firstMatchingSentences(sentences, /\?/, 3);
  const actions = firstMatchingSentences(sentences, /\b(todo|action|next|follow[- ]?up|owner|deadline|ship|send|schedule)\b/i, 4);
  const fallback = sentences.slice(0, maxItems);
  return {
    mode,
    summary: (important.length ? important : fallback).slice(0, maxItems),
    open_questions: questions,
    action_items: actions,
    redaction_notes: [
      "Generated as paraphrased/distilled notes, not a transcript dump.",
      "Emails, links, and phone-like strings are masked before output.",
    ],
  };
}

function artifactTierForDecision(decision) {
  if (decision.max_tier === "T1") return "T1";
  return "T2";
}

function sourceTransformForDecision(decision) {
  if (decision.cohort_mode === "aggregate_only") return "aggregate";
  return "paraphrased_distillation";
}

function renderDerivedMarkdown({ session, decision, distillation }) {
  const title = session?.public_title || session?.title || decision?.label || "Session readout";
  const lines = [`# ${title}`, ""];
  lines.push(`Type: ${decision.session_type}`);
  lines.push(`Routing ceiling: ${decision.max_tier}`);
  lines.push(`Cohort mode: ${decision.cohort_mode}`);
  lines.push("");
  lines.push("## Summary");
  for (const item of distillation.summary || []) lines.push(`- ${item}`);
  if (distillation.action_items?.length) {
    lines.push("", "## Action Items");
    for (const item of distillation.action_items) lines.push(`- ${item}`);
  }
  if (distillation.open_questions?.length) {
    lines.push("", "## Open Questions");
    for (const item of distillation.open_questions) lines.push(`- ${item}`);
  }
  lines.push("", "## Handling");
  for (const item of distillation.redaction_notes || []) lines.push(`- ${item}`);
  return lines.join("\n");
}

function buildDerivedArtifactsFromTranscript({ orgId, session, sourceArtifact, processingJob, policy, transcriptText } = {}) {
  const decision = policyDecisionForSession(policy, session?.session_type);
  if (decision.cohort_mode === "never") {
    return { derivedArtifacts: [], approvalGates: [] };
  }
  const distillation = distillTranscriptText(transcriptText, { mode: decision.cohort_mode });
  const tier = artifactTierForDecision(decision);
  const readout = {
    org_id: orgId || session?.org_id || sourceArtifact?.org_id,
    session_id: session?.id || sourceArtifact?.session_id || null,
    source_artifact_id: sourceArtifact?.id || sourceArtifact?.source_artifact_id || null,
    processing_job_id: processingJob?.id || processingJob?.processing_job_id || null,
    artifact_kind: "readout",
    tier,
    source_transform: sourceTransformForDecision(decision),
    review_status: "needs_review",
    approval_state: "not_required",
    confidence: 0.65,
    content_json: {
      policy_key: decision.policy_key,
      policy_version: decision.policy_version,
      session_type: decision.session_type,
      max_tier: decision.max_tier,
      cohort_mode: decision.cohort_mode,
      distillation,
    },
    content_md: renderDerivedMarkdown({ session, decision, distillation }),
  };
  const artifacts = [readout];
  const approvalGates = [];
  if (decision.public_allowed) {
    const publicCandidate = {
      ...readout,
      artifact_kind: "public_candidate",
      tier: "T3",
      source_transform: "public_edit",
      review_status: "needs_review",
      approval_state: "pending",
    };
    artifacts.push(publicCandidate);
    for (const gateKey of decision.required_public_approvals || []) {
      approvalGates.push({
        org_id: publicCandidate.org_id,
        session_id: publicCandidate.session_id,
        derived_artifact_id: publicCandidate.id || null,
        gate_key: gateKey,
        gate_status: "pending",
      });
    }
  }
  return { derivedArtifacts: artifacts, approvalGates };
}

function zonedParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid date: ${value}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  if (out.hour === "24") out.hour = "00";
  return out;
}

function mondayKey(parts) {
  const month = MONTH_INDEX[parts.month];
  const day = Number(parts.day);
  const year = Number(parts.year);
  const utc = new Date(Date.UTC(year, month, day));
  const offset = WEEKDAYS.indexOf(parts.weekday);
  const monday = new Date(utc.getTime() - offset * 86400000);
  return monday.toISOString().slice(0, 10);
}

function formatWeekDateRange(mondayIso) {
  const monday = new Date(`${mondayIso}T00:00:00Z`);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(monday);
  const sundayMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(sunday);
  const startDay = monday.getUTCDate();
  const endDay = sunday.getUTCDate();
  return month === sundayMonth ? `${month} ${startDay}-${endDay}` : `${month} ${startDay}-${sundayMonth} ${endDay}`;
}

function sessionCellText(session, timeZone) {
  const start = zonedParts(session.starts_at, timeZone);
  const end = zonedParts(session.ends_at, timeZone);
  const time = `${start.hour}:${start.minute}-${end.hour}:${end.minute}`;
  const title = session.public_title || session.title || "Untitled session";
  const bits = [`${time} ${title}`];
  if (session.session_type || session.max_tier) {
    bits.push(`Type: ${session.session_type || "unknown"}${session.max_tier ? ` / ${session.max_tier}` : ""}`);
  }
  if (session.location) bits.push(`Location: ${session.location}`);
  if (session.google_meet_url) bits.push(`Meet: ${session.google_meet_url}`);
  return bits.join("\n");
}

function calendarJsonFromSessions({ sessions, lastRefresh = new Date().toISOString(), tabName = "Supabase Sessions", timeZone = "America/New_York" } = {}) {
  if (!Array.isArray(sessions)) throw new Error("sessions array is required");
  const byWeek = new Map();
  for (const session of sessions) {
    if (!session || session.status === "cancelled") continue;
    const effectiveTz = session.timezone || timeZone;
    const startParts = zonedParts(session.starts_at, effectiveTz);
    const weekKey = mondayKey(startParts);
    const weekday = startParts.weekday;
    const offset = WEEKDAYS.indexOf(weekday);
    if (offset === -1) continue;
    if (!byWeek.has(weekKey)) {
      byWeek.set(weekKey, Array.from({ length: 7 }, () => []));
    }
    byWeek.get(weekKey)[offset].push({ session, text: sessionCellText(session, effectiveTz) });
  }

  const rows = [[
    "Week",
    "Dates",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
    "On-Site / Available for Team Support",
    "Feedback loop goals",
    "Notes",
  ]];
  const orderedWeeks = Array.from(byWeek.keys()).sort();
  orderedWeeks.forEach((weekKey, idx) => {
    const cells = byWeek.get(weekKey).map((items) => items
      .sort((a, b) => String(a.session.starts_at).localeCompare(String(b.session.starts_at)))
      .map((item) => item.text)
      .join("\n\n"));
    rows.push([
      String(idx + 1),
      formatWeekDateRange(weekKey),
      ...cells,
      "",
      "",
      "",
    ]);
  });
  return {
    last_refresh: lastRefresh,
    source: "supabase-sessions-export",
    tabs: {
      [tabName]: rows,
    },
  };
}

module.exports = {
  WEEKDAYS,
  defaultPolicyPath,
  loadRoutingPolicy,
  validateRoutingPolicy,
  policyDecisionForSession,
  sessionAutomationFields,
  uuidFromStableKey,
  stableSessionIdForGoogleEvent,
  buildGoogleCalendarEvent,
  googleEventToSessionRow,
  googleEventAttendeeRows,
  googleEventsToSupabaseRows,
  captureArtifactToSourceArtifact,
  meetArtifactToSourceArtifact,
  meetArtifactRowsFromManifest,
  otterArtifactRowsFromManifest,
  manualSourceArtifactRowsFromManifest,
  processingJobShapeForSourceArtifact,
  buildProcessingJobsFromSourceArtifacts,
  distillTranscriptText,
  buildDerivedArtifactsFromTranscript,
  extractMeetingCode,
  calendarJsonFromSessions,
};

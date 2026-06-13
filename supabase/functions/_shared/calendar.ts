export const DEFAULT_ROUTING_POLICY = {
  schema_version: 1,
  policy_key: "transcript-routing",
  version: "2026-06-13",
  title: "Shape Rotator transcript routing policy",
  tiers: {
    T0: {
      label: "room",
      audience: "people who were there",
      raw_allowed: true,
    },
    T1: {
      label: "core",
      audience: "core team and coordinators",
      raw_allowed: "request_and_approval",
    },
    T2: {
      label: "cohort",
      audience: "gated cohort site",
      raw_allowed: false,
    },
    T3: {
      label: "public",
      audience: "open public site",
      raw_allowed: false,
    },
  },
  calendar_event_defaults: {
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: true,
  },
  transcript_naming: {
    preferred_pattern: "type_project_name_date",
    separator: "_",
    date_format: "YYYY-MM-DD",
    extension: "preserve_source_extension",
    example: "office_hours_conclave_2026-06-08.txt",
    type_slugs: {
      weekly_standup: "weekly_standup",
      office_hours: "office_hours",
      private_1on1: "private_1on1",
      salon: "salon",
      rd_jam: "rd_jam",
      demo_presentation: "demo_presentation",
      user_interview: "user_interview",
      planning_strategy: "planning_strategy",
    },
  },
  drive_vault: {
    shared_drive_name: "Shape Rotator Transcript Vault",
    admin_role: "manager",
    admins: [
      { name: "Tina", email: "tina@flashbots.net" },
      { name: "Andrew", email: "socrates1024@gmail.com" },
      { name: "Dmarz", email: "dan@flashbots.net" },
      { name: "Michael", email: "michael@flashbots.net" },
      { name: "Fred", email: "fredrik@flashbots.net" },
      { name: "Albi", email: "albi@flashbots.net" },
    ],
    root_folders: {
      inbox: "00_inbox",
      raw: "10_raw_transcripts_T0",
      calendar_matched: "20_calendar_matched",
      needs_calendar_match: "30_needs_calendar_match",
      derived_review: "40_derived_review",
      do_not_publish: "90_do_not_publish",
    },
    folder_routes: {
      weekly_standup: {
        path: "10_raw_transcripts_T0/weekly_standup",
        derived_path: "40_derived_review/weekly_standup",
        access_note: "Admins plus people in the room; only aggregate output can reach cohort.",
      },
      office_hours: {
        path: "10_raw_transcripts_T0/office_hours",
        derived_path: "40_derived_review/office_hours",
        access_note: "Admins plus project core team; cohort gets reviewed distilled readout only.",
      },
      private_1on1: {
        path: "90_do_not_publish/private_1on1",
        derived_path: "90_do_not_publish/private_1on1",
        access_note: "Admins only by default; private 1:1 and coordinator feedback never reach cohort/public surfaces.",
      },
      salon: {
        path: "10_raw_transcripts_T0/salon",
        derived_path: "40_derived_review/salon",
        access_note: "Admins plus speakers/organizers; public candidates require speaker pass.",
      },
      rd_jam: {
        path: "10_raw_transcripts_T0/rd_jam",
        derived_path: "40_derived_review/rd_jam",
        access_note: "Admins plus invited builders; cohort only after team call and hard distillation.",
      },
      demo_presentation: {
        path: "10_raw_transcripts_T0/demo_presentation",
        derived_path: "40_derived_review/demo_presentation",
        access_note: "Admins plus presenters; public candidates require presenter approval.",
      },
      user_interview: {
        path: "10_raw_transcripts_T0/user_interview",
        derived_path: "40_derived_review/user_interview",
        access_note: "Admins plus interview owner; only aggregate insights travel.",
      },
      planning_strategy: {
        path: "90_do_not_publish/planning_strategy",
        derived_path: "90_do_not_publish/planning_strategy",
        access_note: "Admins only by default; stops at core and never reaches cohort/public surfaces.",
      },
      unknown: {
        path: "30_needs_calendar_match",
        derived_path: "30_needs_calendar_match",
        access_note: "Hold until type, date, and audience are reviewed.",
      },
    },
  },
  session_types: {
    weekly_standup: {
      label: "Weekly standup",
      description: "Individual status session.",
      max_tier: "T2",
      cohort_mode: "aggregate_only",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
      notes: "Individual detail routes to coordinators only; aggregate signal can reach the cohort.",
    },
    office_hours: {
      label: "Office hours",
      description: "Project or core-team office-hours session.",
      max_tier: "T2",
      cohort_mode: "distilled_readout",
      public_allowed: false,
      default_auto_transcript: true,
      required_public_approvals: [],
      notes: "Project-internal by default; distilled cohort readout is allowed after review.",
    },
    private_1on1: {
      label: "Private 1:1",
      description: "Private one-on-one, coordinator feedback, or sensitive coaching session.",
      max_tier: "T1",
      cohort_mode: "never",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
      notes: "Tina/Andrew/private 1:1 material stays coordinator/core-only; no cohort or public derived artifact should be generated.",
    },
    salon: {
      label: "Salon",
      description: "Topic-led or speaker-led session.",
      max_tier: "T3",
      cohort_mode: "distilled_readout",
      public_allowed: true,
      default_auto_transcript: true,
      required_public_approvals: ["editorial_pass", "speaker_pass", "named_people_ok"],
      notes: "Public output requires full post-processing and explicit speaker approval.",
    },
    rd_jam: {
      label: "R&D / jam",
      description: "Idea-stage technical session.",
      max_tier: "T2",
      cohort_mode: "team_call_required",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
      notes: "Idea-stage IP stays cohort-only and should be distilled hard.",
    },
    demo_presentation: {
      label: "Demo / presentation",
      description: "Project or product demo.",
      max_tier: "T3",
      cohort_mode: "distilled_readout",
      public_allowed: true,
      default_auto_transcript: true,
      required_public_approvals: ["editorial_pass", "presenter_ok", "named_people_ok"],
      notes: "Presenter owns the material; public output requires presenter approval.",
    },
    user_interview: {
      label: "User interview",
      description: "External-subject interview.",
      max_tier: "T2",
      cohort_mode: "aggregate_only",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
      notes: "External non-consenting subjects stay core-only; aggregate insights may travel.",
    },
    planning_strategy: {
      label: "Planning / strategy",
      description: "Coordinator governance or strategy session.",
      max_tier: "T1",
      cohort_mode: "never",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
      notes: "Coordinator-internal governance stops at core.",
    },
  },
};

export function policyDecisionForSession(policy, sessionType) {
  const key = String(sessionType || "").trim();
  const sessionPolicy = policy?.session_types?.[key];
  if (!sessionPolicy) throw new Error(`unknown session_type "${key}"`);
  return {
    policy_key: policy.policy_key,
    policy_version: policy.version,
    session_type: key,
    label: sessionPolicy.label,
    max_tier: sessionPolicy.max_tier,
    cohort_mode: sessionPolicy.cohort_mode || "distilled_readout",
    public_allowed: !!sessionPolicy.public_allowed,
    default_auto_transcript: !!sessionPolicy.default_auto_transcript,
    required_public_approvals: [...(sessionPolicy.required_public_approvals || [])],
    calendar_event_defaults: {
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
      ...(policy.calendar_event_defaults || {}),
    },
  };
}

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

function addHoursIso(value, hours) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function sessionAutomationFields({ session, decision }) {
  const transcriptExpected = !!decision?.default_auto_transcript;
  return {
    transcript_status: transcriptExpected ? "expected" : "not_expected",
    distill_due_at: transcriptExpected ? addHoursIso(session?.ends_at || session?.end || session?.end_time, 48) : null,
  };
}

function stableGoogleEventId(sessionId) {
  const base = String(sessionId || "").toLowerCase().replace(/[^a-v0-9]/g, "");
  return base.length >= 5 ? `sros${base}`.slice(0, 1024) : null;
}

function requireSessionTime(session) {
  const startsAt = session?.starts_at || session?.start || session?.start_time;
  const endsAt = session?.ends_at || session?.end || session?.end_time;
  if (!startsAt || !endsAt) throw new Error("session starts_at and ends_at are required");
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error("session times must be valid datetimes");
  if (end <= start) throw new Error("session ends_at must be after starts_at");
  return { startsAt, endsAt };
}

export function normalizeAttendees(attendees = []) {
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
    `Cohort mode: ${decision.cohort_mode}`,
  ];
  if (session.public_description) lines.push("", String(session.public_description));
  return lines.join("\n");
}

export function buildGoogleCalendarEvent({ session, attendees = [], policy, botEmail, requestMeet } = {}) {
  if (!session || typeof session !== "object") throw new Error("session object is required");
  const decision = policyDecisionForSession(policy || DEFAULT_ROUTING_POLICY, session.session_type);
  const { startsAt, endsAt } = requireSessionTime(session);
  const attendeeInputs = [...(attendees || [])];
  if (session.bot_requested !== false && botEmail) attendeeInputs.push({ email: botEmail });
  const defaults = decision.calendar_event_defaults;
  const body = {
    summary: session.public_title || session.title,
    description: safeDescription(session, decision),
    start: { dateTime: startsAt, timeZone: session.timezone || "America/New_York" },
    end: { dateTime: endsAt, timeZone: session.timezone || "America/New_York" },
    attendees: normalizeAttendees(attendeeInputs),
    guestsCanModify: defaults.guestsCanModify === true,
    guestsCanInviteOthers: defaults.guestsCanInviteOthers === true,
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
  const eventId = stableGoogleEventId(session.id || session.session_id);
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

export function extractMeetingCode(value) {
  const text = String(value || "");
  const meet = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(text);
  if (meet) return meet[1].toLowerCase();
  const bare = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i.exec(text);
  return bare ? bare[1].toLowerCase() : null;
}

export function googleEventToSessionRow(event, { orgId, calendarConnectionId, policy } = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const sessionType = privateProps.shape_session_type || "office_hours";
  const decision = policy ? policyDecisionForSession(policy, sessionType) : null;
  const meetUrl = event?.hangoutLink || event?.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri || null;
  return {
    id: privateProps.shape_session_id || undefined,
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
      session: { ends_at: event?.end?.dateTime || event?.end?.date || null },
      decision,
    }),
  };
}

export function googleEventAttendeeRows(event, { orgId, sessionId, botEmail } = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const resolvedSessionId = sessionId || privateProps.shape_session_id || undefined;
  const bot = String(botEmail || "").trim().toLowerCase();
  return (event?.attendees || []).map((attendee) => {
    const email = String(attendee?.email || "").trim().toLowerCase();
    if (!email) return null;
    return {
      org_id: orgId,
      session_id: resolvedSessionId,
      email,
      attendee_role: bot && email === bot ? "bot" : "guest",
      invite_status: attendee.responseStatus === "needsAction" ? "needs_action" : (attendee.responseStatus || "pending"),
      google_response_status: attendee.responseStatus || null,
    };
  }).filter(Boolean);
}

function defaultSourceKind(provider, artifactKind) {
  if (provider === "otter") {
    if (artifactKind === "slides" || artifactKind === "slide") return "otter_slide";
    if (artifactKind === "summary") return "otter_summary";
    if (artifactKind === "recording" || artifactKind === "audio") return "audio";
    return "otter_transcript";
  }
  if (artifactKind === "smart_notes") return "meet_smart_notes";
  return "meet_transcript";
}

export function captureArtifactToSourceArtifact({ orgId, sessionId, captureArtifact, fetchedRaw = false }) {
  const metadata = captureArtifact?.metadata || {};
  return {
    org_id: orgId,
    session_id: sessionId,
    capture_artifact_id: captureArtifact?.id,
    source_kind: defaultSourceKind(captureArtifact.provider, captureArtifact.artifact_kind),
    source_tier: "T0",
    storage_mode: fetchedRaw ? "encrypted_object" : "external_ref",
    storage_ref: captureArtifact?.storage_ref || captureArtifact?.drive_file_id || captureArtifact?.provider_resource_name || captureArtifact?.conference_record || captureArtifact?.conversation_id || null,
    source_hash: captureArtifact?.source_hash || metadata.source_hash || metadata.hash || null,
    mime_type: captureArtifact?.mime_type || metadata.mime_type || metadata.mimeType || null,
    size_bytes: captureArtifact?.size_bytes || metadata.size_bytes || metadata.sizeBytes || null,
    raw_available_to_server: !!fetchedRaw,
  };
}

function normalizeMeetKind(kind) {
  const value = String(kind || "transcript").trim().toLowerCase();
  if (["smartnotes", "smart_notes", "gemini_notes"].includes(value)) return "smart_notes";
  if (["recording", "recordings"].includes(value)) return "recording";
  if (["attendance", "attendance_report"].includes(value)) return "attendance";
  return "transcript";
}

function normalizeOtterKind(kind) {
  const value = String(kind || "transcript").trim().toLowerCase();
  if (["slide", "slides", "screenshot", "screenshots", "screen_capture", "screen_captures", "presentation", "image", "images"].includes(value)) return "slides";
  if (["summary", "notes"].includes(value)) return "summary";
  if (["recording", "recordings", "audio", "video"].includes(value)) return "recording";
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
  const rows = Array.isArray(manifest?.artifacts) ? [...manifest.artifacts] : [];
  for (const [key, kind] of [
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
  ]) {
    pushManifestValue(rows, manifest?.[key], kind);
  }
  return rows;
}

export function meetArtifactRowsFromManifest({ orgId, sessionId, manifest, fetchedRaw = false } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const conferenceRecord = manifest?.conference_record || manifest?.conferenceRecord || manifest?.name || null;
  const meetSpace = manifest?.meet_space || manifest?.meetSpace || null;
  const rawArtifacts = Array.isArray(manifest?.artifacts) ? [...manifest.artifacts] : [];
  for (const [key, kind] of [
    ["transcripts", "transcript"],
    ["smart_notes", "smart_notes"],
    ["smartNotes", "smart_notes"],
    ["recordings", "recording"],
    ["attendance", "attendance"],
    ["attendance_reports", "attendance"],
  ]) {
    if (Array.isArray(manifest?.[key])) {
      for (const item of manifest[key]) rawArtifacts.push({ artifact_kind: kind, ...item });
    }
  }
  const captureArtifacts = rawArtifacts.map((item, index) => ({
    org_id: orgId,
    session_id: sessionId,
    provider: "google_meet",
    conference_record: item.conference_record || item.conferenceRecord || conferenceRecord,
    meet_space: item.meet_space || item.meetSpace || meetSpace,
    artifact_kind: normalizeMeetKind(item.artifact_kind || item.kind),
    provider_resource_name: item.provider_resource_name || item.resource_name || item.name || null,
    storage_ref: item.storage_ref || item.file || item.url || null,
    drive_file_id: item.drive_file_id || item.driveFileId || null,
    drive_export_uri: item.drive_export_uri || item.driveExportUri || item.export_uri || null,
    status: item.status || "detected",
    raw_retention_deadline: item.raw_retention_deadline || item.rawRetentionDeadline || manifest.raw_retention_deadline || null,
    metadata: { index, title: item.title || null, mime_type: item.mime_type || item.mimeType || null },
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
    .map((artifact) => captureArtifactToSourceArtifact({ orgId, sessionId, captureArtifact: artifact, fetchedRaw }));
  return { ingestionEvents, captureArtifacts, sourceArtifacts };
}

export function otterArtifactRowsFromManifest({ orgId, sessionId, manifest, fetchedRaw = false } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const conversationId = manifest?.conversation_id || manifest?.conversationId || manifest?.id || null;
  const rawArtifacts = collectOtterManifestArtifacts(manifest);
  const captureArtifacts = rawArtifacts.map((item, index) => ({
    org_id: orgId,
    session_id: sessionId,
    provider: "otter",
    artifact_kind: normalizeOtterKind(item.artifact_kind || item.kind),
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
      export_source: item.export_source || item.exportSource || manifest?.export_source || manifest?.exportSource || null,
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
    .map((artifact) => captureArtifactToSourceArtifact({ orgId, sessionId, captureArtifact: artifact, fetchedRaw }));
  return { ingestionEvents, captureArtifacts, sourceArtifacts };
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

export function manualSourceArtifactRowsFromManifest({ orgId, sessionId, manifest } = {}) {
  const rawArtifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
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
  const receivedAt = new Date().toISOString();
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
    received_at: receivedAt,
    processed_at: receivedAt,
  }));
  return { ingestionEvents, sourceArtifacts };
}

export function buildProcessingJobsFromSourceArtifacts({ orgId, sourceArtifacts = [], policyVersion, dueAt, processorMode = "local" } = {}) {
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

export function processingJobShapeForSourceArtifact(artifact, { processorMode = "local" } = {}) {
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

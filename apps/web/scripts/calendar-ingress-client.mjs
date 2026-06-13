export const DEFAULT_CALENDAR_CONFIG_KEY = "srfg:calendar_ingress_config";
export const DEFAULT_CALENDAR_ID = "c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com";
export const DEFAULT_SUPABASE_URL = "https://txjntzwksiluvqcpccpc.supabase.co";
export const DEFAULT_CALENDAR_TIMEZONE = "America/New_York";
export const DEFAULT_CAPTURE_BOT_EMAIL = "cube@shaperotator.xyz";
export const DEFAULT_CALENDAR_ADMINS = Object.freeze([
  "tina@flashbots.net",
  "socrates1024@gmail.com",
  "dan@flashbots.net",
  "michael@flashbots.net",
  "fredrik@flashbots.net",
  "albi@flashbots.net",
]);
export const DEFAULT_CALENDAR_INGRESS_CONFIG = Object.freeze({
  supabaseUrl: DEFAULT_SUPABASE_URL,
  calendarId: DEFAULT_CALENDAR_ID,
  botEmail: DEFAULT_CAPTURE_BOT_EMAIL,
});
const PERSISTED_CONFIG_OMIT_KEYS = new Set([
  "accessToken",
  "access_token",
  "googleAccessToken",
  "google_access_token",
  "googleRefreshToken",
  "google_refresh_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "calendarId",
  "calendar_id",
]);
export const MANUAL_SOURCE_KINDS = [
  "manual_upload",
  "meet_transcript",
  "meet_smart_notes",
  "otter_transcript",
  "otter_summary",
  "otter_slide",
  "drive_doc",
  "audio",
  "video",
  "github",
  "router",
];
export const MANUAL_STORAGE_MODES = ["local_only", "external_ref"];

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

export function calendarIngressConfigWithDefaults(config = {}) {
  return {
    supabaseUrl: DEFAULT_SUPABASE_URL,
    botEmail: DEFAULT_CAPTURE_BOT_EMAIL,
    ...(config || {}),
    calendarId: DEFAULT_CALENDAR_ID,
  };
}

export function loadCalendarIngressConfig(storage = globalThis.localStorage, key = DEFAULT_CALENDAR_CONFIG_KEY) {
  const fromWindow = globalThis.SHAPE_CALENDAR_INGRESS || null;
  if (fromWindow && typeof fromWindow === "object") return calendarIngressConfigWithDefaults(fromWindow);
  if (!storage) return calendarIngressConfigWithDefaults();
  try {
    const raw = storage.getItem(key);
    return calendarIngressConfigWithDefaults(raw ? persistableCalendarIngressConfig(JSON.parse(raw)) : {});
  } catch {
    return calendarIngressConfigWithDefaults();
  }
}

export function persistableCalendarIngressConfig(config = {}) {
  return Object.fromEntries(
    Object.entries(config || {}).filter(([key]) => !PERSISTED_CONFIG_OMIT_KEYS.has(key)),
  );
}

export function saveCalendarIngressConfig(config, storage = globalThis.localStorage, key = DEFAULT_CALENDAR_CONFIG_KEY) {
  if (!storage) return;
  storage.setItem(key, JSON.stringify(persistableCalendarIngressConfig(config)));
}

function dateTimePartsInZone(value, timeZone = DEFAULT_CALENDAR_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function formatDateTimeLocalInTimeZone(value, timeZone = DEFAULT_CALENDAR_TIMEZONE) {
  const parts = dateTimePartsInZone(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function defaultCalendarDateTimeValue(offsetHours, {
  now = new Date(),
  timeZone = DEFAULT_CALENDAR_TIMEZONE,
} = {}) {
  const date = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
  date.setUTCMinutes(0, 0, 0);
  return formatDateTimeLocalInTimeZone(date, timeZone);
}

export function calendarIngressReadiness(config = {}) {
  const effectiveConfig = calendarIngressConfigWithDefaults(config);
  const browserSafe = [
    ["Supabase URL", effectiveConfig.supabaseUrl],
    ["Supabase anon key", effectiveConfig.supabaseAnonKey],
    ["signed-in access token", effectiveConfig.accessToken],
    ["org ID", effectiveConfig.orgId],
    ["calendar connection ID", effectiveConfig.calendarConnectionId],
  ];
  const operator = [
    ["Google calendar ID", effectiveConfig.calendarId],
    ["Drive artifact folder", effectiveConfig.driveArtifactFolderId],
  ];
  const missingBrowserSafe = browserSafe
    .filter(([, value]) => !String(value || "").trim())
    .map(([label]) => label);
  const missingOperator = operator
    .filter(([, value]) => !String(value || "").trim())
    .map(([label]) => label);
  return {
    browserReady: missingBrowserSafe.length === 0,
    missingBrowserSafe,
    missingOperator,
  };
}

export function normalizeSessionType(value, policy = DEFAULT_ROUTING_POLICY) {
  const key = String(value || "").trim();
  if (!policy.session_types[key]) throw new Error(`Unknown session type: ${key}`);
  return key;
}

export function policyDecision(sessionType, policy = DEFAULT_ROUTING_POLICY) {
  const key = normalizeSessionType(sessionType, policy);
  const item = policy.session_types[key];
  return {
    policy_key: policy.policy_key,
    policy_version: policy.version,
    session_type: key,
    label: item.label,
    max_tier: item.max_tier,
    cohort_mode: item.cohort_mode || "distilled_readout",
    public_allowed: !!item.public_allowed,
    default_auto_transcript: !!item.default_auto_transcript,
    required_public_approvals: [...(item.required_public_approvals || [])],
    calendar_event_defaults: {
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
      ...(policy.calendar_event_defaults || {}),
    },
  };
}

export function parseAttendees(value) {
  const seen = new Set();
  const rows = String(value || "")
    .split(/[\n,;]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((email) => {
      const match = /<([^>]+)>/.exec(email);
      return match ? match[1].trim().toLowerCase() : email;
    })
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    .filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
  return rows.map((email) => ({ email }));
}

export function attendeeEmailList(value) {
  return parseAttendees(value).map((attendee) => attendee.email);
}

export function mergeAttendeeEmails(existing, additions = []) {
  const existingEmails = attendeeEmailList(existing);
  const addedText = Array.isArray(additions)
    ? additions.map((item) => item?.email || item).join("\n")
    : additions;
  const seen = new Set();
  return [...existingEmails, ...attendeeEmailList(addedText)]
    .filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    })
    .join("\n");
}

function labelize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function contactFromPerson(person = {}) {
  const email = attendeeEmailList(person.email || "")[0];
  if (!email) return null;
  const id = String(person.record_id || person.id || email).trim();
  const team = String(person.team || "").trim();
  const secondaryTeams = Array.isArray(person.secondary_teams)
    ? person.secondary_teams.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const roleClass = String(person.role_class || "visiting-scholar").trim();
  const name = String(person.name || email).trim();
  return {
    id,
    name,
    email,
    team: team || null,
    secondaryTeams,
    roleClass,
    role: String(person.role || "").trim() || null,
    label: `${name} <${email}>`,
  };
}

function uniqueEmails(contacts = []) {
  const seen = new Set();
  return contacts
    .map((contact) => contact.email)
    .filter(Boolean)
    .filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
}

function groupFromContacts({ id, label, kind, contacts }) {
  const emails = uniqueEmails(contacts);
  if (!emails.length) return null;
  return {
    id,
    label,
    kind,
    count: emails.length,
    emails,
  };
}

export function cohortInviteDirectoryFromSurface(surface = {}) {
  const contacts = (Array.isArray(surface.people) ? surface.people : [])
    .map(contactFromPerson)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const roleGroups = [
    ["role:cohort-member", "cohort members", "role", (contact) => contact.roleClass === "cohort-member"],
    ["role:coordinator", "coordinators", "role", (contact) => contact.roleClass === "coordinator"],
    ["role:visiting-scholar", "visiting scholars", "role", (contact) => contact.roleClass === "visiting-scholar"],
  ]
    .map(([id, label, kind, match]) => groupFromContacts({
      id,
      label,
      kind,
      contacts: contacts.filter(match),
    }))
    .filter(Boolean);
  const teams = (Array.isArray(surface.teams) ? surface.teams : [])
    .map((team) => ({
      id: String(team.record_id || team.id || "").trim(),
      label: String(team.name || team.record_id || team.id || "").trim(),
    }))
    .filter((team) => team.id && team.label)
    .sort((a, b) => a.label.localeCompare(b.label));
  const teamGroups = teams
    .map((team) => groupFromContacts({
      id: `team:${team.id}`,
      label: labelize(team.label),
      kind: "team",
      contacts: contacts.filter((contact) => contact.team === team.id || contact.secondaryTeams.includes(team.id)),
    }))
    .filter(Boolean);
  return {
    people: contacts,
    groups: [...roleGroups, ...teamGroups],
    missingEmailCount: (Array.isArray(surface.people) ? surface.people : []).length - contacts.length,
  };
}

export function googleCalendarManagedUrl(calendarId = DEFAULT_CALENDAR_ID) {
  const id = String(calendarId || "").trim();
  if (!id) throw new Error("Google calendar ID is required");
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(id)}`;
}

export function toCalendarDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return `${text}:00`;
  return text;
}

export function buildCalendarIngressPayload(values, { policy = DEFAULT_ROUTING_POLICY, now = new Date(), idFactory } = {}) {
  const getId = idFactory || (() => globalThis.crypto?.randomUUID?.() || `sess_${now.getTime()}`);
  const publicTitle = String(values.public_title || values.publicTitle || values.title || "").trim();
  if (!publicTitle) throw new Error("Calendar title is required");
  const sessionType = normalizeSessionType(values.session_type || values.sessionType, policy);
  const startsAt = toCalendarDateTime(values.starts_at || values.startsAt);
  const endsAt = toCalendarDateTime(values.ends_at || values.endsAt);
  if (!startsAt || !endsAt) throw new Error("Start and end are required");
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("End must be after start");
  }
  const decision = policyDecision(sessionType, policy);
  const session = {
    id: values.id || getId(),
    title: String(values.title || publicTitle).trim(),
    public_title: publicTitle,
    public_description: String(values.public_description || values.publicDescription || "").trim(),
    session_type: sessionType,
    max_tier: decision.max_tier,
    status: values.status || "requested",
    starts_at: startsAt,
    ends_at: endsAt,
    timezone: String(values.timezone || DEFAULT_CALENDAR_TIMEZONE).trim(),
    location: String(values.location || "").trim() || null,
    bot_requested: values.bot_requested !== false && values.botRequested !== false,
  };
  const attendees = Array.isArray(values.attendees)
    ? parseAttendees(values.attendees.map((item) => item.email || item).join("\n"))
    : parseAttendees(values.attendee_emails || values.attendeeEmails || "");
  return {
    session,
    attendees,
    request_meet: values.request_meet !== false && values.requestMeet !== false,
    decision,
  };
}

export function buildEventRequestRow({ orgId, payload, surface = "web" }) {
  if (!orgId) throw new Error("orgId is required");
  return {
    org_id: orgId,
    status: "pending",
    request_json: {
      session: {
        ...payload.session,
        status: "requested",
      },
      attendees: payload.attendees,
      request_meet: payload.request_meet,
      decision: payload.decision,
      submitted_at: new Date().toISOString(),
      surface,
    },
  };
}

export function buildCreateCalendarEventBody({
  orgId,
  calendarConnectionId,
  payload,
  dryRun = false,
  persist = true,
}) {
  if (!orgId) throw new Error("orgId is required");
  if (!calendarConnectionId) throw new Error("calendarConnectionId is required");
  return {
    org_id: orgId,
    calendar_connection_id: calendarConnectionId || undefined,
    session: {
      ...payload.session,
      status: "scheduled",
    },
    attendees: payload.attendees,
    request_meet: payload.request_meet,
    dry_run: !!dryRun,
    persist: persist !== false,
  };
}

export function buildManualSourceManifest(values = {}) {
  const sessionId = String(values.session_id || values.sessionId || "").trim();
  if (!sessionId) throw new Error("Session ID is required");
  const sourceKind = String(values.source_kind || values.sourceKind || "manual_upload").trim();
  if (!MANUAL_SOURCE_KINDS.includes(sourceKind)) throw new Error(`Unsupported source kind: ${sourceKind}`);
  const storageMode = String(values.storage_mode || values.storageMode || "external_ref").trim();
  if (!MANUAL_STORAGE_MODES.includes(storageMode)) throw new Error(`Unsupported storage mode: ${storageMode}`);
  const storageRef = String(values.storage_ref || values.storageRef || values.file || values.url || "").trim();
  if (!storageRef) throw new Error("Source ref/path is required");
  const sourceTier = "T0";
  const mimeType = String(values.mime_type || values.mimeType || "").trim();
  const sourceHash = String(values.source_hash || values.sourceHash || "").trim();
  const sizeValue = String(values.size_bytes || values.sizeBytes || "").trim();
  const sizeBytes = sizeValue ? Number(sizeValue) : null;
  if (sizeValue && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) throw new Error("Size bytes must be a positive number");
  return {
    session_id: sessionId,
    provider: "manual",
    processor_mode: "local",
    manifest: {
      provider: "manual",
      source_tier: sourceTier,
      storage_mode: storageMode,
      raw_available_to_server: false,
      artifacts: [{
        source_kind: sourceKind,
        source_tier: sourceTier,
        storage_mode: storageMode,
        storage_ref: storageRef,
        raw_available_to_server: false,
        ...(mimeType ? { mime_type: mimeType } : {}),
        ...(sourceHash ? { source_hash: sourceHash } : {}),
        ...(sizeBytes != null ? { size_bytes: sizeBytes } : {}),
      }],
    },
  };
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function requireSignedInSupabaseConfig(config) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    throw new Error("Supabase URL and anon key are required");
  }
  if (!config?.accessToken) {
    throw new Error("Signed-in access token is required");
  }
}

function supabaseUrl(config, table, query = {}) {
  const url = new URL(`${trimSlash(config.supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return String(url);
}

function supabaseHeaders(config, prefer) {
  return {
    apikey: config.supabaseAnonKey,
    authorization: `Bearer ${config.accessToken}`,
    "content-type": "application/json",
    ...(prefer ? { prefer } : {}),
  };
}

async function supabaseSelect({ config, table, query, fetchImpl = fetch }) {
  requireSignedInSupabaseConfig(config);
  const response = await fetchImpl(supabaseUrl(config, table, query), {
    method: "GET",
    headers: supabaseHeaders(config),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`${table} select failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

async function supabasePatch({ config, table, query, body, fetchImpl = fetch }) {
  requireSignedInSupabaseConfig(config);
  const response = await fetchImpl(supabaseUrl(config, table, query), {
    method: "PATCH",
    headers: supabaseHeaders(config, "return=representation"),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`${table} update failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

export function buildGoogleEventPreview(payload, { botEmail } = {}) {
  const defaults = payload.decision.calendar_event_defaults;
  const attendees = [...payload.attendees];
  if (payload.session.bot_requested && botEmail) attendees.push({ email: botEmail });
  return {
    summary: payload.session.public_title,
    description: [
      "Managed by Shape Rotator OS.",
      `Session type: ${payload.decision.label}`,
      `Routing ceiling: ${payload.decision.max_tier}`,
      `Cohort mode: ${payload.decision.cohort_mode}`,
      payload.session.public_description ? `\n${payload.session.public_description}` : "",
    ].filter(Boolean).join("\n"),
    start: { dateTime: payload.session.starts_at, timeZone: payload.session.timezone },
    end: { dateTime: payload.session.ends_at, timeZone: payload.session.timezone },
    attendees,
    guestsCanModify: defaults.guestsCanModify === true,
    guestsCanInviteOthers: defaults.guestsCanInviteOthers === true,
    guestsCanSeeOtherGuests: defaults.guestsCanSeeOtherGuests !== false,
    conferenceData: payload.request_meet ? { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } } : undefined,
    extendedProperties: {
      private: {
        shape_session_id: payload.session.id,
        shape_policy_key: payload.decision.policy_key,
        shape_policy_version: payload.decision.policy_version,
        shape_session_type: payload.decision.session_type,
        shape_max_tier: payload.decision.max_tier,
      },
    },
  };
}

export async function postEventRequest({ config, row, fetchImpl = fetch }) {
  requireSignedInSupabaseConfig(config);
  const response = await fetchImpl(`${trimSlash(config.supabaseUrl)}/rest/v1/event_requests`, {
    method: "POST",
    headers: supabaseHeaders(config, "return=representation"),
    body: JSON.stringify(row),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`event_requests insert failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

export async function callCreateCalendarEvent({ config, body, fetchImpl = fetch }) {
  const url = config?.createEventUrl
    || (config?.supabaseUrl ? `${trimSlash(config.supabaseUrl)}/functions/v1/create-calendar-event` : "");
  if (!url) throw new Error("Create-event function URL is required");
  const token = config.accessToken;
  if (!token) throw new Error("Signed-in access token is required");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...(config.supabaseAnonKey ? { apikey: config.supabaseAnonKey } : {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`create-calendar-event failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

export async function callIngestArtifacts({ config, body, fetchImpl = fetch }) {
  const url = config?.ingestArtifactsUrl
    || (config?.supabaseUrl ? `${trimSlash(config.supabaseUrl)}/functions/v1/ingest-artifacts` : "");
  if (!url) throw new Error("Ingest-artifacts function URL is required");
  const token = config.accessToken;
  if (!token) throw new Error("Signed-in access token is required");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...(config.supabaseAnonKey ? { apikey: config.supabaseAnonKey } : {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`ingest-artifacts failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

export async function callReviewTranscriptArtifact({ config, body, fetchImpl = fetch }) {
  const url = config?.reviewTranscriptArtifactUrl
    || (config?.supabaseUrl ? `${trimSlash(config.supabaseUrl)}/functions/v1/review-transcript-artifact` : "");
  if (!url) throw new Error("Review function URL is required");
  const token = config.accessToken;
  if (!token) throw new Error("Signed-in access token is required");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...(config.supabaseAnonKey ? { apikey: config.supabaseAnonKey } : {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`review-transcript-artifact failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

export async function fetchCalendarOpsQueue({ config, fetchImpl = fetch, limit = 20 } = {}) {
  requireSignedInSupabaseConfig(config);
  if (!config.orgId) throw new Error("org id is required");
  const orgFilter = `eq.${config.orgId}`;
  const [eventRequests, processingJobs, derivedArtifacts, approvalGates] = await Promise.all([
    supabaseSelect({
      config,
      table: "event_requests",
      query: {
        select: "id,org_id,session_id,status,request_json,reviewed_at,review_notes,created_at",
        org_id: orgFilter,
        status: "eq.pending",
        order: "created_at.asc",
        limit,
      },
      fetchImpl,
    }),
    supabaseSelect({
      config,
      table: "processing_jobs",
      query: {
        select: "id,org_id,source_artifact_id,job_kind,processor_mode,processor_status,due_at,prompt_version,model_provider,model_name,error,created_at",
        org_id: orgFilter,
        processor_status: "in.(queued,running,failed)",
        order: "due_at.asc.nullslast,created_at.asc",
        limit,
      },
      fetchImpl,
    }),
    supabaseSelect({
      config,
      table: "derived_artifacts",
      query: {
        select: "id,org_id,session_id,artifact_kind,tier,source_transform,review_status,approval_state,confidence,content_json,content_md,created_at",
        org_id: orgFilter,
        review_status: "in.(generated,needs_review,reviewed,blocked)",
        order: "created_at.asc",
        limit,
      },
      fetchImpl,
    }),
    supabaseSelect({
      config,
      table: "approval_gates",
      query: {
        select: "id,org_id,session_id,derived_artifact_id,gate_key,gate_status,decided_at,notes,created_at",
        org_id: orgFilter,
        gate_status: "eq.pending",
        order: "created_at.asc",
        limit,
      },
      fetchImpl,
    }),
  ]);
  return { eventRequests, processingJobs, derivedArtifacts, approvalGates };
}

export async function patchEventRequestStatus({ config, requestId, status, sessionId, reviewNotes, fetchImpl = fetch }) {
  if (!requestId) throw new Error("requestId is required");
  if (!["approved", "rejected", "cancelled"].includes(status)) throw new Error(`unsupported request status: ${status}`);
  return supabasePatch({
    config,
    table: "event_requests",
    query: {
      id: `eq.${requestId}`,
      org_id: `eq.${config.orgId}`,
    },
    body: {
      status,
      session_id: sessionId || null,
      reviewed_at: new Date().toISOString(),
      ...(reviewNotes ? { review_notes: reviewNotes } : {}),
    },
    fetchImpl,
  });
}

export async function approveEventRequest({ config, request, fetchImpl = fetch }) {
  if (!request?.id) throw new Error("request is required");
  const payload = {
    session: request.request_json?.session,
    attendees: request.request_json?.attendees || [],
    request_meet: request.request_json?.request_meet !== false,
  };
  const calendarResult = await callCreateCalendarEvent({
    config,
    body: {
      ...buildCreateCalendarEventBody({
        orgId: request.org_id || config.orgId,
        calendarConnectionId: config.calendarConnectionId,
        payload,
        dryRun: false,
        persist: true,
      }),
      event_request_id: request.id,
    },
    fetchImpl,
  });
  const sessionId = calendarResult?.session?.id || request.request_json?.session?.id || request.session_id || null;
  const requestRows = calendarResult?.persisted?.eventRequests?.length
    ? calendarResult.persisted.eventRequests
    : await patchEventRequestStatus({
      config,
      requestId: request.id,
      status: "approved",
      sessionId,
      fetchImpl,
    });
  return { calendarResult, requestRows };
}

export async function rejectEventRequest({ config, requestId, reviewNotes, fetchImpl = fetch }) {
  return patchEventRequestStatus({
    config,
    requestId,
    status: "rejected",
    reviewNotes,
    fetchImpl,
  });
}

export async function reviewDerivedArtifact({ config, artifactId, reviewStatus, approvalState, notes, fetchImpl = fetch }) {
  if (!artifactId) throw new Error("artifactId is required");
  if (!["reviewed", "blocked", "published", "needs_review"].includes(reviewStatus)) {
    throw new Error(`unsupported review status: ${reviewStatus}`);
  }
  const result = await callReviewTranscriptArtifact({
    config,
    body: {
      action: "review_artifact",
      org_id: config.orgId,
      artifact_id: artifactId,
      review_status: reviewStatus,
      ...(approvalState ? { approval_state: approvalState } : {}),
      ...(notes ? { notes } : {}),
      ...(reviewStatus === "published" ? { publish_public: true } : {}),
    },
    fetchImpl,
  });
  return result.artifact ? [result.artifact] : [];
}

export async function decideApprovalGate({ config, gate, gateStatus, notes, fetchImpl = fetch }) {
  if (!gate?.id) throw new Error("gate is required");
  if (!["approved", "blocked", "not_required"].includes(gateStatus)) {
    throw new Error(`unsupported gate status: ${gateStatus}`);
  }
  const result = await callReviewTranscriptArtifact({
    config,
    body: {
      action: "decide_gate",
      org_id: config.orgId,
      gate_id: gate.id,
      gate_status: gateStatus,
      ...(notes ? { notes } : {}),
    },
    fetchImpl,
  });
  return Array.isArray(result.gates) ? result.gates : [];
}

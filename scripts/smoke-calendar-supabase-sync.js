#!/usr/bin/env node
const crypto = require("node:crypto");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");
const {
  buildGoogleCalendarEvent,
  loadRoutingPolicy,
} = require("./lib/calendar-integration.cjs");

const DEFAULT_BOT_EMAIL = "cube@shaperotator.xyz";

function usage() {
  return [
    "Usage:",
    "  node scripts/smoke-calendar-supabase-sync.js --env-file .env.calendar.local",
    "",
    "Creates a temporary timed Google Meet event on the managed calendar, waits",
    "for the Supabase session copy, verifies Meet/Cube/guest-lock evidence, then",
    "deletes the Google event and test Supabase rows.",
    "",
    "Options:",
    "  --timeout-ms N       Poll timeout. Default: 90000",
    "  --poll-ms N          Poll interval. Default: 5000",
    "  --keep               Leave the Google/Supabase smoke event in place",
    "  --json               Print JSON only",
    "  --env-file FILE      Load local KEY=value secrets before env fallbacks",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_OAUTH_REFRESH_TOKEN + GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  SHAPE_CALENDAR_BOT_EMAIL",
    "  SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  ORG_ID",
    "  CALENDAR_CONNECTION_ID",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function required(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveGoogleAccessToken(env = process.env, fetchImpl = fetch) {
  if (env.GOOGLE_OAUTH_REFRESH_TOKEN && env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    const body = new URLSearchParams();
    body.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
    body.set("client_secret", env.GOOGLE_OAUTH_CLIENT_SECRET);
    body.set("refresh_token", env.GOOGLE_OAUTH_REFRESH_TOKEN);
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
  const token = env.GOOGLE_CALENDAR_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN;
  if (token) return token;
  throw new Error("Google access token or refresh credentials are required");
}

function buildSmokeSession({ now = new Date(), id = crypto.randomUUID() } = {}) {
  const start = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  const short = id.replace(/-/g, "").slice(0, 8);
  return {
    id,
    title: `Shape Rotator sync smoke ${short}`,
    public_title: `Shape Rotator sync smoke ${short}`,
    session_type: "office_hours",
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    timezone: "America/New_York",
  };
}

function googleEventsUrl(calendarId, suffix = "") {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`);
}

async function insertGoogleEvent({ calendarId, accessToken, payload, fetchImpl = fetch } = {}) {
  const url = googleEventsUrl(required(calendarId, "calendarId"));
  url.searchParams.set("sendUpdates", payload.query.sendUpdates);
  url.searchParams.set("conferenceDataVersion", String(payload.query.conferenceDataVersion));
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(accessToken, "accessToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Calendar events.insert ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function deleteGoogleEvent({ calendarId, accessToken, eventId, fetchImpl = fetch } = {}) {
  if (!eventId) return false;
  const url = googleEventsUrl(required(calendarId, "calendarId"), `/${encodeURIComponent(eventId)}`);
  url.searchParams.set("sendUpdates", "none");
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${required(accessToken, "accessToken")}` },
  });
  if (response.status === 204 || response.status === 410 || response.status === 404) return true;
  const data = await response.json().catch(() => null);
  const error = new Error(`Google Calendar events.delete ${response.status}`);
  error.status = response.status;
  error.body = data;
  throw error;
}

async function fetchSmokeSession({ supabaseUrl, serviceRoleKey, sessionId, fetchImpl = fetch } = {}) {
  const sessions = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    query: {
      select: "id,title,public_title,status,starts_at,ends_at,timezone,session_type,calendar_connection_id,google_event_id,google_meet_url,google_meeting_code,guests_can_modify,guests_can_invite_others,guests_can_see_other_guests,transcript_status",
      id: `eq.${required(sessionId, "sessionId")}`,
      limit: "1",
    },
    fetchImpl,
  });
  const session = Array.isArray(sessions) ? sessions[0] || null : null;
  if (!session) return null;
  const attendees = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "session_attendees",
    query: {
      select: "session_id,email,attendee_role,invite_status,google_response_status",
      session_id: `eq.${session.id}`,
    },
    fetchImpl,
  });
  return { session, attendees: attendees || [] };
}

async function waitForSmokeSession({ timeoutMs = 90000, pollMs = 5000, ...rest } = {}) {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const row = await fetchSmokeSession(rest);
    if (row) return { ...row, attempts, elapsed_ms: Date.now() - started };
    await sleep(pollMs);
  }
  return { session: null, attendees: [], attempts, elapsed_ms: Date.now() - started };
}

function evaluateSmokeEvidence({ googleEvent, supabaseRow, botEmail = DEFAULT_BOT_EMAIL } = {}) {
  const session = supabaseRow?.session || null;
  const attendees = supabaseRow?.attendees || [];
  const bot = String(botEmail || DEFAULT_BOT_EMAIL).trim().toLowerCase();
  const googleVideo = googleEvent?.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri || null;
  const attendeeEmails = attendees.map((attendee) => String(attendee.email || "").trim().toLowerCase());
  const evidence = {
    google_event_created: !!googleEvent?.id,
    google_event_id: googleEvent?.id || null,
    google_has_meet: !!(googleEvent?.hangoutLink || googleVideo),
    google_guest_edit_locked: googleEvent?.guestsCanModify !== true && googleEvent?.guestsCanInviteOthers !== true,
    google_bot_attendee: (googleEvent?.attendees || []).some((attendee) => String(attendee.email || "").trim().toLowerCase() === bot),
    supabase_session_seen: !!session,
    supabase_has_meet: !!(session?.google_meet_url || session?.google_meeting_code),
    supabase_guest_edit_locked: !!session && session.guests_can_modify !== true && session.guests_can_invite_others !== true,
    supabase_bot_attendee: attendeeEmails.includes(bot) || attendees.some((attendee) => attendee.attendee_role === "bot" && String(attendee.email || "").trim().toLowerCase() === bot),
  };
  evidence.ok = evidence.google_event_created
    && evidence.google_has_meet
    && evidence.google_guest_edit_locked
    && evidence.google_bot_attendee
    && evidence.supabase_session_seen
    && evidence.supabase_has_meet
    && evidence.supabase_guest_edit_locked
    && evidence.supabase_bot_attendee;
  return evidence;
}

async function deleteSupabaseSmokeRows({ supabaseUrl, serviceRoleKey, sessionId, fetchImpl = fetch } = {}) {
  if (!sessionId) return { attendees_deleted: 0, sessions_deleted: 0 };
  const attendees = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "session_attendees",
    method: "DELETE",
    query: { session_id: `eq.${sessionId}` },
    fetchImpl,
  });
  const sessions = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    method: "DELETE",
    query: { id: `eq.${sessionId}` },
    fetchImpl,
  });
  return {
    attendees_deleted: Array.isArray(attendees) ? attendees.length : 0,
    sessions_deleted: Array.isArray(sessions) ? sessions.length : 0,
  };
}

async function runCalendarSupabaseSmoke({
  env = process.env,
  calendarId = env.GOOGLE_CALENDAR_ID,
  supabaseUrl = env.SUPABASE_URL || env.SHAPE_SUPABASE_URL,
  serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY,
  botEmail = env.SHAPE_CALENDAR_BOT_EMAIL || DEFAULT_BOT_EMAIL,
  timeoutMs = 90000,
  pollMs = 5000,
  keep = false,
  fetchImpl = fetch,
} = {}) {
  const accessToken = await resolveGoogleAccessToken(env, fetchImpl);
  const session = buildSmokeSession();
  const payload = buildGoogleCalendarEvent({
    session,
    attendees: [],
    policy: loadRoutingPolicy(),
    botEmail,
    requestMeet: true,
  });
  let googleEvent = null;
  let cleanup = {};
  try {
    googleEvent = await insertGoogleEvent({
      calendarId: required(calendarId, "calendarId"),
      accessToken,
      payload,
      fetchImpl,
    });
    const supabaseRow = await waitForSmokeSession({
      supabaseUrl: required(supabaseUrl, "supabaseUrl"),
      serviceRoleKey: required(serviceRoleKey, "serviceRoleKey"),
      sessionId: session.id,
      timeoutMs,
      pollMs,
      fetchImpl,
    });
    const evidence = evaluateSmokeEvidence({ googleEvent, supabaseRow, botEmail });
    return {
      ok: evidence.ok,
      kept: !!keep,
      smoke_session_id: session.id,
      evidence,
      supabase_poll: {
        attempts: supabaseRow.attempts,
        elapsed_ms: supabaseRow.elapsed_ms,
      },
      cleanup,
    };
  } finally {
    if (!keep) {
      if (googleEvent?.id) {
        cleanup.google_event_deleted = await deleteGoogleEvent({
          calendarId,
          accessToken,
          eventId: googleEvent.id,
          fetchImpl,
        }).catch((error) => {
          cleanup.google_delete_error = error.message;
          return false;
        });
      }
      cleanup.supabase = await deleteSupabaseSmokeRows({
        supabaseUrl,
        serviceRoleKey,
        sessionId: session.id,
        fetchImpl,
      }).catch((error) => ({ error: error.message }));
    }
  }
}

function formatSmoke(result) {
  const lines = [
    "Calendar Supabase sync smoke",
    `- Result: ${result.ok ? "pass" : "fail"}`,
    `- Smoke session: ${result.smoke_session_id}`,
    `- Google event: ${result.evidence.google_event_id || "not created"}`,
    `- Google Meet present: ${result.evidence.google_has_meet}`,
    `- Google Cube attendee: ${result.evidence.google_bot_attendee}`,
    `- Google guest edit locked: ${result.evidence.google_guest_edit_locked}`,
    `- Supabase session seen: ${result.evidence.supabase_session_seen}`,
    `- Supabase Meet copied: ${result.evidence.supabase_has_meet}`,
    `- Supabase Cube attendee copied: ${result.evidence.supabase_bot_attendee}`,
    `- Supabase guest edit locked: ${result.evidence.supabase_guest_edit_locked}`,
    `- Poll attempts: ${result.supabase_poll.attempts}`,
    `- Cleanup: ${result.kept ? "kept" : JSON.stringify(result.cleanup)}`,
  ];
  return lines.join("\n");
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const result = await runCalendarSupabaseSmoke({
    timeoutMs: Number(arg("--timeout-ms", argv) || 90000),
    pollMs: Number(arg("--poll-ms", argv) || 5000),
    keep: flag("--keep", argv),
  });
  if (flag("--json", argv)) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatSmoke(result) + "\n");
  }
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildSmokeSession,
  evaluateSmokeEvidence,
  formatSmoke,
  runCalendarSupabaseSmoke,
};

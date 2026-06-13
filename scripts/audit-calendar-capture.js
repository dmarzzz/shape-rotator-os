#!/usr/bin/env node
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");

const DEFAULT_BOT_EMAIL = "cube@shaperotator.xyz";
const TRANSCRIPT_SOURCE_KINDS = new Set([
  "meet_transcript",
  "meet_smart_notes",
  "otter_transcript",
  "otter_summary",
  "manual_upload",
  "drive_doc",
]);
const TRANSCRIPT_CAPTURE_KINDS = new Set([
  "transcript",
  "smart_notes",
  "summary",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/audit-calendar-capture.js --env-file .env.calendar.local",
    "",
    "Options:",
    "  --org-id ORG_ID",
    "  --calendar-connection-id CONNECTION_ID",
    "  --bot-email cube@shaperotator.xyz",
    "  --supabase-url URL",
    "  --service-role-key KEY",
    "  --strict                        Exit nonzero if timed active events are not capture-ready",
    "  --json                          Print JSON only",
    "",
    "Environment fallbacks:",
    "  ORG_ID",
    "  CALENDAR_CONNECTION_ID",
    "  SHAPE_CALENDAR_BOT_EMAIL",
    "  SHAPE_SUPABASE_URL or SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function lowerEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isTimedSession(session) {
  const startsAt = String(session?.starts_at || "");
  const endsAt = String(session?.ends_at || "");
  if (!(startsAt.includes("T") && endsAt.includes("T"))) return false;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return true;
  const wholeDayMs = 24 * 60 * 60 * 1000;
  const duration = end.getTime() - start.getTime();
  const startsAtMidnight = start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0;
  const endsAtMidnight = end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0;
  if (startsAtMidnight && endsAtMidnight && duration >= wholeDayMs && duration % wholeDayMs === 0) return false;
  return true;
}

function isFutureSession(session, now = new Date()) {
  const value = new Date(session?.starts_at || "");
  return Number.isFinite(value.getTime()) && value >= now;
}

function hasTranscriptCaptureArtifact(artifact) {
  return TRANSCRIPT_CAPTURE_KINDS.has(String(artifact?.artifact_kind || "").trim().toLowerCase());
}

function hasTranscriptSourceArtifact(artifact) {
  return TRANSCRIPT_SOURCE_KINDS.has(String(artifact?.source_kind || "").trim().toLowerCase());
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function sessionTitle(session) {
  return session?.public_title || session?.title || session?.id || "Untitled session";
}

function classifySession(session, { attendees = [], captureArtifacts = [], sourceArtifacts = [], botEmail, now = new Date() } = {}) {
  const bot = lowerEmail(botEmail || DEFAULT_BOT_EMAIL);
  const active = session?.status !== "cancelled";
  const timed = isTimedSession(session);
  const future = isFutureSession(session, now);
  const attendeeEmails = attendees.map((row) => lowerEmail(row.email));
  const botAttendee = attendeeEmails.includes(bot) || attendees.some((row) => row.attendee_role === "bot" && lowerEmail(row.email) === bot);
  const botOrganizer = lowerEmail(session?.google_calendar_id) === bot || lowerEmail(session?.organizer_email) === bot;
  const botCovered = botAttendee || botOrganizer;
  const hasMeet = !!(session?.google_meet_url || session?.google_meeting_code);
  const guestEditLocked = session?.guests_can_modify !== true && session?.guests_can_invite_others !== true;
  const transcriptArtifactObserved = captureArtifacts.some(hasTranscriptCaptureArtifact) || sourceArtifacts.some(hasTranscriptSourceArtifact);
  const captureReady = active && timed && hasMeet && botCovered && guestEditLocked;
  const needsCapture = active && timed && future;
  const issues = [];
  if (needsCapture && !hasMeet) issues.push("missing_meet");
  if (needsCapture && !botCovered) issues.push("missing_capture_bot");
  if (active && (session?.guests_can_modify === true || session?.guests_can_invite_others === true)) issues.push("guest_editable");
  if (active && timed && !future && !transcriptArtifactObserved) issues.push("past_timed_no_transcript_artifact");
  return {
    id: session?.id || null,
    title: sessionTitle(session),
    starts_at: session?.starts_at || null,
    session_type: session?.session_type || null,
    status: session?.status || null,
    timed,
    future,
    needs_capture: needsCapture,
    has_meet: hasMeet,
    bot_covered: botCovered,
    bot_attendee: botAttendee,
    bot_organizer: botOrganizer,
    guest_edit_locked: guestEditLocked,
    transcript_artifact_observed: transcriptArtifactObserved,
    capture_ready: captureReady,
    issues,
  };
}

function buildCaptureAudit({ sessions = [], attendees = [], captureArtifacts = [], sourceArtifacts = [], botEmail = DEFAULT_BOT_EMAIL, now = new Date() } = {}) {
  const activeSessions = sessions.filter((session) => session.status !== "cancelled");
  const attendeesBySession = groupBy(attendees, (row) => row.session_id);
  const captureArtifactsBySession = groupBy(captureArtifacts, (row) => row.session_id);
  const sourceArtifactsBySession = groupBy(sourceArtifacts, (row) => row.session_id);
  const sessionResults = activeSessions.map((session) => classifySession(session, {
    attendees: attendeesBySession.get(session.id) || [],
    captureArtifacts: captureArtifactsBySession.get(session.id) || [],
    sourceArtifacts: sourceArtifactsBySession.get(session.id) || [],
    botEmail,
    now,
  }));
  const timed = sessionResults.filter((item) => item.timed);
  const futureTimed = timed.filter((item) => item.future);
  const needsCapture = sessionResults.filter((item) => item.needs_capture);
  const issueCounts = {};
  for (const item of sessionResults) {
    for (const issue of item.issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;
  }
  return {
    bot_email: lowerEmail(botEmail || DEFAULT_BOT_EMAIL),
    generated_at: new Date().toISOString(),
    counts: {
      sessions_total: sessions.length,
      active_sessions: activeSessions.length,
      timed_active_sessions: timed.length,
      future_timed_sessions: futureTimed.length,
      capture_ready_future_timed_sessions: needsCapture.filter((item) => item.capture_ready).length,
      missing_meet_future_timed_sessions: needsCapture.filter((item) => !item.has_meet).length,
      missing_bot_future_timed_sessions: needsCapture.filter((item) => !item.bot_covered).length,
      guest_edit_violations: sessionResults.filter((item) => !item.guest_edit_locked).length,
      sessions_with_transcript_artifacts: sessionResults.filter((item) => item.transcript_artifact_observed).length,
      issue_counts: issueCounts,
    },
    failures: sessionResults.filter((item) => item.issues.length),
    sessions: sessionResults,
  };
}

function formatAudit(audit) {
  const lines = [
    "Calendar capture audit",
    `- Bot email: ${audit.bot_email}`,
    `- Active sessions: ${audit.counts.active_sessions}`,
    `- Timed active sessions: ${audit.counts.timed_active_sessions}`,
    `- Future timed sessions: ${audit.counts.future_timed_sessions}`,
    `- Future timed capture-ready: ${audit.counts.capture_ready_future_timed_sessions}`,
    `- Missing Meet on future timed sessions: ${audit.counts.missing_meet_future_timed_sessions}`,
    `- Missing bot on future timed sessions: ${audit.counts.missing_bot_future_timed_sessions}`,
    `- Guest-edit violations: ${audit.counts.guest_edit_violations}`,
    `- Sessions with observed transcript/source artifacts: ${audit.counts.sessions_with_transcript_artifacts}`,
  ];
  if (audit.failures.length) {
    lines.push("", "Failures / gaps:");
    for (const item of audit.failures.slice(0, 25)) {
      lines.push(`- ${item.title} (${item.starts_at || "no start"}): ${item.issues.join(", ")}`);
    }
    if (audit.failures.length > 25) lines.push(`- ... ${audit.failures.length - 25} more`);
  }
  return lines.join("\n");
}

async function fetchRows({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId, fetchImpl = fetch } = {}) {
  if (!supabaseUrl) throw new Error("supabaseUrl is required");
  if (!serviceRoleKey) throw new Error("serviceRoleKey is required");
  if (!orgId) throw new Error("orgId is required");
  const sessionQuery = {
    select: "id,title,public_title,status,starts_at,ends_at,timezone,session_type,calendar_connection_id,google_calendar_id,google_event_id,google_meet_url,google_meeting_code,guests_can_modify,guests_can_invite_others,transcript_status,bot_status",
    org_id: `eq.${orgId}`,
    order: "starts_at.asc",
  };
  if (calendarConnectionId) sessionQuery.calendar_connection_id = `eq.${calendarConnectionId}`;
  const [sessions, attendees, captureArtifacts, sourceArtifacts] = await Promise.all([
    supabaseServiceRequest({ supabaseUrl, serviceRoleKey, table: "sessions", query: sessionQuery, fetchImpl }),
    supabaseServiceRequest({
      supabaseUrl,
      serviceRoleKey,
      table: "session_attendees",
      query: {
        select: "session_id,email,attendee_role,invite_status,google_response_status",
        org_id: `eq.${orgId}`,
      },
      fetchImpl,
    }),
    supabaseServiceRequest({
      supabaseUrl,
      serviceRoleKey,
      table: "capture_artifacts",
      query: {
        select: "id,session_id,provider,artifact_kind,status,storage_ref,drive_file_id",
        org_id: `eq.${orgId}`,
      },
      fetchImpl,
    }),
    supabaseServiceRequest({
      supabaseUrl,
      serviceRoleKey,
      table: "source_artifacts",
      query: {
        select: "id,session_id,source_kind,storage_mode,storage_ref,raw_available_to_server",
        org_id: `eq.${orgId}`,
      },
      fetchImpl,
    }),
  ]);
  const sessionIds = new Set((sessions || []).map((session) => session.id));
  return {
    sessions: sessions || [],
    attendees: (attendees || []).filter((row) => sessionIds.has(row.session_id)),
    captureArtifacts: (captureArtifacts || []).filter((row) => sessionIds.has(row.session_id)),
    sourceArtifacts: (sourceArtifacts || []).filter((row) => sessionIds.has(row.session_id)),
  };
}

async function runAudit({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  botEmail = DEFAULT_BOT_EMAIL,
  fetchImpl = fetch,
} = {}) {
  const rows = await fetchRows({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    calendarConnectionId,
    fetchImpl,
  });
  return buildCaptureAudit({ ...rows, botEmail });
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const audit = await runAudit({
    supabaseUrl: arg("--supabase-url", argv) || process.env.SHAPE_SUPABASE_URL || process.env.SUPABASE_URL,
    serviceRoleKey: arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY,
    orgId: arg("--org-id", argv) || process.env.ORG_ID,
    calendarConnectionId: arg("--calendar-connection-id", argv) || process.env.CALENDAR_CONNECTION_ID,
    botEmail: arg("--bot-email", argv) || process.env.SHAPE_CALENDAR_BOT_EMAIL || DEFAULT_BOT_EMAIL,
  });
  if (flag("--json", argv)) {
    process.stdout.write(JSON.stringify(audit, null, 2) + "\n");
  } else {
    process.stdout.write(formatAudit(audit) + "\n");
  }
  if (flag("--strict", argv) && (
    audit.counts.missing_meet_future_timed_sessions
    || audit.counts.missing_bot_future_timed_sessions
    || audit.counts.guest_edit_violations
  )) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_BOT_EMAIL,
  isTimedSession,
  classifySession,
  buildCaptureAudit,
  formatAudit,
  runAudit,
};

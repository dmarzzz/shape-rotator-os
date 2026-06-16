#!/usr/bin/env node
const { loadEnvFile } = require("./lib/env-file.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");
const {
  eventVideoUri,
  fetchGoogleCalendarEvents,
  isAllDayEvent,
  isTimedEvent,
} = require("./ensure-google-calendar-meet-links.js");
const {
  MEET_SETTINGS_SCOPE,
  buildMeetAutoArtifactPatch,
  hasMeetSettingsScope,
  meetingCodeFromInput,
  runMeetAutoArtifactConfig,
} = require("./configure-meet-auto-artifacts.js");

const DEFAULT_MAX_RESULTS = 2500;

function usage() {
  return [
    "Usage:",
    "  node scripts/ensure-google-calendar-meet-auto-artifacts.js --calendar-id CALENDAR_ID --apply",
    "  node scripts/ensure-google-calendar-meet-auto-artifacts.js --events google-events.json",
    "",
    "Options:",
    "  --apply                         Patch selected Google Meet spaces. Default is dry-run.",
    "  --dry-run                       Print the plan without writing. This is the default.",
    "  --calendar-id ID                Google Calendar ID.",
    "  --access-token TOKEN            OAuth token with Meet settings access.",
    "  --events FILE                   Read a saved Google events.list payload instead of live Google.",
    "  --time-min ISO_DATETIME         Optional events.list lower bound. Defaults to now for live reads.",
    "  --time-max ISO_DATETIME         Optional events.list upper bound.",
    "  --max-results N                 Google Calendar page size, default 2500.",
    "  --max-events N                  Patch at most N selected events.",
    "  --include-all-day               Also patch future all-day events. Default: timed events only.",
    "  --transcript / --no-transcript  Default: transcript ON.",
    "  --recording / --no-recording    Default: recording OFF.",
    "  --smart-notes / --no-smart-notes",
    "  --fail-on-error                 Exit non-zero if any selected Meet space cannot be patched.",
    "  --skip-if-missing-scope         Exit cleanly if GOOGLE_OAUTH_SCOPES lacks Meet settings scope.",
    "  --env-file FILE                 Load local KEY=value secrets before env fallbacks.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID",
    "  GOOGLE_OAUTH_CLIENT_SECRET",
    "  GOOGLE_OAUTH_REFRESH_TOKEN",
    "  GOOGLE_OAUTH_SCOPES",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function numberArg(name, fallback, argv = process.argv) {
  const value = arg(name, argv);
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function boolOption({ argv = process.argv, yes, no, fallback }) {
  if (flag(no, argv)) return false;
  if (flag(yes, argv)) return true;
  return fallback;
}

function readJson(filePath) {
  const fs = require("node:fs");
  const path = require("node:path");
  if (filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function normalizeEventsPayload(payload) {
  return Array.isArray(payload)
    ? { items: payload }
    : { items: payload?.items || payload?.events || [] };
}

function isCancelled(event) {
  return event?.status === "cancelled";
}

function eventStartMs(event) {
  const value = event?.start?.dateTime || event?.start?.date || "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : NaN;
}

function isFutureEvent(event, now = new Date()) {
  const startMs = eventStartMs(event);
  return Number.isFinite(startMs) && startMs >= now.getTime();
}

function eventMeetUrl(event) {
  return event?.hangoutLink || eventVideoUri(event);
}

function meetingCodeForEvent(event) {
  try {
    return meetingCodeFromInput({ meetUrl: eventMeetUrl(event) });
  } catch {
    return null;
  }
}

function summarizeEvent(event) {
  return {
    google_event_id: event?.id || null,
    title: event?.summary || null,
    start: event?.start?.dateTime || event?.start?.date || null,
    time_kind: isTimedEvent(event) ? "timed" : isAllDayEvent(event) ? "all_day" : "unknown",
    meet_url: eventMeetUrl(event) || null,
    meeting_code: meetingCodeForEvent(event),
  };
}

function isConfigurableEvent(event, { now = new Date(), includeAllDay = false } = {}) {
  if (!event?.id) return false;
  if (isCancelled(event)) return false;
  if (!isFutureEvent(event, now)) return false;
  if (!(isTimedEvent(event) || (includeAllDay && isAllDayEvent(event)))) return false;
  return !!meetingCodeForEvent(event);
}

function buildMeetAutoArtifactCalendarPlan(events, {
  now = new Date(),
  includeAllDay = false,
  maxEvents,
  recording = false,
  transcript = true,
  smartNotes = null,
} = {}) {
  const items = Array.isArray(events) ? events : [];
  const patch = buildMeetAutoArtifactPatch({ recording, transcript, smartNotes });
  const selectedEvents = items
    .filter((event) => isConfigurableEvent(event, { now, includeAllDay }))
    .slice(0, maxEvents || items.length);
  const futureEvents = items.filter((event) => !isCancelled(event) && isFutureEvent(event, now));
  const counts = {
    total_events: items.length,
    future_events: futureEvents.length,
    future_timed_events: futureEvents.filter(isTimedEvent).length,
    future_all_day_events: futureEvents.filter(isAllDayEvent).length,
    future_events_with_meet: futureEvents.filter((event) => !!eventMeetUrl(event)).length,
    future_events_with_meeting_code: futureEvents.filter((event) => !!meetingCodeForEvent(event)).length,
    selected_for_patch: selectedEvents.length,
    skipped_all_day_with_meet: includeAllDay ? 0 : futureEvents.filter((event) => isAllDayEvent(event) && !!meetingCodeForEvent(event)).length,
  };
  return {
    counts,
    selected: selectedEvents,
    request_body: patch.body,
    update_mask: patch.updateMask,
    actions: selectedEvents.map((event) => ({
      action: "would_configure",
      ...summarizeEvent(event),
      transcript_on: transcript !== false,
      recording_on: recording === true,
      smart_notes_on: smartNotes === true,
    })),
  };
}

async function resolveAccessToken({
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  if (clientId && clientSecret && refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    if (token?.access_token) return { accessToken: token.access_token, source: "refresh_token", refreshed: true };
  }
  if (accessToken) return { accessToken, source: "argument_or_env", refreshed: false };
  throw new Error("Google access token or refresh credentials are required");
}

async function runEnsureGoogleCalendarMeetAutoArtifacts({
  events,
  calendarId,
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  oauthScopes,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
  maxEvents,
  includeAllDay = false,
  recording = false,
  transcript = true,
  smartNotes = null,
  apply = false,
  failOnError = false,
  skipIfMissingScope = false,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const scopes = oauthScopes ?? env.GOOGLE_OAUTH_SCOPES ?? "";
  if (apply && !hasMeetSettingsScope(scopes)) {
    const skipped = {
      calendar_id: calendarId || null,
      apply: !!apply,
      configured: 0,
      failed: 0,
      skipped: true,
      reason: `missing ${MEET_SETTINGS_SCOPE}`,
      actions: [],
    };
    if (skipIfMissingScope) return skipped;
    throw new Error(`${MEET_SETTINGS_SCOPE} is missing from GOOGLE_OAUTH_SCOPES; re-consent Cube before applying Meet auto artifacts`);
  }

  let payload = null;
  let tokenInfo = { accessToken, source: accessToken ? "argument_or_env" : "fixture", refreshed: false };
  const effectiveTimeMin = events ? timeMin : (timeMin || now.toISOString());
  if (events) {
    payload = normalizeEventsPayload(events);
  } else {
    tokenInfo = await resolveAccessToken({
      accessToken,
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    payload = await fetchGoogleCalendarEvents({
      calendarId,
      accessToken: tokenInfo.accessToken,
      timeMin: effectiveTimeMin,
      timeMax,
      maxResults,
      fetchImpl,
    });
  }

  const plan = buildMeetAutoArtifactCalendarPlan(payload.items, {
    now,
    includeAllDay,
    maxEvents,
    recording,
    transcript,
    smartNotes,
  });
  const result = {
    calendar_id: calendarId || null,
    apply: !!apply,
    access_token_source: tokenInfo.source,
    refreshed_access_token: !!tokenInfo.refreshed,
    time_min: effectiveTimeMin || null,
    time_max: timeMax || null,
    include_all_day: !!includeAllDay,
    ...plan.counts,
    configured: 0,
    failed: 0,
    actions: plan.actions,
  };
  if (!apply) return result;

  result.actions = [];
  for (const event of plan.selected) {
    const eventSummary = summarizeEvent(event);
    try {
      const configured = await runMeetAutoArtifactConfig({
        meetingCode: eventSummary.meeting_code,
        accessToken: tokenInfo.accessToken,
        recording,
        transcript,
        smartNotes,
        apply: true,
        env: { ...env, GOOGLE_OAUTH_SCOPES: scopes },
        fetchImpl,
      });
      result.configured += 1;
      result.actions.push({
        action: "configured",
        ...eventSummary,
        space_name: configured.space?.name || configured.patched?.name || null,
        artifact_config: configured.patched?.config?.artifactConfig || null,
      });
    } catch (error) {
      result.failed += 1;
      result.actions.push({
        action: "failed",
        ...eventSummary,
        error: error?.body?.error?.message || error?.message || String(error),
      });
    }
  }

  if (failOnError && result.failed > 0) {
    const error = new Error(`failed to configure Meet auto artifacts for ${result.failed} event(s)`);
    error.result = result;
    throw error;
  }
  return result;
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const eventsPath = arg("--events", argv);
  const result = await runEnsureGoogleCalendarMeetAutoArtifacts({
    events: eventsPath ? readJson(eventsPath) : null,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    oauthScopes: process.env.GOOGLE_OAUTH_SCOPES,
    timeMin: arg("--time-min", argv),
    timeMax: arg("--time-max", argv),
    maxResults: numberArg("--max-results", DEFAULT_MAX_RESULTS, argv),
    maxEvents: numberArg("--max-events", null, argv),
    includeAllDay: flag("--include-all-day", argv),
    recording: boolOption({ argv, yes: "--recording", no: "--no-recording", fallback: false }),
    transcript: boolOption({ argv, yes: "--transcript", no: "--no-transcript", fallback: true }),
    smartNotes: boolOption({ argv, yes: "--smart-notes", no: "--no-smart-notes", fallback: null }),
    apply: flag("--apply", argv) && !flag("--dry-run", argv),
    failOnError: flag("--fail-on-error", argv),
    skipIfMissingScope: flag("--skip-if-missing-scope", argv),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    if (error?.result) console.error(JSON.stringify(error.result, null, 2));
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  buildMeetAutoArtifactCalendarPlan,
  eventMeetUrl,
  isConfigurableEvent,
  meetingCodeForEvent,
  runEnsureGoogleCalendarMeetAutoArtifacts,
};

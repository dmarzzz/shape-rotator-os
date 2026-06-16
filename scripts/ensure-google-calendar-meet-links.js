#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./lib/env-file.cjs");
const {
  runMeetAutoArtifactConfig,
} = require("./configure-meet-auto-artifacts.js");
const {
  refreshAccessToken,
  updateEnvFile,
} = require("./google-calendar-oauth.js");

const DEFAULT_MAX_RESULTS = 2500;

function usage() {
  return [
    "Usage:",
    "  node scripts/ensure-google-calendar-meet-links.js --calendar-id CALENDAR_ID --access-token TOKEN",
    "  node scripts/ensure-google-calendar-meet-links.js --env-file .env.calendar.local --apply",
    "  node scripts/ensure-google-calendar-meet-links.js --events google-events.json",
    "",
    "Options:",
    "  --apply                         Patch missing Google Meet links. Default is dry-run.",
    "  --dry-run                       Print the plan without writing. This is the default.",
    "  --calendar-id ID                Google Calendar ID.",
    "  --access-token TOKEN            OAuth token with Calendar event write access.",
    "  --events FILE                   Read a saved Google events.list payload instead of live Google.",
    "  --time-min ISO_DATETIME         Optional events.list lower bound.",
    "  --time-max ISO_DATETIME         Optional events.list upper bound.",
    "  --max-results N                 Google page size, default 2500.",
    "  --max-events N                  Patch at most N missing events.",
    "  --include-all-day               Also patch all-day events. Default: timed events only.",
    "  --configure-transcripts         Also set future timed Meet spaces to auto-transcript ON.",
    "  --now ISO_DATETIME              Clock for future-event transcript selection.",
    "  --env-file FILE                 Load local KEY=value secrets before env fallbacks.",
    "  --update-env-file FILE          Persist refreshed access token without printing it.",
    "  --no-refresh                    Do not refresh GOOGLE_OAUTH_REFRESH_TOKEN first.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID",
    "  GOOGLE_OAUTH_CLIENT_SECRET",
    "  GOOGLE_OAUTH_REFRESH_TOKEN",
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

function readJson(filePath) {
  if (filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function normalizeEventsPayload(payload) {
  return Array.isArray(payload)
    ? { items: payload, nextSyncToken: null }
    : { items: payload?.items || payload?.events || [], nextSyncToken: payload?.nextSyncToken || null };
}

function googleEventsListUrl({
  calendarId,
  pageToken,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "false");
  if (timeMin) url.searchParams.set("timeMin", timeMin);
  if (timeMax) url.searchParams.set("timeMax", timeMax);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

function googleEventPatchUrl(calendarId, eventId) {
  if (!calendarId) throw new Error("calendarId is required");
  if (!eventId) throw new Error("eventId is required");
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  url.searchParams.set("conferenceDataVersion", "1");
  url.searchParams.set("sendUpdates", "none");
  return url;
}

async function googleRequestJson({ url, accessToken, method = "GET", body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Calendar events.${method === "PATCH" ? "patch" : "list"} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function fetchGoogleCalendarEvents({
  calendarId,
  accessToken,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
  fetchImpl = fetch,
} = {}) {
  if (!calendarId || !accessToken) throw new Error("calendarId and accessToken are required for live calendar reads");
  const items = [];
  let pageToken = null;
  do {
    const url = googleEventsListUrl({ calendarId, pageToken, timeMin, timeMax, maxResults });
    const data = await googleRequestJson({ url, accessToken, fetchImpl });
    items.push(...(data?.items || []));
    pageToken = data?.nextPageToken || null;
  } while (pageToken);
  return { items };
}

function eventVideoUri(event) {
  return event?.conferenceData?.entryPoints?.find((entry) => entry?.entryPointType === "video")?.uri || null;
}

function hasGoogleMeet(event) {
  return !!(event?.hangoutLink || eventVideoUri(event));
}

function isAllDayEvent(event) {
  return !!((event?.start?.date || event?.end?.date) && !(event?.start?.dateTime || event?.end?.dateTime));
}

function isTimedEvent(event) {
  return !!(event?.start?.dateTime && event?.end?.dateTime);
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

function isPatchableEvent(event, { includeAllDay = false } = {}) {
  if (!event?.id) return false;
  if (isCancelled(event)) return false;
  if (hasGoogleMeet(event)) return false;
  if (isTimedEvent(event)) return true;
  if (includeAllDay && isAllDayEvent(event)) return true;
  return false;
}

function stableConferenceRequestId(event, { prefix = "shape-meet" } = {}) {
  const seed = [
    event?.id,
    event?.iCalUID || event?.icalUID,
    event?.summary,
    event?.start?.dateTime || event?.start?.date,
  ].filter(Boolean).join(":");
  const digest = crypto.createHash("sha1").update(seed || String(Date.now())).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function buildMeetPatchBody(event, options = {}) {
  return {
    conferenceData: {
      createRequest: {
        requestId: stableConferenceRequestId(event, options),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
}

function summarizeEvent(event) {
  return {
    google_event_id: event?.id || null,
    title: event?.summary || null,
    start: event?.start?.dateTime || event?.start?.date || null,
    time_kind: isTimedEvent(event) ? "timed" : isAllDayEvent(event) ? "all_day" : "unknown",
    has_meet: hasGoogleMeet(event),
  };
}

function eventMeetUrl(event) {
  return event?.hangoutLink || eventVideoUri(event) || null;
}

function transcriptConfigurableEvent(event, { includeAllDay = false, now = new Date() } = {}) {
  if (!event?.id) return false;
  if (isCancelled(event)) return false;
  if (!isFutureEvent(event, now)) return false;
  if (!(isTimedEvent(event) || (includeAllDay && isAllDayEvent(event)))) return false;
  return !!eventMeetUrl(event);
}

function buildTranscriptConfigPlan(events, { includeAllDay = false, now = new Date(), maxEvents } = {}) {
  const items = Array.isArray(events) ? events : [];
  const configurable = items.filter((event) => transcriptConfigurableEvent(event, { includeAllDay, now }));
  const selected = maxEvents ? configurable.slice(0, maxEvents) : configurable;
  const futureTimed = items.filter((event) => !isCancelled(event) && isFutureEvent(event, now) && isTimedEvent(event));
  return {
    counts: {
      future_timed_events: futureTimed.length,
      future_timed_events_with_meet: futureTimed.filter((event) => !!eventMeetUrl(event)).length,
      future_timed_events_without_meet: futureTimed.filter((event) => !eventMeetUrl(event)).length,
    },
    selected,
    actions: selected.map((event) => ({
      action: "would_configure_transcript",
      ...summarizeEvent(event),
      meet_url: eventMeetUrl(event),
    })),
  };
}

function buildEnsureMeetPlan(events, { includeAllDay = false, maxEvents } = {}) {
  const items = Array.isArray(events) ? events : [];
  const patchable = items.filter((event) => isPatchableEvent(event, { includeAllDay }));
  const limited = maxEvents ? patchable.slice(0, maxEvents) : patchable;
  const counts = {
    total_events: items.length,
    timed_events: items.filter(isTimedEvent).length,
    all_day_events: items.filter(isAllDayEvent).length,
    events_with_meet: items.filter(hasGoogleMeet).length,
    missing_meet_events: items.filter((event) => !isCancelled(event) && !hasGoogleMeet(event)).length,
    missing_meet_timed_events: items.filter((event) => !isCancelled(event) && isTimedEvent(event) && !hasGoogleMeet(event)).length,
    missing_meet_all_day_events: items.filter((event) => !isCancelled(event) && isAllDayEvent(event) && !hasGoogleMeet(event)).length,
    skipped_all_day_missing_meet: includeAllDay ? 0 : items.filter((event) => !isCancelled(event) && isAllDayEvent(event) && !hasGoogleMeet(event)).length,
  };
  return {
    counts,
    patchable,
    selected: limited,
    actions: limited.map((event) => ({
      action: "would_patch",
      ...summarizeEvent(event),
      request_id: stableConferenceRequestId(event),
    })),
  };
}

async function patchGoogleMeetLink({
  calendarId,
  accessToken,
  event,
  fetchImpl = fetch,
} = {}) {
  const body = buildMeetPatchBody(event);
  return googleRequestJson({
    url: googleEventPatchUrl(calendarId, event.id),
    accessToken,
    method: "PATCH",
    body,
    fetchImpl,
  });
}

async function resolveAccessToken({
  accessToken,
  refresh = true,
  clientId,
  clientSecret,
  refreshToken,
  updateEnvFilePath,
  fetchImpl = fetch,
} = {}) {
  if (refresh && clientId && clientSecret && refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    if (updateEnvFilePath) updateEnvFile(updateEnvFilePath, token);
    return { accessToken: token.access_token, source: "refresh_token", refreshed: true };
  }
  if (accessToken) return { accessToken, source: "argument_or_env", refreshed: false };
  return { accessToken: "", source: "missing", refreshed: false };
}

async function runEnsureGoogleCalendarMeetLinks({
  events,
  calendarId,
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  refresh = true,
  updateEnvFilePath,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
  maxEvents,
  includeAllDay = false,
  configureTranscripts = false,
  now = new Date(),
  transcript = true,
  recording = false,
  smartNotes = null,
  env = process.env,
  apply = false,
  fetchImpl = fetch,
} = {}) {
  let tokenInfo = { accessToken, source: accessToken ? "argument_or_env" : "fixture", refreshed: false };
  let payload = null;
  if (events) {
    payload = normalizeEventsPayload(events);
  } else {
    tokenInfo = await resolveAccessToken({
      accessToken,
      refresh,
      clientId,
      clientSecret,
      refreshToken,
      updateEnvFilePath,
      fetchImpl,
    });
    payload = await fetchGoogleCalendarEvents({
      calendarId,
      accessToken: tokenInfo.accessToken,
      timeMin,
      timeMax,
      maxResults,
      fetchImpl,
    });
  }

  const plan = buildEnsureMeetPlan(payload.items, { includeAllDay, maxEvents });
  const result = {
    calendar_id: calendarId || null,
    apply: !!apply,
    include_all_day: !!includeAllDay,
    access_token_source: tokenInfo.source,
    refreshed_access_token: !!tokenInfo.refreshed,
    ...plan.counts,
    selected_for_patch: plan.selected.length,
    patched: 0,
    failed: 0,
    actions: plan.actions,
    transcript_selected_for_config: 0,
    transcripts_configured: 0,
    transcripts_failed: 0,
    transcript_actions: [],
  };

  if (!apply) {
    if (configureTranscripts) {
      const transcriptPlan = buildTranscriptConfigPlan(payload.items, { includeAllDay, now, maxEvents });
      result.transcript_selected_for_config = transcriptPlan.selected.length;
      result.transcript_actions = transcriptPlan.actions;
      Object.assign(result, transcriptPlan.counts);
    }
    return result;
  }
  if (!calendarId || !tokenInfo.accessToken) throw new Error("--apply requires calendarId and an access token");

  result.actions = [];
  const eventsAfterMeetPatch = [...payload.items];
  for (const event of plan.selected) {
    try {
      const patched = await patchGoogleMeetLink({
        calendarId,
        accessToken: tokenInfo.accessToken,
        event,
        fetchImpl,
      });
      result.patched += 1;
      result.actions.push({
        action: "patched",
        ...summarizeEvent(patched || event),
        request_id: stableConferenceRequestId(event),
        meet_url: patched?.hangoutLink || eventVideoUri(patched) || null,
      });
      const idx = eventsAfterMeetPatch.findIndex((item) => item?.id === event.id);
      if (idx >= 0) eventsAfterMeetPatch[idx] = patched || event;
    } catch (error) {
      result.failed += 1;
      result.actions.push({
        action: "failed",
        ...summarizeEvent(event),
        request_id: stableConferenceRequestId(event),
        error: error?.body?.error?.message || error?.message || String(error),
      });
    }
  }

  if (configureTranscripts) {
    const transcriptPlan = buildTranscriptConfigPlan(eventsAfterMeetPatch, { includeAllDay, now, maxEvents });
    result.transcript_selected_for_config = transcriptPlan.selected.length;
    result.transcript_actions = [];
    Object.assign(result, transcriptPlan.counts);
    for (const event of transcriptPlan.selected) {
      const meetUrl = eventMeetUrl(event);
      try {
        const configured = await runMeetAutoArtifactConfig({
          meetUrl,
          accessToken: tokenInfo.accessToken,
          recording,
          transcript,
          smartNotes,
          apply: true,
          env,
          fetchImpl,
        });
        result.transcripts_configured += 1;
        result.transcript_actions.push({
          action: "configured_transcript",
          ...summarizeEvent(event),
          meet_url: meetUrl,
          meeting_code: configured.meeting_code || null,
          update_mask: configured.update_mask || null,
        });
      } catch (error) {
        result.transcripts_failed += 1;
        result.transcript_actions.push({
          action: "transcript_failed",
          ...summarizeEvent(event),
          meet_url: meetUrl,
          error: error?.body?.error?.message || error?.message || String(error),
        });
      }
    }
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
  const nowArg = arg("--now", argv);
  const result = await runEnsureGoogleCalendarMeetLinks({
    events: eventsPath ? readJson(eventsPath) : null,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    refresh: !flag("--no-refresh", argv),
    updateEnvFilePath: arg("--update-env-file", argv),
    timeMin: arg("--time-min", argv),
    timeMax: arg("--time-max", argv),
    maxResults: numberArg("--max-results", DEFAULT_MAX_RESULTS, argv),
    maxEvents: numberArg("--max-events", null, argv),
    includeAllDay: flag("--include-all-day", argv),
    configureTranscripts: flag("--configure-transcripts", argv),
    now: nowArg ? new Date(nowArg) : new Date(),
    apply: flag("--apply", argv) && !flag("--dry-run", argv),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildEnsureMeetPlan,
  buildMeetPatchBody,
  buildTranscriptConfigPlan,
  eventMeetUrl,
  eventVideoUri,
  fetchGoogleCalendarEvents,
  googleEventPatchUrl,
  googleEventsListUrl,
  hasGoogleMeet,
  isAllDayEvent,
  isFutureEvent,
  isPatchableEvent,
  isTimedEvent,
  runEnsureGoogleCalendarMeetLinks,
  stableConferenceRequestId,
};

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./lib/env-file.cjs");
const {
  refreshAccessToken,
  updateEnvFile,
} = require("./google-calendar-oauth.js");

const DEFAULT_MAX_RESULTS = 2500;
const DEFAULT_BOT_EMAIL = "cube@shaperotator.xyz";

function usage() {
  return [
    "Usage:",
    "  node scripts/ensure-google-calendar-capture-bot.js --env-file .env.calendar.local",
    "  node scripts/ensure-google-calendar-capture-bot.js --env-file .env.calendar.local --apply",
    "  node scripts/ensure-google-calendar-capture-bot.js --events google-events.json --bot-email cube@shaperotator.xyz",
    "",
    "Options:",
    "  --apply                         Patch future timed events. Default is dry-run.",
    "  --dry-run                       Print the plan without writing. This is the default.",
    "  --calendar-id ID                Google Calendar ID.",
    "  --access-token TOKEN            OAuth token with Calendar event write access.",
    "  --events FILE                   Read a saved Google events.list payload instead of live Google.",
    "  --bot-email EMAIL               Capture bot attendee. Default: cube@shaperotator.xyz.",
    "  --now ISO_DATETIME              Clock for future-event selection.",
    "  --time-min ISO_DATETIME         Optional events.list lower bound.",
    "  --time-max ISO_DATETIME         Optional events.list upper bound.",
    "  --max-results N                 Google page size, default 2500.",
    "  --max-events N                  Patch at most N selected events.",
    "  --include-all-day               Also patch future all-day events. Default: timed only.",
    "  --env-file FILE                 Load local KEY=value secrets before env fallbacks.",
    "  --update-env-file FILE          Persist refreshed access token without printing it.",
    "  --no-refresh                    Do not refresh GOOGLE_OAUTH_REFRESH_TOKEN first.",
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
    ? { items: payload }
    : { items: payload?.items || payload?.events || [] };
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

function lowerEmail(value) {
  return String(value || "").trim().toLowerCase();
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

function hasAttendee(event, email) {
  const target = lowerEmail(email);
  return (event?.attendees || []).some((attendee) => lowerEmail(attendee?.email) === target);
}

function hasOrganizer(event, email) {
  return lowerEmail(event?.organizer?.email) === lowerEmail(email);
}

function hasBotCoverage(event, botEmail) {
  return hasAttendee(event, botEmail) || hasOrganizer(event, botEmail);
}

function isPatchableEvent(event, { botEmail = DEFAULT_BOT_EMAIL, now = new Date(), includeAllDay = false } = {}) {
  if (!event?.id) return false;
  if (isCancelled(event)) return false;
  if (!isFutureEvent(event, now)) return false;
  if (!(isTimedEvent(event) || (includeAllDay && isAllDayEvent(event)))) return false;
  return !hasBotCoverage(event, botEmail)
    || event.guestsCanModify === true
    || event.guestsCanInviteOthers === true;
}

function eventWithCaptureBotBody(event, { botEmail = DEFAULT_BOT_EMAIL } = {}) {
  const attendees = [...(event?.attendees || [])];
  if (!hasAttendee(event, botEmail) && !hasOrganizer(event, botEmail)) attendees.push({ email: botEmail });
  return {
    attendees,
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: event?.guestsCanSeeOtherGuests !== false,
  };
}

function summarizeEvent(event, { botEmail = DEFAULT_BOT_EMAIL } = {}) {
  return {
    google_event_id: event?.id || null,
    title: event?.summary || null,
    start: event?.start?.dateTime || event?.start?.date || null,
    time_kind: isTimedEvent(event) ? "timed" : isAllDayEvent(event) ? "all_day" : "unknown",
    bot_covered: hasBotCoverage(event, botEmail),
    guests_can_modify: event?.guestsCanModify === true,
    guests_can_invite_others: event?.guestsCanInviteOthers === true,
  };
}

function buildEnsureCaptureBotPlan(events, {
  botEmail = DEFAULT_BOT_EMAIL,
  now = new Date(),
  includeAllDay = false,
  maxEvents,
} = {}) {
  const items = Array.isArray(events) ? events : [];
  const future = items.filter((event) => !isCancelled(event) && isFutureEvent(event, now));
  const futureTimed = future.filter(isTimedEvent);
  const patchable = items.filter((event) => isPatchableEvent(event, { botEmail, now, includeAllDay }));
  const selected = maxEvents ? patchable.slice(0, maxEvents) : patchable;
  return {
    counts: {
      total_events: items.length,
      future_events: future.length,
      future_timed_events: futureTimed.length,
      future_timed_bot_covered: futureTimed.filter((event) => hasBotCoverage(event, botEmail)).length,
      missing_bot_future_timed_events: futureTimed.filter((event) => !hasBotCoverage(event, botEmail)).length,
      guest_edit_future_timed_events: futureTimed.filter((event) => event.guestsCanModify === true || event.guestsCanInviteOthers === true).length,
      skipped_future_all_day_events: includeAllDay ? 0 : future.filter(isAllDayEvent).length,
    },
    selected,
    actions: selected.map((event) => ({
      action: "would_patch",
      ...summarizeEvent(event, { botEmail }),
    })),
  };
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

async function patchCaptureBot({
  calendarId,
  accessToken,
  event,
  botEmail = DEFAULT_BOT_EMAIL,
  fetchImpl = fetch,
} = {}) {
  return googleRequestJson({
    url: googleEventPatchUrl(calendarId, event.id),
    accessToken,
    method: "PATCH",
    body: eventWithCaptureBotBody(event, { botEmail }),
    fetchImpl,
  });
}

async function runEnsureGoogleCalendarCaptureBot({
  events,
  calendarId,
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  refresh = true,
  updateEnvFilePath,
  botEmail = DEFAULT_BOT_EMAIL,
  now = new Date(),
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
  maxEvents,
  includeAllDay = false,
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
  const plan = buildEnsureCaptureBotPlan(payload.items, {
    botEmail,
    now,
    includeAllDay,
    maxEvents,
  });
  const result = {
    calendar_id: calendarId || null,
    apply: !!apply,
    include_all_day: !!includeAllDay,
    bot_email: lowerEmail(botEmail),
    access_token_source: tokenInfo.source,
    refreshed_access_token: !!tokenInfo.refreshed,
    ...plan.counts,
    selected_for_patch: plan.selected.length,
    patched: 0,
    failed: 0,
    actions: plan.actions,
  };
  if (!apply) return result;
  if (!calendarId || !tokenInfo.accessToken) throw new Error("--apply requires calendarId and an access token");

  result.actions = [];
  for (const event of plan.selected) {
    try {
      const patched = await patchCaptureBot({
        calendarId,
        accessToken: tokenInfo.accessToken,
        event,
        botEmail,
        fetchImpl,
      });
      result.patched += 1;
      result.actions.push({
        action: "patched",
        ...summarizeEvent(patched || event, { botEmail }),
      });
    } catch (error) {
      result.failed += 1;
      result.actions.push({
        action: "failed",
        ...summarizeEvent(event, { botEmail }),
        error: error?.body?.error?.message || error?.message || String(error),
      });
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
  const result = await runEnsureGoogleCalendarCaptureBot({
    events: eventsPath ? readJson(eventsPath) : null,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    refresh: !flag("--no-refresh", argv),
    updateEnvFilePath: arg("--update-env-file", argv),
    botEmail: arg("--bot-email", argv) || process.env.SHAPE_CALENDAR_BOT_EMAIL || DEFAULT_BOT_EMAIL,
    now: nowArg ? new Date(nowArg) : new Date(),
    timeMin: arg("--time-min", argv),
    timeMax: arg("--time-max", argv),
    maxResults: numberArg("--max-results", DEFAULT_MAX_RESULTS, argv),
    maxEvents: numberArg("--max-events", null, argv),
    includeAllDay: flag("--include-all-day", argv),
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
  DEFAULT_BOT_EMAIL,
  buildEnsureCaptureBotPlan,
  eventWithCaptureBotBody,
  fetchGoogleCalendarEvents,
  googleEventPatchUrl,
  googleEventsListUrl,
  hasBotCoverage,
  isPatchableEvent,
  runEnsureGoogleCalendarCaptureBot,
};

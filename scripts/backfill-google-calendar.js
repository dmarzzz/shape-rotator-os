#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { collectEvents } = require("./build-ics.js");
const { loadEnvFile } = require("./lib/env-file.cjs");
const {
  DEFAULT_TIME_ZONE,
  dateIsoWithOffset,
  expandCollectedEvent,
  isoDate,
} = require("./lib/calendar-event-expander.cjs");

const DEFAULT_SOURCE = path.resolve(__dirname, "..", "cohort-data", "calendar.json");
const DEFAULT_MAX_EVENTS = 2500;

function usage() {
  return [
    "Usage:",
    "  node scripts/backfill-google-calendar.js --calendar-id CALENDAR_ID [--access-token TOKEN] [--apply]",
    "  node scripts/backfill-google-calendar.js --source cohort-data/calendar.json --calendar-id CALENDAR_ID --dry-run",
    "",
    "Options:",
    "  --apply                 Write missing/changed events to Google Calendar. Default is dry-run.",
    "  --dry-run               Print the plan without writing. This is the default.",
    "  --source FILE           calendar.json source. Default: cohort-data/calendar.json",
    "  --calendar-id ID        Google Calendar ID to backfill.",
    "  --access-token TOKEN    OAuth token with Calendar event write access.",
    "  --env-file FILE         Load local KEY=value secrets before env fallbacks.",
    "  --time-zone ZONE        Timezone for parsed timed events. Default: America/New_York.",
    "  --max-events N          Safety cap. Default: 2500.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_TIMEZONE",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
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

function timeZoneOffsetMinutes(dateIso, minutes, timeZone) {
  const [year, month, day] = dateIso.split("-").map(Number);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((zonedAsUtc - guess) / 60000);
}

function formatDateTime(dateIso, minutes, timeZone = DEFAULT_TIME_ZONE) {
  const dayOffset = Math.floor(minutes / 1440);
  const minuteOfDay = ((minutes % 1440) + 1440) % 1440;
  const localDate = dateIsoWithOffset(dateIso, dayOffset);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const offset = timeZoneOffsetMinutes(localDate, minuteOfDay, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function loadCalendarJson(sourcePath = DEFAULT_SOURCE) {
  return JSON.parse(fs.readFileSync(path.resolve(sourcePath), "utf8"));
}

function googleEventBodyFromCollectedEvent(event, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  const dateIso = isoDate(event.date);
  const start = event.timeKind === "timed"
    ? { dateTime: formatDateTime(dateIso, event.startMinutes, timeZone), timeZone }
    : { date: dateIso };
  const end = event.timeKind === "timed"
    ? { dateTime: formatDateTime(dateIso, event.endMinutes, timeZone), timeZone }
    : { date: dateIsoWithOffset(dateIso, event.allDaySpanDays || 1) };
  return {
    iCalUID: event.uid,
    summary: event.summary,
    description: event.description,
    start,
    end,
    eventType: "default",
    extendedProperties: {
      private: {
        shape_source: "cohort-data/calendar.json",
        shape_calendar_category: event.category,
        shape_ical_uid: event.uid,
        shape_calendar_base_uid: event.baseUid || event.uid,
        shape_calendar_block_index: String(event.blockIndex || 1),
        shape_calendar_time_kind: event.timeKind || "all_day",
        shape_calendar_span_days: String(event.allDaySpanDays || 1),
      },
    },
  };
}

function eventPatchFromBody(body) {
  return {
    summary: body.summary,
    description: body.description,
    start: body.start,
    end: body.end,
    extendedProperties: body.extendedProperties,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function meaningfulEventDiff(existing, desired) {
  const current = {
    summary: existing?.summary || "",
    description: existing?.description || "",
    start: stableJson(existing?.start || {}),
    end: stableJson(existing?.end || {}),
    "extendedProperties.private": stableJson(existing?.extendedProperties?.private || {}),
  };
  const next = {
    summary: desired.summary || "",
    description: desired.description || "",
    start: stableJson(desired.start || {}),
    end: stableJson(desired.end || {}),
    "extendedProperties.private": stableJson(desired.extendedProperties?.private || {}),
  };
  return Object.keys(next).filter((key) => current[key] !== next[key]);
}

function googleEventsUrl(calendarId, suffix = "") {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`);
}

async function googleRequest({ url, accessToken, method = "GET", body, fetchImpl = fetch }) {
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
    const error = new Error(`Google Calendar ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function findExistingEvent({ calendarId, accessToken, iCalUID, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId);
  url.searchParams.set("iCalUID", iCalUID);
  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "10");
  const data = await googleRequest({ url, accessToken, fetchImpl });
  return (data.items || []).find((item) => item.status !== "cancelled") || null;
}

async function importGoogleEvent({ calendarId, accessToken, body, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId, "/import");
  return googleRequest({ url, accessToken, method: "POST", body, fetchImpl });
}

async function patchGoogleEvent({ calendarId, accessToken, eventId, body, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId, `/${encodeURIComponent(eventId)}`);
  url.searchParams.set("sendUpdates", "none");
  return googleRequest({ url, accessToken, method: "PATCH", body: eventPatchFromBody(body), fetchImpl });
}

async function deleteGoogleEvent({ calendarId, accessToken, eventId, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId, `/${encodeURIComponent(eventId)}`);
  url.searchParams.set("sendUpdates", "none");
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok && response.status !== 410) {
    const data = await response.json().catch(() => null);
    const error = new Error(`Google Calendar DELETE ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return { deleted: true };
}

function dateFieldKind(value) {
  if (value?.dateTime) return "dateTime";
  if (value?.date) return "date";
  return "none";
}

function eventDateShapeChanged(existing, desired) {
  return dateFieldKind(existing?.start) !== dateFieldKind(desired?.start)
    || dateFieldKind(existing?.end) !== dateFieldKind(desired?.end);
}

function buildBackfillPlan({ sourcePath = DEFAULT_SOURCE, maxEvents = DEFAULT_MAX_EVENTS, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const json = loadCalendarJson(sourcePath);
  const events = collectEvents(json).flatMap(expandCollectedEvent).slice(0, maxEvents);
  return {
    source: path.resolve(sourcePath),
    last_refresh: json.last_refresh || null,
    events: events.map((event) => ({
      uid: event.uid,
      category: event.category,
      date: isoDate(event.date),
      time_kind: event.timeKind || "all_day",
      summary: event.summary,
      body: googleEventBodyFromCollectedEvent(event, { timeZone }),
    })),
  };
}

async function runGoogleCalendarBackfill({
  sourcePath = DEFAULT_SOURCE,
  calendarId,
  accessToken,
  apply = false,
  maxEvents = DEFAULT_MAX_EVENTS,
  timeZone = DEFAULT_TIME_ZONE,
  fetchImpl = fetch,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  if (apply && !accessToken) throw new Error("accessToken is required with apply=true");
  const plan = buildBackfillPlan({ sourcePath, maxEvents, timeZone });
  const result = {
    source: plan.source,
    last_refresh: plan.last_refresh,
    calendar_id: calendarId,
    apply: !!apply,
    planned: plan.events.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    actions: [],
  };
  if (!apply) {
    result.actions = plan.events.map((event) => ({
      action: "dry-run",
      uid: event.uid,
      date: event.date,
      time_kind: event.time_kind,
      summary: event.summary,
    }));
    return result;
  }
  for (const event of plan.events) {
    const existing = await findExistingEvent({
      calendarId,
      accessToken,
      iCalUID: event.uid,
      fetchImpl,
    });
    if (!existing) {
      let googleEvent;
      try {
        googleEvent = await importGoogleEvent({
          calendarId,
          accessToken,
          body: event.body,
          fetchImpl,
        });
      } catch (error) {
        error.event = {
          action: "insert",
          uid: event.uid,
          date: event.date,
          summary: event.summary,
          body: event.body,
        };
        throw error;
      }
      result.inserted += 1;
      result.actions.push({
        action: "inserted",
        uid: event.uid,
        date: event.date,
        time_kind: event.time_kind,
        summary: event.summary,
        google_event_id: googleEvent?.id || null,
      });
      continue;
    }
    const diff = meaningfulEventDiff(existing, event.body);
    if (!diff.length) {
      result.unchanged += 1;
      result.actions.push({
        action: "unchanged",
        uid: event.uid,
        date: event.date,
        time_kind: event.time_kind,
        summary: event.summary,
        google_event_id: existing.id || null,
      });
      continue;
    }
    if (eventDateShapeChanged(existing, event.body)) {
      let googleEvent;
      try {
        await deleteGoogleEvent({
          calendarId,
          accessToken,
          eventId: existing.id,
          fetchImpl,
        });
        googleEvent = await importGoogleEvent({
          calendarId,
          accessToken,
          body: event.body,
          fetchImpl,
        });
      } catch (error) {
        error.event = {
          action: "replace",
          uid: event.uid,
          date: event.date,
          summary: event.summary,
          google_event_id: existing.id || null,
          changed: diff,
          body: event.body,
        };
        throw error;
      }
      result.updated += 1;
      result.actions.push({
        action: "replaced",
        uid: event.uid,
        date: event.date,
        time_kind: event.time_kind,
        summary: event.summary,
        google_event_id: googleEvent?.id || null,
        replaced_google_event_id: existing.id || null,
        changed: diff,
      });
      continue;
    }
    let googleEvent;
    try {
      googleEvent = await patchGoogleEvent({
        calendarId,
        accessToken,
        eventId: existing.id,
        body: event.body,
        fetchImpl,
      });
    } catch (error) {
      error.event = {
        action: "patch",
        uid: event.uid,
        date: event.date,
        summary: event.summary,
        google_event_id: existing.id || null,
        changed: diff,
        body: event.body,
      };
      throw error;
    }
    result.updated += 1;
    result.actions.push({
      action: "updated",
      uid: event.uid,
      date: event.date,
      time_kind: event.time_kind,
      summary: event.summary,
      google_event_id: googleEvent?.id || existing.id || null,
      changed: diff,
    });
  }
  return result;
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const result = await runGoogleCalendarBackfill({
    sourcePath: arg("--source", argv) || DEFAULT_SOURCE,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    apply,
    maxEvents: numberArg("--max-events", DEFAULT_MAX_EVENTS, argv),
    timeZone: arg("--time-zone", argv) || process.env.GOOGLE_CALENDAR_TIMEZONE || DEFAULT_TIME_ZONE,
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
  buildBackfillPlan,
  expandCollectedEvent,
  googleEventBodyFromCollectedEvent,
  runGoogleCalendarBackfill,
};

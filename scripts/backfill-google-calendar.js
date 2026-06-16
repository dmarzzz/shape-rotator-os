#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { collectEvents } = require("./build-ics.js");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");
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
    "  node scripts/backfill-google-calendar.js --calendar-id CALENDAR_ID --check --future-only",
    "",
    "Options:",
    "  --apply                 Write missing/changed events to Google Calendar. Default is dry-run.",
    "  --check                 Compare against Google Calendar without writing. Requires a token.",
    "  --dry-run               Print the plan without writing. This is the default.",
    "  --source FILE           calendar.json source. Default: cohort-data/calendar.json",
    "  --calendar-id ID        Google Calendar ID to backfill.",
    "  --access-token TOKEN    OAuth token with Calendar event write access.",
    "  --env-file FILE         Load local KEY=value secrets before env fallbacks.",
    "  --time-zone ZONE        Timezone for parsed timed events. Default: America/New_York.",
    "  --from-date YYYY-MM-DD  Only include events overlapping this date or later.",
    "  --to-date YYYY-MM-DD    Only include events starting on this date or earlier.",
    "  --max-events N          Safety cap. Default: 2500.",
    "  --future-only           Shorthand for --from-date today in --time-zone.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_TIMEZONE",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN",
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

async function resolveGoogleAccessToken({
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  preferRefresh = false,
  fetchImpl = fetch,
} = {}) {
  if (preferRefresh && clientId && clientSecret && refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    if (String(token?.access_token || "").trim()) return token.access_token;
  }
  if (String(accessToken || "").trim()) return accessToken;
  if (clientId && clientSecret && refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    if (String(token?.access_token || "").trim()) return token.access_token;
  }
  return accessToken || "";
}

function validateDateFilter(value, label) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== text) throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  return text;
}

function todayIsoForTimeZone(timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function eventEndDateInclusive(event) {
  const startIso = isoDate(event.date);
  if (event.timeKind === "timed") {
    const endMinutes = Number.isFinite(event.endMinutes) ? event.endMinutes : 0;
    return dateIsoWithOffset(startIso, Math.max(0, Math.floor((endMinutes - 1) / 1440)));
  }
  return dateIsoWithOffset(startIso, Math.max(0, (event.allDaySpanDays || 1) - 1));
}

function eventOverlapsDateRange(event, { fromDate, toDate } = {}) {
  const startIso = isoDate(event.date);
  const endIso = eventEndDateInclusive(event);
  return (!fromDate || endIso >= fromDate) && (!toDate || startIso <= toDate);
}

function resolveDateFilters({
  fromDate,
  toDate,
  futureOnly = false,
  timeZone = DEFAULT_TIME_ZONE,
  now = new Date(),
} = {}) {
  const resolvedFromDate = validateDateFilter(fromDate || (futureOnly ? todayIsoForTimeZone(timeZone, now) : null), "fromDate");
  const resolvedToDate = validateDateFilter(toDate, "toDate");
  if (resolvedFromDate && resolvedToDate && resolvedToDate < resolvedFromDate) {
    throw new Error("toDate must be on or after fromDate");
  }
  return { fromDate: resolvedFromDate, toDate: resolvedToDate };
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

function shapePrivateProperties(body = {}) {
  const privateProps = body?.extendedProperties?.private || {};
  const baseUid = privateProps.shape_calendar_base_uid || null;
  const blockIndex = privateProps.shape_calendar_block_index || null;
  if (!baseUid || !blockIndex) return null;
  return {
    shape_calendar_base_uid: baseUid,
    shape_calendar_block_index: blockIndex,
  };
}

async function findExistingEventByICalUID({ calendarId, accessToken, iCalUID, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId);
  url.searchParams.set("iCalUID", iCalUID);
  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "10");
  const data = await googleRequest({ url, accessToken, fetchImpl });
  return (data.items || []).find((item) => item.status !== "cancelled") || null;
}

async function findExistingEventByShapeProperties({ calendarId, accessToken, privateProperties, fetchImpl = fetch }) {
  if (!privateProperties) return null;
  const url = googleEventsUrl(calendarId);
  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "10");
  for (const [key, value] of Object.entries(privateProperties)) {
    url.searchParams.append("privateExtendedProperty", `${key}=${value}`);
  }
  const data = await googleRequest({ url, accessToken, fetchImpl });
  return (data.items || []).find((item) => item.status !== "cancelled") || null;
}

async function findExistingEvent({ calendarId, accessToken, iCalUID, body, fetchImpl = fetch }) {
  const byUid = await findExistingEventByICalUID({ calendarId, accessToken, iCalUID, fetchImpl });
  if (byUid) return byUid;
  return findExistingEventByShapeProperties({
    calendarId,
    accessToken,
    privateProperties: shapePrivateProperties(body),
    fetchImpl,
  });
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

function buildBackfillPlan({
  sourcePath = DEFAULT_SOURCE,
  maxEvents = DEFAULT_MAX_EVENTS,
  timeZone = DEFAULT_TIME_ZONE,
  fromDate,
  toDate,
  futureOnly = false,
  now = new Date(),
} = {}) {
  const json = loadCalendarJson(sourcePath);
  const filters = resolveDateFilters({ fromDate, toDate, futureOnly, timeZone, now });
  const expandedEvents = collectEvents(json).flatMap(expandCollectedEvent);
  const filteredEvents = expandedEvents.filter((event) => eventOverlapsDateRange(event, filters));
  const events = filteredEvents.slice(0, maxEvents);
  return {
    source: path.resolve(sourcePath),
    last_refresh: json.last_refresh || null,
    date_filter: filters.fromDate || filters.toDate ? filters : null,
    filtered_out: expandedEvents.length - filteredEvents.length,
    capped: filteredEvents.length > events.length,
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
  check = false,
  maxEvents = DEFAULT_MAX_EVENTS,
  timeZone = DEFAULT_TIME_ZONE,
  fromDate,
  toDate,
  futureOnly = false,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  if ((apply || check) && !accessToken) throw new Error("accessToken is required with apply=true or check=true");
  const plan = buildBackfillPlan({ sourcePath, maxEvents, timeZone, fromDate, toDate, futureOnly, now });
  const result = {
    source: plan.source,
    last_refresh: plan.last_refresh,
    calendar_id: calendarId,
    apply: !!apply,
    check: !!check,
    date_filter: plan.date_filter,
    filtered_out: plan.filtered_out,
    capped: plan.capped,
    planned: plan.events.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    would_insert: 0,
    would_update: 0,
    would_replace: 0,
    actions: [],
  };
  if (!apply && !check) {
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
      body: event.body,
      fetchImpl,
    });
    if (!existing) {
      if (check) {
        result.would_insert += 1;
        result.actions.push({
          action: "would_insert",
          uid: event.uid,
          date: event.date,
          time_kind: event.time_kind,
          summary: event.summary,
        });
        continue;
      }
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
      if (check) {
        result.would_replace += 1;
        result.actions.push({
          action: "would_replace",
          uid: event.uid,
          date: event.date,
          time_kind: event.time_kind,
          summary: event.summary,
          google_event_id: existing.id || null,
          changed: diff,
        });
        continue;
      }
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
    if (check) {
      result.would_update += 1;
      result.actions.push({
        action: "would_update",
        uid: event.uid,
        date: event.date,
        time_kind: event.time_kind,
        summary: event.summary,
        google_event_id: existing.id || null,
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
  const check = flag("--check", argv) && !apply;
  const cliAccessToken = arg("--access-token", argv);
  const accessToken = (apply || check)
    ? await resolveGoogleAccessToken({
      accessToken: cliAccessToken || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      preferRefresh: !cliAccessToken,
    })
    : cliAccessToken || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN;
  const result = await runGoogleCalendarBackfill({
    sourcePath: arg("--source", argv) || DEFAULT_SOURCE,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken,
    apply,
    check,
    maxEvents: numberArg("--max-events", DEFAULT_MAX_EVENTS, argv),
    timeZone: arg("--time-zone", argv) || process.env.GOOGLE_CALENDAR_TIMEZONE || DEFAULT_TIME_ZONE,
    fromDate: arg("--from-date", argv),
    toDate: arg("--to-date", argv),
    futureOnly: flag("--future-only", argv),
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
  eventOverlapsDateRange,
  expandCollectedEvent,
  googleEventBodyFromCollectedEvent,
  resolveGoogleAccessToken,
  runGoogleCalendarBackfill,
  todayIsoForTimeZone,
};

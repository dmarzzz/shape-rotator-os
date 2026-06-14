#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");

const DEFAULT_OUTPUT = path.resolve(__dirname, "..", "cohort-data", "calendar-google-events.json");
const DEFAULT_TIME_MIN = "2026-05-18T00:00:00-04:00";
const DEFAULT_TIME_MAX = "2026-07-27T00:00:00-04:00";
const DEFAULT_MAX_RESULTS = 2500;

function usage() {
  return [
    "Usage:",
    "  node scripts/export-google-calendar-links.js --calendar-id CALENDAR_ID [--output FILE]",
    "",
    "Options:",
    "  --calendar-id ID        Google Calendar ID. Defaults to GOOGLE_CALENDAR_ID.",
    "  --access-token TOKEN    OAuth access token.",
    "  --time-min ISO          Default: Shape Rotator program start.",
    "  --time-max ISO          Default: Shape Rotator program end + 1 day.",
    "  --output FILE           Default: cohort-data/calendar-google-events.json",
    "  --env-file FILE         Load local KEY=value secrets before env fallbacks.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
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

async function resolveAccessToken({
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
  throw new Error("accessToken or GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REFRESH_TOKEN is required");
}

function googleEventsUrl(calendarId) {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
}

async function fetchGoogleCalendarEvents({
  calendarId,
  accessToken,
  timeMin = DEFAULT_TIME_MIN,
  timeMax = DEFAULT_TIME_MAX,
  maxResults = DEFAULT_MAX_RESULTS,
  fetchImpl = fetch,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  if (!accessToken) throw new Error("accessToken is required");
  const items = [];
  let nextPageToken = null;
  do {
    const url = googleEventsUrl(calendarId);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(maxResults));
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Google Calendar events.list ${response.status}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    items.push(...(data.items || []));
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  return items;
}

function shapeKeyFromPrivate(privateProps = {}) {
  const baseUid = privateProps.shape_calendar_base_uid || "";
  const blockIndex = privateProps.shape_calendar_block_index || "";
  return baseUid && blockIndex ? `${baseUid}#${blockIndex}` : "";
}

function googleEventLinkRecord(event = {}) {
  const privateProps = event.extendedProperties?.private || {};
  const shapeKey = shapeKeyFromPrivate(privateProps);
  return {
    google_event_id: event.id || null,
    html_link: event.htmlLink || null,
    ical_uid: event.iCalUID || null,
    summary: event.summary || null,
    status: event.status || null,
    start: event.start || null,
    end: event.end || null,
    shape_calendar_base_uid: privateProps.shape_calendar_base_uid || null,
    shape_calendar_block_index: privateProps.shape_calendar_block_index || null,
    shape_calendar_time_kind: privateProps.shape_calendar_time_kind || null,
    shape_key: shapeKey || null,
  };
}

function buildCalendarGoogleEventsExport({
  calendarId,
  events = [],
  generatedAt = new Date().toISOString(),
  timeMin = DEFAULT_TIME_MIN,
  timeMax = DEFAULT_TIME_MAX,
} = {}) {
  const byIcalUid = {};
  const byShapeKey = {};
  for (const event of events || []) {
    if (event?.status === "cancelled") continue;
    const record = googleEventLinkRecord(event);
    if (!record.google_event_id || !record.html_link) continue;
    if (record.ical_uid) byIcalUid[record.ical_uid] = record;
    if (record.shape_key) byShapeKey[record.shape_key] = record;
  }
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "google-calendar-events.list",
    calendar_id: calendarId || null,
    time_min: timeMin,
    time_max: timeMax,
    event_count: Object.keys(byIcalUid).length,
    by_ical_uid: byIcalUid,
    by_shape_key: byShapeKey,
  };
}

async function runExportGoogleCalendarLinks({
  calendarId,
  accessToken,
  oauthClientId,
  oauthClientSecret,
  oauthRefreshToken,
  preferRefresh = false,
  timeMin = DEFAULT_TIME_MIN,
  timeMax = DEFAULT_TIME_MAX,
  outputPath = DEFAULT_OUTPUT,
  fetchImpl = fetch,
} = {}) {
  const token = await resolveAccessToken({
    accessToken,
    clientId: oauthClientId,
    clientSecret: oauthClientSecret,
    refreshToken: oauthRefreshToken,
    preferRefresh,
    fetchImpl,
  });
  const events = await fetchGoogleCalendarEvents({
    calendarId,
    accessToken: token,
    timeMin,
    timeMax,
    fetchImpl,
  });
  const payload = buildCalendarGoogleEventsExport({
    calendarId,
    events,
    timeMin,
    timeMax,
  });
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  return payload;
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const outputPath = arg("--output", argv) || DEFAULT_OUTPUT;
  const cliAccessToken = arg("--access-token", argv);
  const payload = await runExportGoogleCalendarLinks({
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: cliAccessToken || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    preferRefresh: !cliAccessToken,
    timeMin: arg("--time-min", argv) || DEFAULT_TIME_MIN,
    timeMax: arg("--time-max", argv) || DEFAULT_TIME_MAX,
    outputPath,
  });
  process.stdout.write(JSON.stringify({
    output: path.resolve(outputPath),
    calendar_id: payload.calendar_id,
    event_count: payload.event_count,
    shape_link_count: Object.keys(payload.by_shape_key || {}).length,
  }, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildCalendarGoogleEventsExport,
  fetchGoogleCalendarEvents,
  googleEventLinkRecord,
  runExportGoogleCalendarLinks,
  shapeKeyFromPrivate,
};

#!/usr/bin/env node
/**
 * build-calendar-from-google.js — generate cohort-data/calendar.json from OUR
 * Shape Rotator admin Google Calendar, replacing the upstream Phala cadence
 * fetch (scripts/sync-calendar.js).
 *
 * Why: the schedule day-blocks are exactly our calendar's event descriptions
 * (verified — every event carries the rich block text: times, sub-bullets,
 * themes, notes). So we own the source, drop the Phala dependency, and the
 * upstream "timecode quote" leak goes away. Sheet-only metadata that has no
 * home in a calendar (week themes, support columns, headers, the RECURRING
 * section) lives in cohort-data/calendar-meta.json and is merged in here.
 *
 * Output is the same { last_refresh, tabs: { "<tab>": rows[][] } } shape the
 * renderer (packages/shape-ui parseWeekRow) already consumes, so nothing
 * downstream changes.
 *
 * Usage:
 *   node --env-file=.env.calendar.local scripts/build-calendar-from-google.js
 *   node scripts/build-calendar-from-google.js --env-file .env.calendar.local
 *   node scripts/build-calendar-from-google.js --check   # exit 1 if drift
 *
 * Env: GOOGLE_CALENDAR_ID, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *      GOOGLE_OAUTH_REFRESH_TOKEN (same secrets the other calendar workflows use).
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const META_PATH = path.join(ROOT, "cohort-data", "calendar-meta.json");
const OUT = path.join(ROOT, "cohort-data", "calendar.json");
const TIME_ZONE = "America/New_York";
// Cohort week 0 = Mon May 18 2026 (matches COHORT_START_MS in shape-ui).
const COHORT_START = Date.UTC(2026, 4, 18);
const WEEK_COUNT = 10;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
function hasFlag(name) {
  return process.argv.includes(name);
}

// Minimal KEY=VALUE loader so `--env-file path` works even without node's
// native --env-file flag. Does not override already-set process.env.
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`OAuth refresh failed: ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

async function fetchEvents(calendarId, token, timeMin, timeMax) {
  const items = [];
  let pageToken = null;
  do {
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    u.searchParams.set("timeMin", timeMin);
    u.searchParams.set("timeMax", timeMax);
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("orderBy", "startTime");
    u.searchParams.set("maxResults", "2500");
    u.searchParams.set("timeZone", TIME_ZONE); // normalize all event times to the cohort tz
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`events fetch HTTP ${res.status}`);
    const json = await res.json();
    // Privacy filter: never surface cancelled events, and drop anything the
    // organizer marked private/confidential in Google — its title/description
    // must not reach the public grid (the calendar is built from the admin
    // source calendar, which can hold non-public sessions). See the leak-scan
    // gate in publish-calendar-grid-to-supabase.mjs for the fail-closed backstop.
    items.push(...(json.items || []).filter(
      (e) => e.status !== "cancelled" && e.visibility !== "private" && e.visibility !== "confidential",
    ));
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return items;
}

// Local calendar date (YYYY-MM-DD) for an event start. Google returns timed
// events as dateTime with the calendar's UTC offset, so slicing the date off
// the offset-local string yields the wall-clock day. All-day events use .date.
function eventDateIso(event) {
  const dt = event.start?.dateTime;
  if (dt) return dt.slice(0, 10);
  return event.start?.date || null;
}

function isoToUtcMs(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmtTime(dateTime) {
  const m = String(dateTime || "").match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

// Google Calendar descriptions can be HTML (the web rich-text editor stores
// markup). Convert to the plain-text block format the renderer expects. Plain
// descriptions pass through unchanged.
function normalizeDescription(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Block text for one event: prefer the rich description (it carries time +
// title + bullets verbatim from the schedule); else synthesize a line.
function eventBlock(event) {
  const desc = normalizeDescription(event.description);
  if (desc) return desc;
  const start = fmtTime(event.start?.dateTime);
  const end = fmtTime(event.end?.dateTime);
  const time = start && end ? `${start}–${end} ` : start ? `${start} ` : "";
  return `${time}${String(event.summary || "").trim()}`.trim();
}

function dayHeader(dayName, dayMs) {
  const d = new Date(dayMs);
  return `${dayName} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}:`;
}

function buildTab(meta, events) {
  // Bucket events into [week][day] using local calendar date.
  const grid = Array.from({ length: WEEK_COUNT }, () => Array.from({ length: 7 }, () => []));
  let placed = 0;
  for (const event of events) {
    const iso = eventDateIso(event);
    if (!iso) continue;
    const offsetDays = Math.round((isoToUtcMs(iso) - COHORT_START) / 86400000);
    if (offsetDays < 0) continue;
    const weekIdx = Math.floor(offsetDays / 7);
    const dayIdx = offsetDays % 7;
    if (weekIdx >= WEEK_COUNT) continue;
    grid[weekIdx][dayIdx].push(event);
    placed += 1;
  }

  const rows = [];
  for (const headerRow of meta.header_rows || []) rows.push(headerRow);

  for (let w = 0; w < WEEK_COUNT; w += 1) {
    const wk = (meta.weeks || [])[w] || {};
    const weekStartMs = COHORT_START + w * 7 * 86400000;
    const metaCol = wk.theme ? `${wk.date_range || ""}\n\n${wk.theme}` : (wk.date_range || "");
    const dayCols = DAY_NAMES.map((name, i) => {
      const dayMs = weekStartMs + i * 86400000;
      const dayEvents = grid[w][i];
      if (!dayEvents.length) return "";
      const parts = dayEvents.map(eventBlock).filter(Boolean);
      return `${dayHeader(name, dayMs)}\n${parts.join("\n\n")}`;
    });
    rows.push([
      String(wk.week || w + 1),
      metaCol,
      ...dayCols,
      wk.on_site || "",
      wk.feedback_goals || "",
      wk.notes || "",
    ]);
  }

  for (const recurringRow of meta.recurring_rows || []) rows.push(recurringRow);
  return { rows, placed };
}

// Count day-cells (10 weeks × Mon–Sun) that carry schedule text. Used to detect
// a suspicious collapse vs the previously-committed calendar.
function countPopulatedCells(cal, tab) {
  const rows = (cal && cal.tabs && cal.tabs[tab]) || [];
  let n = 0;
  for (let r = 2; r < 12; r += 1) {
    for (let c = 2; c <= 8; c += 1) {
      if (String((rows[r] || [])[c] || "").trim()) n += 1;
    }
  }
  return n;
}

function fmt(json) {
  return JSON.stringify(json, null, 2) + "\n";
}
function strip(j) {
  const { last_refresh: _drop, ...rest } = j || {};
  return rest;
}

async function main() {
  loadEnvFile(arg("--env-file"));
  const calendarId = arg("--calendar-id") || process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) throw new Error("GOOGLE_CALENDAR_ID is required (env or --calendar-id)");
  for (const key of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"]) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  const timeMin = arg("--time-min") || new Date(COHORT_START).toISOString();
  const timeMax = arg("--time-max") || new Date(COHORT_START + (WEEK_COUNT + 1) * 7 * 86400000).toISOString();

  const token = await accessToken();
  const events = await fetchEvents(calendarId, token, timeMin, timeMax);
  const { rows, placed } = buildTab(meta, events);

  // Safety: a real schedule always has events. If we placed zero, the fetch
  // almost certainly failed (auth/scope/empty response) — refuse to overwrite
  // a good calendar.json with an empty one rather than wiping the schedule.
  if (placed === 0) {
    console.error("[build-calendar-from-google] 0 events placed — refusing to overwrite calendar.json (likely an auth/fetch problem)");
    process.exit(2);
  }

  const next = { last_refresh: new Date().toISOString(), tabs: { [meta.tab]: rows } };

  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;

  // Anti-shrink guard: never replace a healthy committed schedule with a
  // drastically smaller one (e.g. a fetch that returned only part of the data).
  const existingCells = countPopulatedCells(existing, meta.tab);
  const newCells = countPopulatedCells(next, meta.tab);
  if (existingCells >= 10 && newCells < existingCells * 0.5) {
    console.error(`[build-calendar-from-google] refusing: schedule would shrink from ${existingCells} to ${newCells} populated days — likely a partial/failed fetch`);
    process.exit(2);
  }

  const drift = !existing || JSON.stringify(strip(existing)) !== JSON.stringify(strip(next));

  if (hasFlag("--check")) {
    if (drift) {
      console.error("[build-calendar-from-google] --check: calendar.json is stale vs our calendar");
      process.exit(1);
    }
    console.log("[build-calendar-from-google] --check: calendar.json is in sync");
    return;
  }

  if (!drift) {
    console.log(`[build-calendar-from-google] no schedule change (${placed} events placed) — leaving last_refresh untouched`);
    return;
  }

  const outPath = arg("--out") ? path.resolve(arg("--out")) : OUT;
  fs.writeFileSync(outPath, fmt(next));
  console.log(`[build-calendar-from-google] wrote ${path.relative(ROOT, outPath)} — ${events.length} events, ${placed} placed into ${WEEK_COUNT} weeks`);
}

module.exports = { buildTab, eventBlock, normalizeDescription, countPopulatedCells, eventDateIso, dayHeader, COHORT_START, WEEK_COUNT, DAY_NAMES };

if (require.main === module) {
  main().catch((e) => {
    console.error(`[build-calendar-from-google] ${e.message}`);
    process.exit(2);
  });
}

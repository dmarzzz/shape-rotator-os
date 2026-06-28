// calendar.js — the calendar page (2026-06 redesign).
//
// A single Google-Calendar-shaped week: days as columns left→right
// (mon..sun), a vertical hour axis on the left, and events rendered as
// time-positioned blocks proportional to their start/end. Untimed items
// sit in an all-day lane, the now-line ticks across today's column, and
// the availability gantt rides along as a "presence" tab.
//
// Born as the experimental "calendar2" page and promoted to THE calendar
// once it beat the old day/week/presence sub-tabbed view (that renderer,
// cohort-calendar-week.js renderWeekView, still ships for the sibling web
// app). Internal c2- class names kept from the trial. Data comes from the
// Phala JSON that alchemy.js seeds (it owns loading/state); this module
// is renderer + behavior only.

import {
  escHtml, escAttr,
  parseWeekRow, parseRecurring, currentWeekIdx, phaseFor,
} from "@shape-rotator/shape-ui";
// The curated session→transcript join (date + title fragments → recorded source).
// Previously consumed only by build-bundles for dossier timelines; surfacing it here
// makes the calendar tell you which sessions were recorded, instead of being silent.
import { CALENDAR_TRANSCRIPT_MATCHES } from "../content/context/calendar-transcript-matches.js";

const PRIMARY_TAB = "May 18 Start";
const WEEK_COUNT  = 10;
// The single shared cohort calendar (GOOGLE_CALENDAR_ID) — the one admins edit
// directly (granted "Make changes to events") and cohort members subscribe to
// read-only. Cube owns it, so it stays the Meet/transcription organizer. This
// replaced the old admin-source + guest-mirror split (the mirror was removed).
const SHARED_GOOGLE_CALENDAR_ID = "c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com";

const DAY_NAMES_FULL = {
  mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday",
  fri: "friday", sat: "saturday", sun: "sunday",
};

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function compactDay(dayMs) {
  const d = new Date(dayMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function isoDay(dayMs) {
  const compact = compactDay(dayMs);
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function calendarBaseUid(dayMs, dayName) {
  return `${slug(PRIMARY_TAB)}-${compactDay(dayMs)}-${dayName}@shape-rotator-os`;
}

function calendarShapeKey(baseUid, blockIndex) {
  return baseUid && blockIndex ? `${baseUid}#${blockIndex}` : "";
}

export function managedGoogleCalendarUrl(calendarId = SHARED_GOOGLE_CALENDAR_ID) {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarId)}`;
}

// Universal "add to your own calendar" link (Google TEMPLATE). Built inline (no shape-ui
// dependency) so the renderer bundle stays self-contained; works for any subscriber.
export function googleAddEventUrl({ title, details, dayMs, timing } = {}) {
  if (!Number.isFinite(dayMs)) return "";
  const ymd = compactDay(dayMs);
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", String(title || "Shape Rotator event"));
  if (details) url.searchParams.set("details", String(details));
  url.searchParams.set("ctz", "America/New_York");
  const hms = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}${String(min % 60).padStart(2, "0")}00`;
  if (timing && Number.isFinite(timing.startMin) && Number.isFinite(timing.endMin)) {
    url.searchParams.set("dates", `${ymd}T${hms(timing.startMin)}/${ymd}T${hms(timing.endMin)}`);
  } else {
    url.searchParams.set("dates", `${ymd}/${compactDay(dayMs + 86400000)}`);
  }
  return url.toString();
}

export function calendarGoogleEventLinkForItem(item = {}, calendarGoogleEvents = {}) {
  const byShapeKey = calendarGoogleEvents?.by_shape_key || {};
  const byIcalUid = calendarGoogleEvents?.by_ical_uid || {};
  const calendar = item.calendar || {};
  const record = byShapeKey[calendar.shapeKey] || byIcalUid[calendar.uid] || null;
  return record?.html_link || "";
}

function googleRecordStartIso(record = {}) {
  const start = record.start || {};
  return String(start.dateTime || start.date || "").slice(0, 10);
}

function googleDateTimeMinutes(value) {
  const match = String(value || "").match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function googleRecordTiming(record = {}) {
  const start = record.start || {};
  const end = record.end || {};
  if (!start.dateTime || !end.dateTime) return null;
  const startMin = googleDateTimeMinutes(start.dateTime);
  let endMin = googleDateTimeMinutes(end.dateTime);
  if (startMin == null || endMin == null) return null;
  if (endMin <= startMin) endMin = startMin + 30;
  return { startMin, endMin };
}

function googleRecordBlockText(record = {}) {
  const title = String(record.summary || "Calendar event").trim();
  const timing = googleRecordTiming(record);
  return timing ? `${fmtMin(timing.startMin)} – ${fmtMin(timing.endMin)} ${title}` : title;
}

function googleRecordShapeKey(record = {}) {
  return record.shape_key || calendarShapeKey(record.shape_calendar_base_uid, record.shape_calendar_block_index);
}

function uidForGoogleRecord(record = {}, blockIndex = 1) {
  if (record.ical_uid) return record.ical_uid;
  const baseUid = record.shape_calendar_base_uid || "";
  if (!baseUid) return "";
  return blockIndex === 1 ? baseUid : baseUid.replace("@", `-block-${blockIndex}@`);
}

function addGoogleOnlyManagedEvents(days = [], calendarGoogleEvents = {}, seenShapeKeys = new Set(), catHide = new Set()) {
  const dayByIso = new Map(days.map((day) => [isoDay(day.dayMs), day]));
  const records = Object.values(calendarGoogleEvents?.by_shape_key || {});
  for (const record of records) {
    const shapeKey = googleRecordShapeKey(record);
    if (!shapeKey || seenShapeKeys.has(shapeKey)) continue;
    const day = dayByIso.get(googleRecordStartIso(record));
    if (!day) continue;
    const block = googleRecordBlockText(record);
    const cat = c2Category(block);
    // Category filter (shared with the grid's own events) — a hidden type
    // simply isn't added, so the board reflows around it.
    if (catHide.has(cat.key)) { seenShapeKeys.add(shapeKey); continue; }
    const timing = googleRecordTiming(record);
    const blockIndex = Number(record.shape_calendar_block_index) || 1;
    const item = {
      kind: "event",
      block,
      content: c2ParseBlock(block),
      cat,
      timing,
      calendar: {
        baseUid: record.shape_calendar_base_uid || "",
        blockIndex,
        shapeKey,
        uid: uidForGoogleRecord(record, blockIndex),
      },
      googleOnly: true,
    };
    if (timing) day.timed.push(item); else day.allday.push(item);
    seenShapeKeys.add(shapeKey);
  }
}

// ── category heuristics ──────────────────────────────────────────────
// Mirrors cohort-calendar-week.js's eventCategory (module-local there, so
// duplicated rather than exported — the shared module still serves the
// sibling web app and stays untouched).
const C2_CATEGORIES = [
  { key: "review",  label: "demo review",    re: /demo review|product review|internal .*review/i },
  { key: "demo",    label: "demo night",     re: /demo night|showcase|demo day/i },
  { key: "oh",      label: "office hour",    re: /office hour|pmf check|\bcheck[ -]?point|\b1:1/i },
  { key: "salon",   label: "salon",          re: /salon/i },
  { key: "social",  label: "tea / social",   re: /tea on roof|\btea\b|happy hour|coffee|social hour|\bmixer\b/i },
  { key: "weekly",  label: "sr weekly",      re: /\bweekly\b|what did you do/i },
  { key: "coord",   label: "coordination",   re: /coordinat|attribution/i },
  { key: "hack",    label: "hacking",        re: /\bhack|hackathon|open jam|\bfinals\b|submission|build night/i },
  { key: "anarchy", label: "self-organized", re: /anarchy|self-organ|no .*program|protected build|team-led/i },
];
export const C2_LEGEND = [
  { key: "oh",     label: "office hours" },
  { key: "salon",  label: "salon" },
  { key: "social", label: "tea / social" },
  { key: "weekly", label: "weekly / self-org" },
  { key: "coord",  label: "coordination" },
  { key: "review", label: "demo review" },
  { key: "hack",   label: "hacking" },
  { key: "demo",   label: "demo night" },
];
function c2Category(text) {
  const t = String(text || "");
  const tbc = /\btbc\b|to be confirmed|\(tbc\)/i.test(t);
  for (const c of C2_CATEGORIES) if (c.re.test(t)) return { key: c.key, label: c.label, tbc };
  return { key: "default", label: "", tbc };
}

// ── time parsing ─────────────────────────────────────────────────────
// The sheet's time formats are wildly inconsistent. All of these occur:
//   "19:00 dinner"                      single, colon form
//   "12:00-14:00 lunch"                 range, any of - – — : as separator
//   "- 1600-1730 salon: topic"          leading bullet + military times
//   "1600 - 1830: agenda"               military + spaces + trailing colon
//   "18:00-19:30: florentine"           trailing colon before the title
// A line "leads with a time" if, after an optional bullet, it opens with
// one or two time tokens. Military tokens (3-4 digits, no colon) are only
// accepted as part of a RANGE — a lone "2026" is more likely a year.

// "16:00" → 960 · "1600" → 960 · "930" → 570 · ("9:00","pm") → 1260;
// null when not a valid time.
function timeTokenToMin(tok, ap) {
  if (!tok) return null;
  let h, m;
  if (tok.includes(":")) {
    [h, m] = tok.split(":").map(Number);
  } else {
    if (!/^\d{3,4}$/.test(tok)) return null;
    m = Number(tok.slice(-2));
    h = Number(tok.slice(0, -2));
  }
  if (ap) {
    const p = ap.toLowerCase().startsWith("p");
    if (p && h < 12) h += 12;
    if (!p && h === 12) h = 0;
  }
  return (h <= 23 && m <= 59) ? h * 60 + m : null;
}

// → { startMin, endMin|null, rest } or null when the line has no leading time.
function c2LeadingTime(lineRaw) {
  const line = String(lineRaw || "").trim().replace(/^[-•*]\s+/, "");
  let m = line.match(/^(\d{1,2}:\d{2}|\d{3,4})\s*([ap]m)?\s*[-–—:~]\s*(\d{1,2}:\d{2}|\d{3,4})\s*([ap]m)?(?:\s*[:.\-–—]\s*|\s+|$)(.*)$/i);
  if (m) {
    const a = timeTokenToMin(m[1], m[2]);
    const b = timeTokenToMin(m[3], m[4]);
    if (a != null && b != null) return { startMin: a, endMin: b, rest: m[5].trim() };
  }
  m = line.match(/^(\d{1,2}:\d{2})\s*([ap]m)?(?:\s*[:.\-–—]\s*|\s+|$)(.*)$/i);
  if (m) {
    const a = timeTokenToMin(m[1], m[2]);
    if (a != null) return { startMin: a, endMin: null, rest: m[3].trim() };
  }
  return null;
}

// Block → grid position. Single times get a notional 60-minute duration;
// malformed/overnight ranges fall back to 30 so the block stays visible.
function c2BlockTiming(block) {
  const t = c2LeadingTime((block || "").split("\n")[0]);
  if (!t) return null;
  const startMin = t.startMin;
  let endMin = t.endMin == null ? startMin + 60 : t.endMin;
  if (endMin <= startMin) endMin = startMin + 30;
  return { startMin, endMin };
}

function c2SplitLeadingTime(line) {
  const t = c2LeadingTime(line);
  if (!t) return { time: "", rest: String(line || "").trim().replace(/^[-•*]\s+/, "") };
  return {
    time: t.endMin == null ? fmtMin(t.startMin) : `${fmtMin(t.startMin)} – ${fmtMin(t.endMin)}`,
    rest: t.rest,
  };
}

// Google Meet join link from a `Meet:`/`join:` marker line (or a bare Meet URL).
// Kept local because the OS-vendored shape-ui copy predates shape-ui's
// extractJoinLink; mirrors that parser so the web + OS behave identically.
function extractJoinLink(blockText) {
  const text = String(blockText || "");
  const clean = (u) => u.replace(/[.,);\]]+$/, "");
  const marker = text.match(/(?:^|\n)\s*(?:meet|join)\s*:\s*(https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}[^\s<]*)/i);
  if (marker) return clean(marker[1]);
  const anyMeet = text.match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}[^\s<]*/i);
  return anyMeet ? clean(anyMeet[0]) : null;
}

// Parse one cell block into { time, title, details[], meetUrl } for cards + modal.
function c2ParseBlock(block) {
  // The Google Meet join link rides in a `Meet:`/`join:` marker line; surface it
  // as a join action rather than raw detail text.
  const meetUrl = extractJoinLink(block) || "";
  const isJoinLine = (l) => /^\s*(?:[-•*]\s*)?(?:meet|join)\s*:/i.test(l);
  const lines = (block || "").split("\n").map(l => l.replace(/\s+$/, "")).filter(l => l.trim());
  const first = (lines[0] || "").trim();
  let { time, rest } = c2SplitLeadingTime(first);
  let title = rest;
  const details = lines.slice(1)
    .filter(l => !isJoinLine(l))
    .map(l => l.replace(/^\s*[-•]\s*/, "").trim())
    .filter(Boolean);
  // First line was JUST a time ("12:00 - 14:00") — the real title is the
  // next line. Never show the time twice (the card renders time separately).
  if (!title && details.length) title = details.shift();
  if (!title && time) { title = time; time = ""; }
  if (!title) title = first.replace(/^[-•*]\s+/, "");
  return { time, title, details, meetUrl };
}

function fmtMin(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── overlap layout ───────────────────────────────────────────────────
// Classic cluster algorithm: group transitively-overlapping events, then
// greedily assign each event the first free column within its cluster.
// Every event in a cluster shares the cluster's column count so widths
// line up the way Google Calendar's do.
function layoutTimed(items) {
  const sorted = [...items].sort((a, b) =>
    a.timing.startMin - b.timing.startMin || b.timing.endMin - a.timing.endMin);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const colEnds = [];
    for (const ev of cluster) {
      let col = colEnds.findIndex(end => end <= ev.timing.startMin);
      if (col === -1) { col = colEnds.length; colEnds.push(0); }
      colEnds[col] = ev.timing.endMin;
      ev.col = col;
    }
    for (const ev of cluster) ev.cols = colEnds.length;
    cluster = [];
  };
  for (const ev of sorted) {
    if (cluster.length && ev.timing.startMin >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.timing.endMin);
  }
  flush();
  return sorted;
}

// ── model registry ───────────────────────────────────────────────────
// The modal reads from the last-rendered week model instead of re-parsing
// DOM text. Render + wire always happen in the same pass (alchemy.js
// repaints on every state change), so one slot is enough.
let _model = null;

// ── timeline bridge ───────────────────────────────────────────────────
// Flatten the parsed program calendar into lightweight schedule items for the
// calendar→agenda view, so it reads the SAME live source as the grid (cal.data)
// instead of the stale build-baked whats_new feed. Each item carries its day
// (ms), display title (day-name prefix stripped), start time ("" = all-day),
// category, and an allDay flag. Multi-day items ("Mon–Tue: X" — stored in the
// spreadsheet only in their FIRST day's cell) are mirrored onto every covered
// day so the agenda shows them across the span. The grid's overlap/layout
// machinery is skipped — the agenda lists events per day.
export function flattenScheduleEvents(data) {
  const tab = data?.tabs?.[PRIMARY_TAB] || [];
  const dayName = "(mon|tue|wed|thu|fri|sat|sun)(?:day)?";
  const rangeRe = new RegExp(`^${dayName}\\s*[-–—]\\s*${dayName}\\s*[:.\\-–—]?\\s*`, "i");
  const singleRe = new RegExp(`^${dayName}\\s*[:\\-–—]\\s*`, "i");
  const clean = (t) => String(t || "").replace(rangeRe, "").replace(singleRe, "").trim();
  const DAY_IDX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const DAY_MS = 86400000;
  const out = [];
  for (let wi = 0; wi < WEEK_COUNT; wi++) {
    const week = parseWeekRow(tab[2 + wi] || [], wi);
    const days = week?.days || [];
    for (let di = 0; di < days.length; di++) {
      const d = days[di];
      if (!Number.isFinite(d?.dayMs)) continue;
      const mondayMs = d.dayMs - di * DAY_MS;
      // catSrc = full source text (best category signal); rawTitle = pre-clean
      // title (carries any "Mon–Tue:" range); time "" ⇒ all-day.
      const emit = (catSrc, rawTitle, time) => {
        const title = clean(rawTitle);
        if (!title) return;
        const cat = c2Category(catSrc).key;
        const allDay = !time;
        const range = String(rawTitle).match(rangeRe);
        const a = range && DAY_IDX[range[1].toLowerCase()];
        const b = range && DAY_IDX[range[2].toLowerCase()];
        if (range && a != null && b != null) {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (let dj = lo; dj <= hi; dj++) {
            out.push({ ms: mondayMs + dj * DAY_MS, title, time, cat, allDay, weekIdx: wi, span: hi - lo + 1 });
          }
        } else {
          out.push({ ms: d.dayMs, title, time, cat, allDay, weekIdx: wi, span: 1 });
        }
      };
      for (const a of (d.anchors || [])) emit(a.title, a.title, "");
      for (const block of (d.blocks || [])) { const p = c2ParseBlock(block); emit(block, p.title, p.time || ""); }
    }
  }
  return out;
}

// ── render ───────────────────────────────────────────────────────────
// view: "cal" (the timeline grid) | "presence" (caller-supplied availability
// gantt — the same renderer the legacy calendar page uses, passed in as
// presenceHtml so this module stays presentation-only).
//
// catHidden: category keys the legend-filter has switched off (events of those
// types are dropped and the board reflows around them).
// signals: caller-computed daily context that rides under the day headers —
//   { rowsHidden:[], scope:{id,name,teams:[{id,name}]}, perDay:[{inTown,inTownNames[]}], standing:{stage,label}|null }
// People presence + per-week PMF live outside this module's data, so the host
// (alchemy.js) computes them and passes the shaped result in; this module stays
// presentation-only.
export function renderCalendarPage({ data, calendarGoogleEvents = {}, weekIdx = 0, source = null, view = "cal", presenceHtml = "", activity = [], catHidden = [], signals = null, subscriptions = null, timelineHtml = "", timelineOptions = null, timelineSummary = null } = {}) {
  const tab = data?.tabs?.[PRIMARY_TAB] || [];
  const safeWeekIdx = Math.max(0, Math.min(WEEK_COUNT - 1, weekIdx | 0));
  const week = parseWeekRow(tab[2 + safeWeekIdx] || [], safeWeekIdx);
  const phase = phaseFor(safeWeekIdx + 1);
  const catHide = new Set(Array.isArray(catHidden) ? catHidden : []);

  // ── daily-signal state (computed by the host; see signals contract above) ──
  // who's in town (real presence) + what shipped (real activity); scope focuses
  // both on one workstream. Standing is NOT ported — seed data lives in the
  // standing views where its provenance is explained.
  const scopeTeams = Array.isArray(signals?.scope?.teams) ? signals.scope.teams : [];
  const scopeId = signals?.scope?.id && scopeTeams.some(t => t.id === signals.scope.id) ? signals.scope.id : null;
  const scopeName = scopeId ? (scopeTeams.find(t => t.id === scopeId)?.name || scopeId) : "all cohort";
  const perDaySig = Array.isArray(signals?.perDay) ? signals.perDay : [];

  // ── per-day model: split timed vs all-day, classify, layout overlaps ─
  const seenShapeKeys = new Set();
  const days = week.days.map((d, di) => {
    const timed = [];
    const allday = [];
    const baseUid = calendarBaseUid(d.dayMs, d.name);
    for (const a of (d.anchors || [])) {
      allday.push({ kind: "anchor", title: a.title, subtitle: a.subtitle, cat: { key: "default", label: "", tbc: false } });
    }
    d.blocks.forEach((block, blockIndex) => {
      const blockNumber = blockIndex + 1;
      const shapeKey = calendarShapeKey(baseUid, blockNumber);
      seenShapeKeys.add(shapeKey);  // still claim the key so its google twin stays hidden too
      const cat = c2Category(block);
      if (catHide.has(cat.key)) return;  // legend-filter dropped this type
      const timing = c2BlockTiming(block);
      const item = {
        kind: "event",
        block,
        content: c2ParseBlock(block),
        cat,
        timing,
        calendar: {
          baseUid,
          blockIndex: blockNumber,
          shapeKey,
          uid: blockNumber === 1 ? baseUid : `${baseUid.replace("@", `-block-${blockNumber}@`)}`,
        },
      };
      if (timing) timed.push(item); else allday.push(item);
    });
    return { ...d, di, timed, allday };
  });

  // ── multi-day all-day items ──────────────────────────────────────────
  // The spreadsheet puts a multi-day event only in its FIRST day's cell,
  // with the range encoded in text ("Mon-Tue: TEE Technical…"). Mirror
  // such items onto every covered day, and strip day-name prefixes from
  // titles either way — the column header already names the day.
  const DAY_IDX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const dayName = "(mon|tue|wed|thu|fri|sat|sun)(?:day)?";
  const rangeRe = new RegExp(`^${dayName}\\s*[-–—]\\s*${dayName}\\s*[:.\\-–—]?\\s*`, "i");
  const singleRe = new RegExp(`^${dayName}\\s*[:\\-–—]\\s*`, "i");
  const itemTitle = (item) => item.kind === "anchor" ? item.title : item.content.title;
  const setItemTitle = (item, t) => { if (item.kind === "anchor") item.title = t; else item.content.title = t; };
  for (let di = 0; di < days.length; di++) {
    for (const item of [...days[di].allday]) {
      const title = itemTitle(item);
      const range = title.match(rangeRe);
      if (range) {
        const rest = title.slice(range[0].length).trim();
        if (rest) setItemTitle(item, rest);
        const a = DAY_IDX[range[1].toLowerCase()];
        const b = DAY_IDX[range[2].toLowerCase()];
        if (a != null && b != null && a <= b) {
          for (let dj = a; dj <= b; dj++) {
            if (dj !== di) days[dj].allday.push(item);
          }
        }
        continue;
      }
      const single = title.match(singleRe);
      if (single) {
        const rest = title.slice(single[0].length).trim();
        if (rest) setItemTitle(item, rest);
      }
    }
  }

  addGoogleOnlyManagedEvents(days, calendarGoogleEvents, seenShapeKeys, catHide);

  // ── cohort activity lane ("shipped") ─────────────────────────────────
  // Releases + commits land on their day as clickable blocks — the calendar
  // becomes "what the cohort shipped this week", not just the schedule. A click
  // now REVEALS the ship in place (with a secondary "open team →"), instead of
  // teleporting straight to the team dossier. Scoped to one workstream when the
  // scope chip picks one.
  const ACT_KINDS = new Set(["release", "commit"]);
  const activityList = Array.isArray(activity) ? activity : [];
  for (const day of days) {
    const iso = isoDay(day.dayMs);
    day.activity = activityList
      .filter(a => a && a.date === iso && ACT_KINDS.has(a.kind) && a.nav && a.nav.recordId
        && (!scopeId || a.nav.recordId === scopeId))
      .map(a => ({ kind: a.kind, label: a.label || "", team: a.meta || "", recordId: a.nav.recordId, date: iso }));
  }

  for (const day of days) layoutTimed(day.timed);

  // The reveal popovers (events, activity chips, in-town signal) read from the
  // last-rendered model rather than re-parsing the DOM — render + wire share it.
  _model = {
    days, weekIdx: safeWeekIdx, calendarGoogleEvents,
    inTown: {
      perDay: perDaySig,
      weekly: Array.isArray(signals?.weeklyOccupancy) ? signals.weeklyOccupancy : [],
      rosterTotal: Math.max(1, Number(signals?.rosterTotal) || 0),
      scopeName,
      days: days.map(d => ({ name: d.name, date: d.date })),
    },
  };

  // ── time window for the build field ─────────────────────────────────
  // Scan the week's events; B's panel floors this to a residency day below
  // (bWinStart/bWinEnd) so build-time reads as one continuous ground.
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const d of days) {
    for (const ev of d.timed) {
      minStart = Math.min(minStart, ev.timing.startMin);
      maxEnd   = Math.max(maxEnd, ev.timing.endMin);
    }
  }

  const isPresence = view === "presence";
  // Same shared view-nav component as the cohort / context / program pages
  // (.alch-page-views) — one visual language for in-page tabs everywhere. The
  // agenda tab is gone: the grid below now carries its filter + signals, so the
  // two views are one.
  // Calendar views (calendar grid | presence) moved to the rail sub-nav (left
  // panel), so the page no longer renders its own in-page tab strip.
  const viewTabs = "";
  const subscribeAction = `
    <a class="c2-subscribe" href="${escAttr(managedGoogleCalendarUrl(SHARED_GOOGLE_CALENDAR_ID))}" data-external
       aria-label="Subscribe to the Shape Rotator Google Calendar"
       title="Subscribe — opens the Shape Rotator Google Calendar">
      <svg class="c2-subscribe-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v5"/><path d="M9.5 16.5h5"/></svg>
      <span class="c2-subscribe-label">subscribe</span>
      <svg class="c2-subscribe-hook" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>
    </a>`;
  // The masthead is just the view tabs + subscribe; the arc navigates weeks.
  const masthead = `
    <div class="c2-toolbar">
      ${viewTabs}
      ${subscribeAction}
    </div>`;

  if (isPresence) {
    return `
      <section class="c2" data-phase="${escAttr(phase)}">
        ${masthead}
        <div class="c2-presence">
          ${presenceHtml || `<div class="c2-loading">presence view not available.</div>`}
        </div>
      </section>`;
  }

  // Controls folded INTO B's frame: scope (focuses presence + shipping on one
  // workstream) sits by the week facts; the category filter doubles as the
  // "this week" legend (drops a gathering type from the panel). Both reuse the
  // existing .c2-scope / .c2-filter markup, so their wiring carries over.
  const scopeChip = scopeTeams.length ? `
    <div class="c2-scope rr-scope" data-c2-scope-ctl>
      <button class="c2-scope-btn${scopeId ? " is-on" : ""}" data-c2-scope-toggle aria-haspopup="listbox" aria-expanded="false"
              aria-label="focus presence + shipping on one workstream" type="button">
        <span class="c2-scope-k">scope</span><span class="c2-scope-v">${escHtml(scopeName)}</span><i class="c2-chev" aria-hidden="true"></i>
      </button>
      <div class="c2-scope-menu" role="listbox" aria-label="workstream" hidden>
        ${[{ id: "", name: "all cohort" }, ...scopeTeams].map(o => `
          <button class="c2-scope-opt" role="option" data-c2-scope="${escAttr(o.id)}"
                  aria-selected="${(o.id || null) === scopeId ? "true" : "false"}" type="button">${escHtml(o.name)}</button>`).join("")}
      </div>
    </div>` : "";
  // The legend doubles as the filter but stays decluttered: it lists only the
  // gathering types actually IN this week (plus any you've switched off, so you
  // can turn them back on) — not all seven categories every week.
  const presentCatKeys = new Set();
  for (const d of days) {
    for (const ev of d.timed) if (ev.cat && ev.cat.key !== "default" && ev.cat.label) presentCatKeys.add(ev.cat.key);
    for (const it of d.allday) if (it.cat && it.cat.key !== "default" && it.cat.label) presentCatKeys.add(it.cat.key);
  }
  const legendCats = C2_LEGEND.filter(c => presentCatKeys.has(c.key) || catHide.has(c.key));
  const filterBar = legendCats.length ? `
    <div class="c2-filter rr-filter" role="group" aria-label="filter gatherings by type">
      ${legendCats.map(c => `
        <button class="c2-filter-item${catHide.has(c.key) ? " is-off" : ""}" data-c2-cat="${escAttr(c.key)}" data-cat="${escAttr(c.key)}"
                type="button" aria-pressed="${catHide.has(c.key) ? "false" : "true"}">
          <i class="c2-chip-dot" aria-hidden="true"></i>${escHtml(c.label)}
        </button>`).join("")}
    </div>` : "";

  // ── stale banner (same contract as the calendar page) ───────────────
  const staleBanner = source === "bundled" ? `
    <div class="c2-stale" role="status">
      <span aria-hidden="true">░</span>
      <span>offline · showing bundled snapshot · <button class="c2-retry" type="button" data-c2-retry="1">try again now</button></span>
    </div>` : "";

  if (!tab.length) {
    return `
      <section class="c2" data-phase="${escAttr(phase)}">
        ${masthead}
        <div class="c2-loading">loading the cohort calendar…</div>
      </section>`;
  }

  // ── residency-rhythm composition (Direction B) ───────────────────────
  // Designed from the residency's truth: the 10-week ARC is the navigator AND a
  // sparkline (presence height · ship marks); the focused week is a panel where
  // build-time is the GROUND and the few gatherings are punctuation at their
  // real time; presence is one honest near-full ribbon; shipping is a row of
  // pulses. Reuses the data attributes (data-c2-ev / -intown / -act / -week /
  // -nav) so the modal, reveals and week-nav wiring carry over unchanged.
  const cap = (x) => String(x || "").charAt(0).toUpperCase() + String(x || "").slice(1);
  const isWeekend = (name) => name === "sat" || name === "sun";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAY_MS = 86400000;
  const shortDate = (ms) => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const fmtHour = (m) => String(Math.floor(m / 60) % 24).padStart(2, "0");

  const weekStartMs = Number.isFinite(days[0]?.dayMs) ? days[0].dayMs : null;
  const weekEndMs = Number.isFinite(days[6]?.dayMs) ? days[6].dayMs : null;
  const rangeLabel = (weekStartMs != null && weekEndMs != null) ? `${shortDate(weekStartMs)} – ${shortDate(weekEndMs)}` : "";
  const WEEK_TITLES = ["First light", "Settling in", "Finding the shape", "Into the work", "The middle weeks", "Past the midpoint", "Pushing to fit", "Sharpening the pitch", "The final stretch", "Toward demo night"];
  const NAV_MID = ["the opening days", "still arriving", "finding the rhythm", "into the work", "halfway up the residency", "past the midpoint", "the push begins", "sharpening the pitch", "the final stretch", "demo week"];
  const weekTitle = WEEK_TITLES[safeWeekIdx] || `Week ${safeWeekIdx + 1}`;

  const rosterTotal = Math.max(1, Number(signals?.rosterTotal) || perDaySig.reduce((m, s) => Math.max(m, Number(s?.inTown) || 0), 1));

  // stats — who's here, what shipped, how much we gathered
  const todayIdx = days.findIndex(d => d.isToday);
  const refIdx = todayIdx >= 0 ? todayIdx : 6;
  const inTownToday = Number(perDaySig[refIdx]?.inTown) || perDaySig.reduce((m, s) => Math.max(m, Number(s?.inTown) || 0), 0);
  const satPct = rosterTotal ? Math.round((inTownToday / rosterTotal) * 100) : 0;
  const gatherCount = days.reduce((n, d) => n + d.timed.length, 0);
  const gatherHrs = Math.round(days.reduce((n, d) => n + d.timed.reduce((s, ev) => s + (ev.timing.endMin - ev.timing.startMin), 0), 0) / 60);
  const shipCount = days.reduce((n, d) => n + (d.activity || []).filter(a => a.kind === "release").length, 0);
  const descriptor = gatherCount === 0 ? "a pure build week" : gatherCount <= 6 ? "mostly building, lightly gathered" : "a gathering-heavy week";

  const headHtml = `
    <header class="rr-head">
      <div class="rr-head-l">
        <h2 class="rr-title">${escHtml(weekTitle)}</h2>
        <div class="rr-sub">${escHtml(rangeLabel)} — ${escHtml(descriptor)}.</div>
      </div>
      <div class="rr-head-r">
        <div class="rr-controls">
          ${scopeChip}
          ${subscribeAction}
        </div>
        <div class="rr-stats">
          <div class="rr-stat rr-stat--pres"><div class="rr-stat-lab">in town</div><div class="rr-stat-big">${inTownToday}<small> /${rosterTotal}</small></div><div class="rr-stat-note rr-tone-pres">${satPct}% of the house</div></div>
          <div class="rr-stat rr-stat--ship"><div class="rr-stat-lab">shipped</div><div class="rr-stat-big">${shipCount}</div><div class="rr-stat-note rr-tone-ship">release${shipCount === 1 ? "" : "s"} this wk</div></div>
          <div class="rr-stat rr-stat--gather"><div class="rr-stat-lab">gathered</div><div class="rr-stat-big">${gatherCount}</div><div class="rr-stat-note">${gatherHrs}h together</div></div>
        </div>
      </div>
    </header>`;

  // ── this week — linear time field floored to a residency day so build reads
  // as continuous ground; gatherings drop at their real time. ──
  // Floor the day to a core 12:00–20:00 window (expanded if events fall outside)
  // so the afternoon gatherings aren't stranded above/below a 9–21 void.
  let bWinStart = 12 * 60, bWinEnd = 20 * 60;
  if (Number.isFinite(minStart)) { bWinStart = Math.min(bWinStart, Math.floor(minStart / 60) * 60); bWinEnd = Math.max(bWinEnd, Math.ceil(maxEnd / 60) * 60); }
  const bSpan = Math.max(120, bWinEnd - bWinStart);
  const bPct = (m) => ((Math.max(bWinStart, Math.min(bWinEnd, m)) - bWinStart) / bSpan) * 100;
  const nowD = new Date();
  const nowMin = nowD.getHours() * 60 + nowD.getMinutes();

  const dhHtml = days.map((d) => {
    const num = d.date.replace(/^[a-z]+\s+/, "");
    const cls = ["rr-dh", d.isToday ? "today" : "", isWeekend(d.name) ? "dim" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}"><span class="rr-dh-d">${escHtml(cap(d.name))}</span><span class="rr-dh-n">${escHtml(num)}${d.isToday ? " · today" : ""}</span></div>`;
  }).join("");

  // A quiet 3-hour ruler only — each gathering carries its own exact time on its
  // tick, so the shared gutter never implies a time only one column actually has.
  const spineMarks = [];
  for (let m = Math.ceil(bWinStart / 180) * 180; m <= bWinEnd; m += 3 * 60) spineMarks.push(m);
  const spineHtml = `<div class="rr-spine" aria-hidden="true">${spineMarks.map(m => `<span class="rr-t" style="top:${bPct(m).toFixed(1)}%">${escHtml(fmtHour(m))}</span>`).join("")}</div>`;

  const fieldsHtml = days.map((d, di) => {
    const banners = d.allday.map((item, ai) => {
      const title = item.kind === "anchor" ? item.title : item.content.title;
      // A multi-day item is the SAME object mirrored onto each covered day; if
      // yesterday already carried it, this day is a continuation — show a quiet
      // "→ continues" rather than repeating the full title (less clutter).
      const isCont = di > 0 && (days[di - 1].allday || []).includes(item);
      return `<button class="rr-allday${isCont ? " is-cont" : ""}" data-cat="${escAttr(item.cat.key)}" data-c2-ev="a:${di}:${ai}" type="button" title="${escAttr(title)}"><span>${isCont ? "→ continues" : escHtml(title)}</span></button>`;
    }).join("");
    // Place each gathering at its real time, then nudge later ones down so two
    // close gatherings (tea 15:30 + retro 17:00) don't overlap. Each tick is ~2
    // lines tall; SLOT is that height as a % of the field.
    const SLOT = 17;
    const tickItems = d.timed
      .map((ev, ti) => ({ ev, ti, top: bPct(ev.timing.startMin) }))
      .sort((a, b) => a.top - b.top);
    let prevTop = -SLOT;
    for (const it of tickItems) { if (it.top < prevTop + SLOT) it.top = prevTop + SLOT; prevTop = it.top; }
    const ticks = tickItems.map(({ ev, ti, top }) => {
      const time = `${fmtMin(ev.timing.startMin)}–${fmtMin(ev.timing.endMin)}`;
      return `<button class="rr-tick" data-cat="${escAttr(ev.cat.key)}" data-c2-ev="t:${di}:${ti}" type="button" style="top:${Math.min(top, 84).toFixed(1)}%" aria-label="${escAttr(time + " " + ev.content.title)}"><span class="rr-tick-nm">${escHtml(ev.content.title)}</span><span class="rr-tick-tm">${escHtml(time)}${ev.cat.tbc ? " · tbc" : ""}</span></button>`;
    }).join("");
    // Empty days name the ground (open build / rest); populated days let the
    // gatherings speak — no redundant "build" label on every column.
    const ground = (!d.timed.length && !d.allday.length) ? `<span class="rr-ghost">${isWeekend(d.name) ? "rest" : "open build"}</span>` : "";
    const nowEls = d.isToday && nowMin >= bWinStart && nowMin <= bWinEnd
      ? `<span class="rr-now" style="top:${bPct(nowMin).toFixed(1)}%"></span><span class="rr-now-dot" style="top:${bPct(nowMin).toFixed(1)}%"></span>` : "";
    const cls = ["rr-field", d.isToday ? "today" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}"${d.isToday ? ` data-rr-win="${bWinStart}:${bWinEnd}"` : ""}>${ground}${banners}${ticks}${nowEls}</div>`;
  }).join("");

  // ── subscribable rows — the configurable lane stack under the week grid ──
  // The week panel used to hard-code two strips (presence ribbon + shipped). Those
  // are now the two DEFAULT rows in a user-controlled stack: each row subscribes to
  // a feed (a team, github pushes, releases, meeting transcripts, presence) and the
  // "+ subscribe a row" control adds more. Every row resolves from data already
  // loaded — `activity` (whats_new), the public transcript anchors, and per-day
  // presence — so this module stays presentation-only (no new fetches). The host
  // (alchemy.js) owns persistence + add/remove wiring; we just render the model and
  // stash it on _model.rows so the reveal can read the clicked item back.
  const subList = (Array.isArray(subscriptions) && subscriptions.length)
    ? subscriptions
    : [{ id: "row-presence", kind: "presence" }, { id: "row-shipped", kind: "shipped" }];
  const dayIsos = days.map(d => isoDay(d.dayMs));
  const teamNameOf = (id) => (scopeTeams.find(t => t.id === id)?.name) || id || "team";
  const actToItem = (a) => ({ kind: a.kind, label: a.label || "", team: a.meta || "", recordId: a.nav?.recordId || null, date: a.date });
  const transcriptsForDay = (iso, subjectId = null) => CALENDAR_TRANSCRIPT_MATCHES
    .filter(e => e && e.date === iso)
    .filter(e => {
      if (!subjectId) return true;
      const want = new Set([subjectId, slug(teamNameOf(subjectId))]);
      return (e.sources || []).some(s => [...(s.mentions_any || []), ...(s.mentions_direct || [])].some(m => want.has(m)));
    })
    .map(e => ({ kind: "transcript", label: e.section || (e.title_contains || [])[0] || "session",
                 title: (e.title_contains || []).join(" · "), confidence: e.confidence || "",
                 sourceCount: (e.sources || []).length, date: e.date }));

  const resolveRow = (sub) => {
    const kind = sub.kind;
    const subjectId = sub.subjectId || null;
    let label = sub.label || "";
    let render = "feed";
    const perDay = dayIsos.map(() => ({ items: [] }));
    if (kind === "presence") { render = "presence"; label = label || "in town"; }
    else if (kind === "shipped") {
      label = label || "shipped";
      dayIsos.forEach((iso, di) => { for (const a of activityList) if (a && a.date === iso && ACT_KINDS.has(a.kind) && (!scopeId || a.nav?.recordId === scopeId)) perDay[di].items.push(actToItem(a)); });
    } else if (kind === "commits" || kind === "releases") {
      const want = kind === "commits" ? "commit" : "release";
      label = label || (kind === "commits" ? "github pushes" : "releases");
      dayIsos.forEach((iso, di) => { for (const a of activityList) if (a && a.date === iso && a.kind === want && (!scopeId || a.nav?.recordId === scopeId)) perDay[di].items.push(actToItem(a)); });
    } else if (kind === "transcripts") {
      label = label || "meetings";
      dayIsos.forEach((iso, di) => { for (const t of transcriptsForDay(iso)) perDay[di].items.push(t); });
    } else if (kind === "team") {
      label = label || teamNameOf(subjectId);
      dayIsos.forEach((iso, di) => {
        for (const a of activityList) if (a && a.date === iso && ACT_KINDS.has(a.kind) && (a.nav?.recordId === subjectId)) perDay[di].items.push(actToItem(a));
        for (const t of transcriptsForDay(iso, subjectId)) perDay[di].items.push(t);
      });
    }
    const count = perDay.reduce((n, c) => n + c.items.length, 0);
    return { id: sub.id, kind, subjectId, label, hidden: !!sub.hidden, builtin: !!sub.builtin, render, perDay, count };
  };
  const rowModels = subList.filter((s) => !s.hidden).map(resolveRow);
  _model.rows = rowModels;

  // 16px line glyphs per row kind (matches the app's lucide-ish stroke set).
  const ROW_ICON = {
    presence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>',
    shipped: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    commits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/></svg>',
    releases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',
    transcripts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  };
  const rowIcon = (kind) => ROW_ICON[kind] || ROW_ICON.team;

  // presence row — a compact per-day occupancy bar + count (sleeker than the old
  // SVG ribbon, and consistent with every other lane). Click still opens presence.
  const presenceCells = days.map((d, di) => {
    const n = Number(perDaySig[di]?.inTown) || 0;
    const frac = rosterTotal ? Math.max(0, Math.min(1, n / rosterTotal)) : 0;
    const lbl = n ? `${cap(d.name)} ${d.date.replace(/^[a-z]+\s+/, "")} · ${n} of ${rosterTotal} in town — open presence`
                  : `${cap(d.name)} · nobody in town — open presence`;
    // a continuous occupancy stripe — each day's fill opacity scales with how full
    // the house is, so the seven segments read as one intensity ribbon along the row.
    const fill = (0.08 + frac * 0.82).toFixed(3);
    return `<button class="rr-fcell rr-fcell-pres${d.isToday ? " today" : ""}" data-c2-intown="${di}" type="button" aria-label="${escAttr(lbl)}"><span class="rr-pres-fill" style="opacity:${fill}"></span><span class="rr-fcell-n">${n || ""}</span></button>`;
  }).join("");

  // feed row — per-day cells of clickable items (release/commit/team chips, or a
  // transcript anchor), mirroring the old shipped lane but driven by the feed.
  const feedCells = (row) => row.perDay.map((c, di) => {
    const today = days[di]?.isToday ? " today" : "";
    if (!c.items.length) return `<div class="rr-fcell rr-fcell-empty${today}"></div>`;
    const pulses = `<div class="rr-pulses">${c.items.slice(0, 5).map(() => `<span class="rr-pulse"></span>`).join("")}</div>`;
    const lines = c.items.map((it, ii) => {
      const inner = it.kind === "transcript"
        ? escHtml(it.label)
        : `${it.team ? `<span class="rr-rel-team">${escHtml(it.team)}</span> ` : ""}${escHtml(it.label)}`;
      const title = it.kind === "transcript" ? it.label : `${it.team ? it.team + " " : ""}${it.label}`;
      return `<button class="rr-rel" data-c2-rowitem="${row.__ri}:${di}:${ii}" type="button" title="${escAttr(title)}">${inner}</button>`;
    }).join("");
    return `<div class="rr-fcell has${today}">${pulses}<div class="rr-rels">${lines}</div></div>`;
  }).join("");

  const rowsHtml = rowModels.map((row, ri) => {
    row.__ri = ri;
    const cells = row.render === "presence" ? presenceCells : feedCells(row);
    // A row reads "active" when it has something this week (presence is a
    // continuous signal, so it's always live); quiet rows dim so the eye lands on
    // what actually happened. The count badge is the at-a-glance weight.
    const active = row.render === "presence" || row.count > 0;
    const badge = row.render === "presence"
      ? ""
      : (row.count > 0 ? `<span class="rr-row-count" title="${row.count} this week" aria-label="${row.count} this week">${row.count}</span>` : "");
    return `
      <div class="rr-row rr-frow ${active ? "is-active" : "is-quiet"}" data-rr-row="${ri}" data-c2-subrow-id="${escAttr(row.id)}" data-row-kind="${escAttr(row.kind)}">
        <div class="rr-rowlab rr-frowlab" draggable="true" tabindex="0" role="button" title="drag to reorder · ${escAttr(row.label)}" aria-label="${escAttr(row.label)} row — drag, click ▴▾, or Alt+↑/↓ to reorder">
          <span class="rr-row-move" aria-hidden="true">
            <button class="rr-row-mv" data-c2-subrow-move="up" type="button" tabindex="-1" draggable="false" title="move up">▴</button>
            <button class="rr-row-mv" data-c2-subrow-move="down" type="button" tabindex="-1" draggable="false" title="move down">▾</button>
          </span>
          <span class="rr-rowlab-ico" aria-hidden="true">${rowIcon(row.kind)}</span>
          <span class="rr-rowlab-tx">${escHtml(row.label)}</span>
          ${badge}
          <button class="rr-rowlab-x" data-c2-subrow-remove="${escAttr(row.id)}" type="button" draggable="false" title="remove row" aria-label="remove ${escAttr(row.label)} row">×</button>
        </div>
        ${cells}
      </div>`;
  }).join("");

  // rows control — the "rows ⌄" checklist that adds/removes feed lanes. Reuses the
  // design-system dropdown family (.c2-rowsctl-*) the calendar already ships (and ds.css
  // styles), so it inherits the unified panel / option / selected-wash look; each
  // option is a checkbox reflecting whether that lane is subscribed. Toggle + menu
  // wiring live in wireCalendar().
  const subOn = (kind, subjectId = null) => subList.some(s => s.kind === kind && (s.subjectId || null) === (subjectId || null));
  const rowOpt = (kind, label, subjectId = null) => `
    <button class="c2-rowsctl-opt" role="menuitemcheckbox" aria-checked="${subOn(kind, subjectId) ? "true" : "false"}"
            data-c2-subrow-toggle data-c2-subrow-kind="${escAttr(kind)}"${subjectId ? ` data-c2-subrow-subject="${escAttr(subjectId)}"` : ""} data-c2-subrow-label="${escAttr(label)}" type="button">
      <i class="c2-rowsctl-check" aria-hidden="true">✓</i>
      <span class="rr-rowlab-ico" aria-hidden="true">${rowIcon(kind)}</span>
      <span>${escHtml(label)}</span>
    </button>`;
  const addKinds = [
    { kind: "commits", label: "github pushes" },
    { kind: "releases", label: "products / releases" },
    { kind: "transcripts", label: "meetings · transcripts" },
    { kind: "presence", label: "in town" },
    { kind: "shipped", label: "shipped" },
  ];
  // Add affordance — a full-width "+ add a feed row" sits as the last lane in the
  // stack (in-context, not a stray corner button), opening the same checklist so
  // you tick feeds + teams on/off. Aligned to the grid so it reads as the next row.
  const addRowControl = `
    <div class="rr-addrow" data-c2-subrow-ctl>
      <button class="rr-addrow-trigger" data-c2-subrow-add type="button" aria-haspopup="menu" aria-expanded="false" aria-label="add or remove calendar rows">
        <span class="rr-addrow-plus" aria-hidden="true">+</span>
        <span class="rr-addrow-tx">add a feed row</span>
        <i class="c2-chev" aria-hidden="true"></i>
      </button>
      <div class="c2-rowsctl-menu rr-addrow-menu" role="menu" aria-label="calendar rows" hidden>
        <div class="c2-rowsctl-grp">cohort feeds</div>
        ${addKinds.map(k => rowOpt(k.kind, k.label)).join("")}
        ${scopeTeams.length ? `<div class="c2-rowsctl-grp">teams — commits · releases · meetings</div>${scopeTeams.map(t => rowOpt("team", t.name, t.id)).join("")}` : ""}
      </div>
    </div>`;

  const laneOpts = Array.isArray(timelineOptions?.lanes) ? timelineOptions.lanes : [];
  const catOpts = Array.isArray(timelineOptions?.categories) ? timelineOptions.categories : [];
  const timelineOpt = (kind, opt) => {
    const key = String(opt?.key || "");
    const label = String(opt?.label || key);
    const count = Number.isFinite(opt?.count) ? String(opt.count) : "";
    const checked = !opt?.hidden;
    return `
      <button class="c2-rowsctl-opt rr-timeline-opt" role="menuitemcheckbox" aria-checked="${checked ? "true" : "false"}"
              data-c2-timeline-pref="${escAttr(kind)}" data-c2-timeline-key="${escAttr(key)}" type="button">
        <i class="c2-rowsctl-check" aria-hidden="true">&#10003;</i>
        <span class="rr-timeline-swatch" ${kind === "category" ? `data-cat="${escAttr(key)}"` : `data-track="${escAttr(key)}"`} aria-hidden="true"></span>
        <span class="rr-timeline-opt-label">${escHtml(label)}</span>
        ${count ? `<em class="rr-timeline-opt-count">${escHtml(count)}</em>` : ""}
      </button>`;
  };
  const timelineControls = (laneOpts.length || catOpts.length) ? `
    <div class="rr-timeline-prefs" data-c2-timeline-ctl>
      <button class="rr-timeline-prefbtn" data-c2-timeline-prefs-toggle type="button" aria-haspopup="menu" aria-expanded="false" aria-label="choose timeline view">
        <span>view</span><i class="c2-chev" aria-hidden="true"></i>
      </button>
      <div class="c2-rowsctl-menu rr-timeline-menu" role="menu" aria-label="timeline view" hidden>
        ${laneOpts.length ? `<div class="c2-rowsctl-grp">lanes</div>${laneOpts.map((opt) => timelineOpt("lane", opt)).join("")}` : ""}
        ${catOpts.length ? `<div class="c2-rowsctl-grp">points</div>${catOpts.map((opt) => timelineOpt("category", opt)).join("")}` : ""}
      </div>
    </div>` : "";
  const timelineBits = [
    Number.isFinite(timelineSummary?.lanes) ? `${timelineSummary.lanes} lanes` : "",
    Number.isFinite(timelineSummary?.points) ? `${timelineSummary.points} points` : "",
    "program axis",
  ].filter(Boolean).join(" &middot; ");
  const timelinePanel = timelineHtml ? `
    <section class="rr-timeline" data-c2-timeline aria-label="cohort timeline">
      <header class="rr-timeline-head">
        <div class="rr-timeline-title">
          <span>cohort timeline</span>
          <em>${timelineBits}</em>
        </div>
        ${timelineControls}
      </header>
      <div class="alch-timeline-view rr-timeline-view">${timelineHtml}</div>
    </section>` : "";

  const navHtml = `
    <div class="rr-nav">
      <button class="rr-navbtn rr-prev" data-c2-nav="prev"${safeWeekIdx === 0 ? " disabled" : ""} type="button">${safeWeekIdx === 0 ? "start of residency" : `← wk ${String(safeWeekIdx).padStart(2, "0")} · ${escHtml(weekStartMs != null ? shortDate(weekStartMs - 7 * DAY_MS) : "")}`}</button>
      <span class="rr-nav-mid">${escHtml(NAV_MID[safeWeekIdx] || "")}</span>
      <button class="rr-navbtn rr-next" data-c2-nav="next"${safeWeekIdx === WEEK_COUNT - 1 ? " disabled" : ""} type="button">${safeWeekIdx === WEEK_COUNT - 1 ? "demo week" : `wk ${String(safeWeekIdx + 2).padStart(2, "0")} · ${escHtml(weekStartMs != null ? shortDate(weekStartMs + 7 * DAY_MS) : "")} →`}</button>
    </div>`;

  // ── week dot-rail — the restored navigator: ← 1 2 … 10 → on a hairline rail.
  // The week containing today keeps an under-dot; the VIEWED week is the oxide
  // bead (glides between weeks via scrubberSweep). Reuses the c2-scrub data attrs
  // (data-c2-week / data-c2-nav) so the existing click + keyboard wiring carries.
  const nowWeekIdx = currentWeekIdx();
  const scrubDots = Array.from({ length: WEEK_COUNT }, (_, i) => `
    <button class="c2-scrub-dot${i === nowWeekIdx ? " is-now" : ""}" data-c2-week="${i}"
            aria-selected="${i === safeWeekIdx}" aria-label="week ${i + 1}" type="button">${i + 1}</button>`).join("");
  const weekRailHtml = `
    <header class="c2-masthead">
      <div class="c2-scrub" role="tablist" aria-label="program week">
        <button class="c2-scrub-arrow" data-c2-nav="prev" aria-label="previous week" ${safeWeekIdx === 0 ? "disabled" : ""} type="button">←</button>
        ${scrubDots}
        <button class="c2-scrub-arrow" data-c2-nav="next" aria-label="next week" ${safeWeekIdx === WEEK_COUNT - 1 ? "disabled" : ""} type="button">→</button>
      </div>
    </header>`;

  return `
    <section class="c2 rr-cal" data-phase="${escAttr(phase)}">
      ${staleBanner}
      ${headHtml}
      ${weekRailHtml}
      <section class="rr-panel">
        <div class="rr-panel-head">
          ${filterBar}
        </div>
        <div class="rr-weekscroll">
          <div class="rr-grid" role="grid" aria-label="week schedule">
            <div class="rr-corner"></div>
            ${dhHtml}
            ${spineHtml}
            ${fieldsHtml}
          </div>
          <div class="rr-rows" role="group" aria-label="subscribed feed rows">
            ${rowsHtml}
          </div>
          ${addRowControl}
          ${timelinePanel}
        </div>
        ${navHtml}
      </section>
    </section>`;
}

// ── behavior — now-line tick ─────────────────────────────────────────
// Advances today's now-line + dot across the build field every 30s using the
// SAME linear window the renderer used (serialized onto the today field as
// data-rr-win="start:end" in minutes). No-ops cleanly when the viewed week has
// no today column. Returns a teardown fn the consumer calls before each repaint
// so intervals don't stack.
export function attachCalendarPageBehavior(root) {
  if (!root) return () => {};
  const field = root.querySelector(".rr-field.today");
  const line = field?.querySelector(".rr-now");
  const dot = field?.querySelector(".rr-now-dot");
  if (!field || !line) return () => {};
  let winStart = 12 * 60, winEnd = 20 * 60;
  try {
    const w = String(field.dataset.rrWin || "").split(":").map(Number);
    if (w.length === 2 && w.every(Number.isFinite)) { winStart = w[0]; winEnd = w[1]; }
  } catch {}
  const span = Math.max(1, winEnd - winStart);
  function placeNow() {
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    const show = m >= winStart && m <= winEnd;
    line.style.display = show ? "" : "none";
    if (dot) dot.style.display = show ? "" : "none";
    if (!show) return;
    const top = (((m - winStart) / span) * 100).toFixed(1) + "%";
    line.style.top = top;
    if (dot) dot.style.top = top;
  }
  placeNow();
  const timer = setInterval(placeNow, 30000);
  return function teardown() { clearInterval(timer); };
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function rectFromAnchor(anchor) {
  try {
    return anchor?.getBoundingClientRect?.() || null;
  } catch {
    return null;
  }
}

function clearCalendarEventSelection() {
  if (typeof document === "undefined") return;
  for (const selected of document.querySelectorAll(".c2-ev.is-selected, .c2-chip.is-selected")) {
    selected.classList.remove("is-selected");
  }
}

function positionEventPanel(overlay, anchorRect) {
  const panel = overlay?.querySelector?.(".c2-modal-panel");
  if (!panel || !anchorRect || !Number.isFinite(anchorRect.left)) {
    overlay?.classList?.add("is-centered");
    return;
  }

  const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
  const vh = window.innerHeight || document.documentElement.clientHeight || 768;
  const margin = vw < 640 ? 12 : 16;
  const gap = vw < 640 ? 8 : 20;
  const panelRect = panel.getBoundingClientRect();
  const maxX = Math.max(margin, vw - panelRect.width - margin);
  const maxY = Math.max(margin, vh - panelRect.height - margin);

  let placement = anchorRect.left + anchorRect.width / 2 < vw / 2 ? "right" : "left";
  let x = placement === "right"
    ? anchorRect.right + gap
    : anchorRect.left - panelRect.width - gap;

  if (x + panelRect.width > vw - margin) {
    placement = "left";
    x = anchorRect.left - panelRect.width - gap;
  }
  if (x < margin) {
    placement = "right";
    x = anchorRect.right + gap;
  }
  if (x < margin || x + panelRect.width > vw - margin) {
    placement = "center";
    x = anchorRect.left + anchorRect.width / 2 - panelRect.width / 2;
  }

  const yAnchor = anchorRect.height > panelRect.height
    ? anchorRect.top + Math.min(24, anchorRect.height * 0.18)
    : anchorRect.top - 12;
  const y = clamp(yAnchor, margin, maxY);

  panel.dataset.placement = placement;
  panel.style.setProperty("--c2-modal-x", `${Math.round(clamp(x, margin, maxX))}px`);
  panel.style.setProperty("--c2-modal-y", `${Math.round(y)}px`);
}

// ── event modal ──────────────────────────────────────────────────────
// ref = "t:<dayIdx>:<timedIdx>" | "a:<dayIdx>:<alldayIdx>" from data-c2-ev.
// Find the curated transcript match for a calendar event (date + title fragment)
// and render a "session recorded" block — what was captured and whether the record
// is a public distilled recap or held privately in the vault. "" when no session
// record matches the event, so ordinary events render unchanged.
function sessionRecordHtml(day, title) {
  if (!day || !title) return "";
  const iso = isoDay(day.dayMs);
  const t = String(title).toLowerCase();
  const match = CALENDAR_TRANSCRIPT_MATCHES.find(e =>
    e && e.date === iso && Array.isArray(e.title_contains)
    && e.title_contains.some(frag => t.includes(String(frag).toLowerCase())));
  if (!match) return "";
  const sources = Array.isArray(match.sources) ? match.sources : [];
  const rows = sources.map(s => {
    const role = String(s.role || "record").replace(/_/g, " ");
    const held = s.held === "private-vault" || (!s.path && s.vault_id);
    const status = held
      ? `<span class="c2-rec-status c2-rec-held">held privately</span>`
      : `<span class="c2-rec-status c2-rec-public">distilled recap</span>`;
    const label = String(s.label || match.section || role);
    return `<li class="c2-rec-row"><span class="c2-rec-role">${escHtml(role)}</span><span class="c2-rec-label">${escHtml(label)}</span>${status}</li>`;
  }).join("");
  if (!rows) return "";
  const conf = match.confidence ? ` · ${escHtml(match.confidence)} confidence` : "";
  return `
    <div class="c2-modal-record">
      <div class="c2-rec-head">session recorded${conf}</div>
      <ul class="c2-rec-list">${rows}</ul>
      <p class="c2-rec-note">Recaps live in Context → transcripts; private records stay in the vault until cleared.</p>
    </div>`;
}

export function openCalendarEvent(ref, { anchor = null, anchorRect = null } = {}) {
  if (!_model || typeof document === "undefined") return;
  const m = String(ref || "").match(/^([ta]):(\d+):(\d+)$/);
  if (!m) return;
  const day = _model.days[+m[2]];
  if (!day) return;
  const item = (m[1] === "t" ? day.timed : day.allday)[+m[3]];
  if (!item) return;

  const weekday = DAY_NAMES_FULL[day.name] || day.name;
  const isAnchor = item.kind === "anchor";
  const title = isAnchor ? item.title : item.content.title;
  const timeLabel = item.timing
    ? `${fmtMin(item.timing.startMin)} – ${fmtMin(item.timing.endMin)}`
    : "all-day";
  const details = isAnchor
    ? (item.subtitle ? [item.subtitle] : [])
    : item.content.details;
  // Google Meet join link surfaced from the event's `Meet:` marker (events only).
  const joinHref = isAnchor ? "" : (item.content.meetUrl || "");
  const googleLink = calendarGoogleEventLinkForItem(item, _model.calendarGoogleEvents);
  // Universal "add to your calendar" link (Google TEMPLATE) — works for any subscriber,
  // unlike the admin event html_link above which needs source-calendar access.
  const addEventHref = googleAddEventUrl({
    title,
    details: isAnchor ? title : (item.block || title),
    dayMs: day.dayMs,
    timing: item.timing,
  });
  const eventAnchor = anchor || null;
  const eventAnchorRect = anchorRect || rectFromAnchor(eventAnchor);

  document.querySelector(".c2-modal")?.remove();
  clearCalendarEventSelection();
  eventAnchor?.classList?.add?.("is-selected");
  const overlay = document.createElement("div");
  overlay.className = "c2-modal";
  overlay.innerHTML = `
    <div class="c2-modal-panel" data-cat="${escAttr(item.cat.key)}" role="dialog" aria-modal="true" aria-label="event details">
      <button class="c2-modal-close" type="button" aria-label="close">×</button>
      <div class="c2-modal-meta">
        <div class="c2-modal-when">${escHtml(weekday)} · ${escHtml(day.date)} · ${escHtml(timeLabel)}</div>
        ${item.cat.label || item.cat.tbc
          ? `<div class="c2-modal-cat"><i class="c2-chip-dot" aria-hidden="true"></i>${escHtml(item.cat.label)}${item.cat.tbc ? `<i class="c2-ev-tbc">tbc</i>` : ""}</div>`
          : ""}
      </div>
      <h3 class="c2-modal-title"><em>${escHtml(title)}</em></h3>
      ${details.length ? `<ul class="c2-modal-details">${details.map(d => `<li>${escHtml(d)}</li>`).join("")}</ul>` : ""}
      ${sessionRecordHtml(day, title)}
      ${(joinHref || addEventHref || googleLink) ? `
        <div class="c2-modal-actions">
          ${joinHref ? `<a class="c2-modal-google c2-modal-join" href="${escAttr(joinHref)}" data-external>
            <span class="c2-action-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>
              </svg>
            </span>
            <span class="c2-action-copy"><strong>join event</strong><small>Google Meet</small></span>
          </a>` : ""}
          ${addEventHref ? `<a class="c2-modal-google" href="${escAttr(addEventHref)}" data-external>
            <span class="c2-action-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v5"/><path d="M9.5 16.5h5"/>
              </svg>
            </span>
            <span class="c2-action-copy"><strong>add to Google</strong><small>personal calendar</small></span>
          </a>` : ""}
          ${googleLink ? `<a class="c2-modal-google c2-modal-google--open" href="${escAttr(googleLink)}" data-external>
            <span class="c2-action-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              </svg>
            </span>
            <span class="c2-action-copy"><strong>open in Google</strong><small>source event</small></span>
          </a>` : ""}
        </div>` : ""}
    </div>`;
  const close = () => {
    clearCalendarEventSelection();
    document.removeEventListener("keydown", onKey);
    if (overlay.dataset.closing === "1") return;
    overlay.dataset.closing = "1";
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        || document.documentElement.getAttribute("data-reduce-motion") === "1";
    } catch {}
    if (reduce) { overlay.remove(); return; }
    // Fade/scale the panel out (faster than the open), then drop it — with a
    // timeout backstop so the node is never orphaned if animationend misfires.
    overlay.classList.add("is-closing");
    const done = () => { try { overlay.remove(); } catch {} };
    overlay.addEventListener("animationend", done, { once: true });
    setTimeout(done, 180);
  };
  function onKey(e) { if (e.key === "Escape") close(); }
  overlay.addEventListener("click", (e) => {
    const external = e.target?.closest?.("a[data-external]");
    if (external) {
      e.preventDefault();
      e.stopPropagation();
      const url = external.getAttribute("href");
      if (url && url !== "#") {
        try { window.api?.openExternal?.(url); } catch {}
      }
      return;
    }
    if (e.target === overlay) close();
  });
  overlay.querySelector(".c2-modal-close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  positionEventPanel(overlay, eventAnchorRect);
  overlay.querySelector(".c2-modal-close")?.focus?.({ preventScroll: true });
}

// ── shipped-chip reveal ──────────────────────────────────────────────
// ref = "<dayIdx>:<activityIdx>" from a shipped chip's data-c2-act. Shows WHAT
// shipped, in place (same overlay as an event) — a single click no longer
// teleports off the calendar. The drill to the team dossier is now an explicit,
// secondary button (onOpenTeam callback), so the team page is one deliberate
// click away rather than the unavoidable consequence of touching the chip.
export function openCalendarActivity(ref, { anchor = null, anchorRect = null, onOpenTeam = null } = {}) {
  if (!_model || typeof document === "undefined") return;
  const m = String(ref || "").match(/^(\d+):(\d+)$/);
  if (!m) return;
  const day = _model.days[+m[1]];
  if (!day) return;
  const item = (day.activity || [])[+m[2]];
  if (!item) return;

  const weekday = DAY_NAMES_FULL[day.name] || day.name;
  const VERB = { release: "shipped", commit: "committed" };
  const verb = VERB[item.kind] || item.kind;
  const eventAnchor = anchor || null;
  const eventAnchorRect = anchorRect || rectFromAnchor(eventAnchor);

  document.querySelector(".c2-modal")?.remove();
  clearCalendarEventSelection();
  eventAnchor?.classList?.add?.("is-selected");
  const overlay = document.createElement("div");
  overlay.className = "c2-modal";
  overlay.innerHTML = `
    <div class="c2-modal-panel c2-modal-panel--act" data-act-kind="${escAttr(item.kind)}" role="dialog" aria-modal="true" aria-label="activity details">
      <button class="c2-modal-close" type="button" aria-label="close">×</button>
      <div class="c2-modal-meta">
        <div class="c2-modal-when">${escHtml(weekday)} · ${escHtml(day.date)}</div>
        <div class="c2-modal-cat"><i class="c2-act-dot" aria-hidden="true"></i>${escHtml(verb)}</div>
      </div>
      <h3 class="c2-modal-title"><em>${escHtml(item.team || "a team")}</em></h3>
      ${item.label ? `<p class="c2-modal-actlabel">${escHtml(item.label)}</p>` : ""}
      ${item.recordId && typeof onOpenTeam === "function" ? `
        <div class="c2-modal-actions">
          <button class="c2-modal-team" type="button" data-open-team="${escAttr(item.recordId)}">
            <span class="c2-action-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
              </svg>
            </span>
            <span class="c2-action-copy"><strong>open ${escHtml(item.team || "team")}</strong><small>team dossier</small></span>
          </button>
        </div>` : ""}
    </div>`;
  const close = () => {
    clearCalendarEventSelection();
    document.removeEventListener("keydown", onKey);
    if (overlay.dataset.closing === "1") return;
    overlay.dataset.closing = "1";
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        || document.documentElement.getAttribute("data-reduce-motion") === "1";
    } catch {}
    if (reduce) { overlay.remove(); return; }
    overlay.classList.add("is-closing");
    const done = () => { try { overlay.remove(); } catch {} };
    overlay.addEventListener("animationend", done, { once: true });
    setTimeout(done, 180);
  };
  function onKey(e) { if (e.key === "Escape") close(); }
  overlay.addEventListener("click", (e) => {
    const openTeam = e.target?.closest?.("[data-open-team]");
    if (openTeam) {
      e.preventDefault();
      const rid = openTeam.getAttribute("data-open-team");
      close();
      if (rid) { try { onOpenTeam(rid); } catch {} }
      return;
    }
    if (e.target === overlay) close();
  });
  overlay.querySelector(".c2-modal-close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  positionEventPanel(overlay, eventAnchorRect);
  overlay.querySelector(".c2-modal-close")?.focus?.({ preventScroll: true });
}

// Reveal a subscribed-row item. release/commit/team items drill to the team
// dossier (same secondary "open team →" as the shipped reveal); a transcript item
// shows its public anchor (the body is held in the private vault). Reads the
// clicked item back from _model.rows so every row kind shares one click path.
export function openCalendarRowItem(ref, { anchor = null, anchorRect = null, onOpenTeam = null } = {}) {
  if (!_model || typeof document === "undefined") return;
  const m = String(ref || "").match(/^(\d+):(\d+):(\d+)$/);
  if (!m) return;
  const row = (_model.rows || [])[+m[1]];
  const day = _model.days[+m[2]];
  const item = row?.perDay?.[+m[2]]?.items?.[+m[3]];
  if (!row || !day || !item) return;

  const weekday = DAY_NAMES_FULL[day.name] || day.name;
  const VERB = { release: "shipped", commit: "committed", transcript: "recorded" };
  const verb = VERB[item.kind] || item.kind;
  const isTranscript = item.kind === "transcript";
  const titleLine = isTranscript ? (item.title || item.label || "session") : (item.team || row.label || "a team");
  const eventAnchor = anchor || null;
  const eventAnchorRect = anchorRect || rectFromAnchor(eventAnchor);

  document.querySelector(".c2-modal")?.remove();
  clearCalendarEventSelection();
  eventAnchor?.classList?.add?.("is-selected");
  const overlay = document.createElement("div");
  overlay.className = "c2-modal";
  overlay.innerHTML = `
    <div class="c2-modal-panel c2-modal-panel--act" data-act-kind="${escAttr(item.kind)}" role="dialog" aria-modal="true" aria-label="row item details">
      <button class="c2-modal-close" type="button" aria-label="close">×</button>
      <div class="c2-modal-meta">
        <div class="c2-modal-when">${escHtml(weekday)} · ${escHtml(day.date)}</div>
        <div class="c2-modal-cat"><i class="c2-act-dot" aria-hidden="true"></i>${escHtml(verb)}</div>
      </div>
      <h3 class="c2-modal-title"><em>${escHtml(titleLine)}</em></h3>
      ${!isTranscript && item.label ? `<p class="c2-modal-actlabel">${escHtml(item.label)}</p>` : ""}
      ${isTranscript ? `<p class="c2-modal-actlabel">${escHtml(item.label || "")}${item.sourceCount ? ` · ${item.sourceCount} source${item.sourceCount === 1 ? "" : "s"}` : ""}${item.confidence ? ` · ${escHtml(item.confidence)} confidence` : ""}</p>` : ""}
      ${item.recordId && typeof onOpenTeam === "function" ? `
        <div class="c2-modal-actions">
          <button class="c2-modal-team" type="button" data-open-team="${escAttr(item.recordId)}">
            <span class="c2-action-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </span>
            <span class="c2-action-copy"><strong>open ${escHtml(item.team || row.label || "team")}</strong><small>team dossier</small></span>
          </button>
        </div>` : ""}
    </div>`;
  const close = () => {
    clearCalendarEventSelection();
    document.removeEventListener("keydown", onKey);
    if (overlay.dataset.closing === "1") return;
    overlay.dataset.closing = "1";
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        || document.documentElement.getAttribute("data-reduce-motion") === "1";
    } catch {}
    if (reduce) { overlay.remove(); return; }
    overlay.classList.add("is-closing");
    const done = () => { try { overlay.remove(); } catch {} };
    overlay.addEventListener("animationend", done, { once: true });
    setTimeout(done, 180);
  };
  function onKey(e) { if (e.key === "Escape") close(); }
  overlay.addEventListener("click", (e) => {
    const openTeam = e.target?.closest?.("[data-open-team]");
    if (openTeam) {
      e.preventDefault();
      const rid = openTeam.getAttribute("data-open-team");
      close();
      if (rid) { try { onOpenTeam(rid); } catch {} }
      return;
    }
    if (e.target === overlay) close();
  });
  overlay.querySelector(".c2-modal-close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  positionEventPanel(overlay, eventAnchorRect);
  overlay.querySelector(".c2-modal-close")?.focus?.({ preventScroll: true });
}

// ── in-town hover/focus reveal ────────────────────────────────────────
// The third layer for the presence signal: glance reads the bar + count, this
// reveal names WHO is in town that day and places the week in the residency's
// occupancy arc (a week-by-week sparkline). Display-only (pointer-events:none),
// so it never traps the pointer; click on the cell commits to the presence view.
let _inTownPop = null;
export function closeCalendarInTown() {
  if (_inTownPop) { try { _inTownPop.remove(); } catch {} _inTownPop = null; }
}
export function openCalendarInTown(ref, { anchor = null } = {}) {
  if (!_model || !_model.inTown || typeof document === "undefined") return;
  const di = Number(ref);
  const it = _model.inTown;
  const day = it.days[di];
  if (!day) return;
  const s = (it.perDay || [])[di] || {};
  const n = Number(s.inTown) || 0;
  const names = Array.isArray(s.inTownNames) ? s.inTownNames : [];
  const total = it.rosterTotal || Math.max(1, n);
  const weekday = DAY_NAMES_FULL[day.name] || day.name;
  const dateNum = String(day.date).replace(/^[a-z]+\s+/, "");

  // sparkline — weekly occupancy across the residency, current week accented.
  const weekly = Array.isArray(it.weekly) ? it.weekly : [];
  let spark = "";
  if (weekly.length) {
    const W = 132, H = 26, gap = 2;
    const bw = (W - gap * (weekly.length - 1)) / weekly.length;
    const maxFrac = Math.max(0.001, ...weekly.map(w => w.frac || 0));
    const bars = weekly.map((w, i) => {
      const h = Math.max(1.5, (Math.max(0, w.frac || 0) / maxFrac) * (H - 2));
      const x = i * (bw + gap);
      return `<rect class="c2-spark-bar${w.isCurrent ? " is-current" : ""}" x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1"></rect>`;
    }).join("");
    spark = `<div class="c2-pop-spark"><svg class="c2-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${bars}</svg><span class="c2-pop-sparklabel">in town · weeks 1–${weekly.length}</span></div>`;
  }

  const CAP = 24;
  const shown = names.slice(0, CAP);
  const moreCount = names.length - shown.length;
  const nameCloud = names.length
    ? `<div class="c2-pop-names">${shown.map(x => `<span>${escHtml(x)}</span>`).join("")}${moreCount > 0 ? `<span class="c2-pop-more">+${moreCount} more</span>` : ""}</div>`
    : `<div class="c2-pop-empty">nobody in town this day</div>`;

  closeCalendarInTown();
  const pop = document.createElement("div");
  pop.className = "c2-sig-pop";
  pop.innerHTML = `
    <div class="c2-pop-head"><em>${escHtml(weekday)} ${escHtml(dateNum)}</em> · <strong>${n}</strong> of ${total} in town${it.scopeName && it.scopeName !== "all cohort" ? ` · ${escHtml(it.scopeName)}` : ""}</div>
    ${spark}
    ${nameCloud}`;
  document.body.appendChild(pop);
  _inTownPop = pop;

  // Position below the anchor, clamped to the viewport; flip above if it'd clip.
  try {
    const r = anchor?.getBoundingClientRect?.();
    if (r) {
      const vw = window.innerWidth || 1024, vh = window.innerHeight || 768, margin = 10;
      const pr = pop.getBoundingClientRect();
      let x = r.left + r.width / 2 - pr.width / 2;
      x = Math.max(margin, Math.min(x, vw - pr.width - margin));
      let y = r.bottom + 8;
      if (y + pr.height > vh - margin) y = r.top - pr.height - 8;
      pop.style.left = `${Math.round(x)}px`;
      pop.style.top = `${Math.round(Math.max(margin, y))}px`;
    }
  } catch {}
}

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
  CALENDAR_URL,
} from "@shape-rotator/shape-ui";

const PRIMARY_TAB = "May 18 Start";
const WEEK_COUNT  = 10;
// Public read-only mirror that cohort members/guests subscribe to (guest calendar mirror, PR #361).
// This is the only calendar a public subscribe/link should target; the admin/source calendar
// (GOOGLE_CALENDAR_ID) is intentionally NOT referenced in this public renderer.
const GUEST_GOOGLE_CALENDAR_ID = "c_230102e62c5e01faa500a92c44251088210cd1f1949dfa9aff3ab11280261d8c@group.calendar.google.com";

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

export function managedGoogleCalendarUrl(calendarId = GUEST_GOOGLE_CALENDAR_ID) {
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

function addGoogleOnlyManagedEvents(days = [], calendarGoogleEvents = {}, seenShapeKeys = new Set()) {
  const dayByIso = new Map(days.map((day) => [isoDay(day.dayMs), day]));
  const records = Object.values(calendarGoogleEvents?.by_shape_key || {});
  for (const record of records) {
    const shapeKey = googleRecordShapeKey(record);
    if (!shapeKey || seenShapeKeys.has(shapeKey)) continue;
    const day = dayByIso.get(googleRecordStartIso(record));
    if (!day) continue;
    const block = googleRecordBlockText(record);
    const timing = googleRecordTiming(record);
    const blockIndex = Number(record.shape_calendar_block_index) || 1;
    const item = {
      kind: "event",
      block,
      content: c2ParseBlock(block),
      cat: c2Category(block),
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
  { key: "weekly",  label: "sr weekly",      re: /\bweekly\b|what did you do/i },
  { key: "coord",   label: "coordination",   re: /coordinat|attribution/i },
  { key: "hack",    label: "hacking",        re: /\bhack|hackathon|open jam|\bfinals\b|submission|build night/i },
  { key: "anarchy", label: "self-organized", re: /anarchy|self-organ|no .*program|protected build|team-led/i },
];
const C2_LEGEND = [
  { key: "oh",     label: "office hours" },
  { key: "salon",  label: "salon" },
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

// Parse one cell block into { time, title, details[] } for cards + modal.
function c2ParseBlock(block) {
  const lines = (block || "").split("\n").map(l => l.replace(/\s+$/, "")).filter(l => l.trim());
  const first = (lines[0] || "").trim();
  let { time, rest } = c2SplitLeadingTime(first);
  let title = rest;
  const details = lines.slice(1).map(l => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);
  // First line was JUST a time ("12:00 - 14:00") — the real title is the
  // next line. Never show the time twice (the card renders time separately).
  if (!title && details.length) title = details.shift();
  if (!title && time) { title = time; time = ""; }
  if (!title) title = first.replace(/^[-•*]\s+/, "");
  return { time, title, details };
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

// ── render ───────────────────────────────────────────────────────────
// view: "cal" (the timeline grid) | "presence" (caller-supplied availability
// gantt — the same renderer the legacy calendar page uses, passed in as
// presenceHtml so this module stays presentation-only).
export function renderCalendarPage({ data, calendarGoogleEvents = {}, weekIdx = 0, source = null, view = "cal", presenceHtml = "" } = {}) {
  const tab = data?.tabs?.[PRIMARY_TAB] || [];
  const safeWeekIdx = Math.max(0, Math.min(WEEK_COUNT - 1, weekIdx | 0));
  const week = parseWeekRow(tab[2 + safeWeekIdx] || [], safeWeekIdx);
  const phase = phaseFor(safeWeekIdx + 1);
  const recurring = parseRecurring(tab);

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
      const timing = c2BlockTiming(block);
      const blockNumber = blockIndex + 1;
      const shapeKey = calendarShapeKey(baseUid, blockNumber);
      seenShapeKeys.add(shapeKey);
      const item = {
        kind: "event",
        block,
        content: c2ParseBlock(block),
        cat: c2Category(block),
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

  addGoogleOnlyManagedEvents(days, calendarGoogleEvents, seenShapeKeys);
  for (const day of days) layoutTimed(day.timed);

  _model = { days, weekIdx: safeWeekIdx, calendarGoogleEvents };

  // ── hour window hugs the week's actual content ──────────────────────
  // No fixed 8–22 frame: the grid starts at the first event's hour and
  // ends at the last one's, so sparse mornings/nights don't render as
  // dead rows. A 6-hour floor keeps a near-empty week from blowing the
  // hour height up; an event-free week falls back to 9–18.
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const d of days) {
    for (const ev of d.timed) {
      minStart = Math.min(minStart, ev.timing.startMin);
      maxEnd   = Math.max(maxEnd, ev.timing.endMin);
    }
  }
  let winStart, winEnd;
  if (!Number.isFinite(minStart)) {
    winStart = 9 * 60;
    winEnd   = 18 * 60;
  } else {
    winStart = Math.max(0, Math.floor(minStart / 60) * 60);
    winEnd   = Math.min(24 * 60, Math.ceil(maxEnd / 60) * 60);
  }
  const MIN_SPAN = 2 * 60;
  if (winEnd - winStart < MIN_SPAN) winEnd = Math.min(24 * 60, winStart + MIN_SPAN);
  if (winEnd - winStart < MIN_SPAN) winStart = Math.max(0, winEnd - MIN_SPAN);

  // ── compress event-free hours ────────────────────────────────────────
  // A sparse week on a linear axis is mostly dead air. Instead: hours that
  // contain at least one event (anywhere in the week) render full-height;
  // runs of 2+ empty hours collapse into a thin "open" band. The remaining
  // active hours stretch to fill the board, so quiet weeks still read
  // dense. Single empty hours between busy ones stay linear — collapsing
  // those would make the axis feel choppy.
  const hourCount = Math.round((winEnd - winStart) / 60);
  const occ = new Array(hourCount).fill(false);
  for (const d of days) {
    for (const ev of d.timed) {
      const h0 = Math.max(0, Math.floor((ev.timing.startMin - winStart) / 60));
      const h1 = Math.min(hourCount - 1, Math.floor((Math.min(ev.timing.endMin, winEnd) - 1 - winStart) / 60));
      for (let h = h0; h <= h1; h++) occ[h] = true;
    }
  }
  if (!occ.some(Boolean)) occ.fill(true);
  for (let h = 1; h < hourCount - 1; h++) {
    if (!occ[h] && occ[h - 1] && occ[h + 1]) occ[h] = true;
  }

  const segs = [];
  for (let h = 0; h < hourCount;) {
    const act = occ[h];
    let j = h;
    while (j < hourCount && occ[j] === act) j++;
    segs.push({ act, s: winStart + h * 60, e: winStart + j * 60, units: act ? (j - h) : 0 });
    h = j;
  }
  // Collapsed gaps stay a thin sliver of the board no matter how sparse
  // the week is — sized relative to the active hours, not absolutely.
  const actUnits = segs.reduce((a, s) => a + (s.act ? s.units : 0), 0);
  const gapUnits = Math.min(0.8, Math.max(0.3, actUnits * 0.1));
  for (const s of segs) { if (!s.act) s.units = gapUnits; }
  const totalUnits = segs.reduce((a, s) => a + s.units, 0);
  let accUnits = 0;
  for (const s of segs) {
    s.y0 = (accUnits / totalUnits) * 100;
    accUnits += s.units;
    s.y1 = (accUnits / totalUnits) * 100;
  }
  const yPct = (min) => {
    if (min <= winStart) return 0;
    for (const s of segs) {
      if (min >= s.s && min <= s.e) return s.y0 + (s.y1 - s.y0) * ((min - s.s) / (s.e - s.s));
    }
    return 100;
  };
  const pct = (min) => yPct(min).toFixed(3);
  // Serialized for attachCalendarPageBehavior's now-line tick (same mapping).
  const segsJson = JSON.stringify(segs.map(s => ({
    s: s.s, e: s.e, y0: +s.y0.toFixed(4), y1: +s.y1.toFixed(4),
  })));

  // ── masthead — shared view-nav tabs on top, unified week strip
  // (← 1 2 … 10 →) centered below. The current week (the one containing
  // today) carries a white outline; the selected week fills. The strip
  // only shows on the calendar view — presence spans the whole program,
  // so weeks don't apply.
  const nowWeekIdx = currentWeekIdx();
  const scrubDots = Array.from({ length: WEEK_COUNT }, (_, i) => `
    <button class="c2-scrub-dot${i === nowWeekIdx ? " is-now" : ""}" data-c2-week="${i}"
            aria-selected="${i === safeWeekIdx}" aria-label="week ${i + 1}" type="button">${i + 1}</button>`).join("");

  const isPresence = view === "presence";
  // Same shared view-nav component as the cohort / context / program pages
  // (.alch-page-views) — one visual language for in-page tabs everywhere.
  const viewTabs = `
    <nav class="alch-page-views" role="tablist" aria-label="calendar view">
      <button class="alch-page-view-btn" data-c2-view="cal" role="tab" aria-selected="${!isPresence}" type="button">
        <span class="apv-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg></span><span class="apv-label">calendar</span>
      </button>
      <button class="alch-page-view-btn" data-c2-view="presence" role="tab" aria-selected="${isPresence}" type="button">
        <span class="apv-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></svg></span><span class="apv-label">presence</span>
      </button>
    </nav>`;
  const subscribeAction = `
    <a class="c2-subscribe" href="${escAttr(managedGoogleCalendarUrl(GUEST_GOOGLE_CALENDAR_ID))}" data-external
       aria-label="Subscribe to the read-only Shape Rotator Google Calendar"
       title="Subscribe to the read-only Shape Rotator Google Calendar">
      <span class="c2-subscribe-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v5"/><path d="M9.5 16.5h5"/>
        </svg>
      </span>
      <span class="c2-subscribe-copy"><strong>subscribe</strong><small>read-only Google</small></span>
    </a>`;
  const masthead = `
    <div class="c2-toolbar">
      ${viewTabs}
      ${subscribeAction}
    </div>
    ${isPresence ? "" : `
    <header class="c2-masthead">
      <div class="c2-scrub" role="tablist" aria-label="program week">
        <button class="c2-scrub-arrow" data-c2-nav="prev" aria-label="previous week" ${safeWeekIdx === 0 ? "disabled" : ""} type="button">←</button>
        ${scrubDots}
        <button class="c2-scrub-arrow" data-c2-nav="next" aria-label="next week" ${safeWeekIdx === WEEK_COUNT - 1 ? "disabled" : ""} type="button">→</button>
      </div>
    </header>`}`;

  if (isPresence) {
    return `
      <section class="c2" data-phase="${escAttr(phase)}">
        ${masthead}
        <div class="c2-presence">
          ${presenceHtml || `<div class="c2-loading">presence view not available.</div>`}
        </div>
      </section>`;
  }

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

  // ── day headers ──────────────────────────────────────────────────────
  const headCells = days.map((d) => `
      <div class="c2-dayhead ${d.isToday ? "is-today" : ""}" role="columnheader" ${d.isToday ? 'aria-current="date"' : ""}>
        <span class="c2-dh-name">${escHtml(d.name)}</span>
        <span class="c2-dh-num">${escHtml(d.date.replace(/^[a-z]+\s+/, ""))}</span>
      </div>`).join("");

  // ── all-day lane (only when something is in it) ──────────────────────
  const hasAllday = days.some(d => d.allday.length);
  const alldayRow = hasAllday ? `
    <div class="c2-row c2-allday">
      <div class="c2-gutter-cell">all-day</div>
      ${days.map((d, di) => `
        <div class="c2-allday-cell ${d.isToday ? "is-today" : ""}">
          ${d.allday.map((item, ai) => {
            const googleLink = calendarGoogleEventLinkForItem(item, calendarGoogleEvents);
            return `
            <button class="c2-chip${googleLink ? " has-google-link" : ""}" data-cat="${escAttr(item.cat.key)}" data-c2-ev="a:${di}:${ai}" type="button"
                    title="${escAttr(item.kind === "anchor" ? item.title : item.content.title)}">
              <span class="c2-chip-dot" aria-hidden="true"></span>
              <span class="c2-chip-label">${escHtml(item.kind === "anchor" ? item.title : item.content.title)}</span>
            </button>`;
          }).join("")}
        </div>`).join("")}
    </div>` : "";

  // ── hour gutter + hairlines + collapsed-gap bands ────────────────────
  // Hour boundaries only exist inside active segments now, so lines and
  // labels are emitted per-boundary instead of via a repeating background.
  const boundaries = [];
  for (const s of segs) {
    if (!s.act) continue;
    for (let m = s.s; m <= s.e; m += 60) {
      if (!boundaries.includes(m)) boundaries.push(m);
    }
  }
  const hourLabels = boundaries.map((m) => {
    const y = yPct(m);
    const edge = y < 0.5 ? " is-first" : y > 99.5 ? " is-last" : "";
    return `<span class="c2-hour${edge}" style="top:${y.toFixed(3)}%">${fmtMin(m)}</span>`;
  }).join("");
  const hourLines = boundaries.map((m) =>
    `<i class="c2-line" style="top:${pct(m)}%"></i>`).join("");
  const skipBands = segs.filter(s => !s.act).map(s => `
    <div class="c2-skip" style="top:${s.y0.toFixed(3)}%;height:${(s.y1 - s.y0).toFixed(3)}%">
      <span class="c2-skip-label">${fmtMin(s.s)} – ${fmtMin(s.e)} · open</span>
    </div>`).join("");

  // ── day columns with positioned events ──────────────────────────────
  // Whatever a day doesn't schedule gets tiled with quiet "open" blocks —
  // the board is always a full mosaic, never bare grid. Unscheduled time
  // in the residency is build time, so the tiles say so.
  const isWeekend = (name) => name === "sat" || name === "sun";
  const cols = days.map((d, di) => {
    const busy = d.timed
      .map(ev => [ev.timing.startMin, Math.min(ev.timing.endMin, winEnd)])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of busy) {
      if (merged.length && s <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else merged.push([s, e]);
    }
    const freePieces = [];
    for (const seg of segs) {
      if (!seg.act) continue;
      let cur = seg.s;
      for (const [s, e] of merged) {
        if (e <= seg.s || s >= seg.e) continue;
        if (s > cur) freePieces.push([cur, Math.min(s, seg.e)]);
        cur = Math.max(cur, e);
      }
      if (cur < seg.e) freePieces.push([cur, seg.e]);
    }
    const freeBlocks = freePieces.map(([s, e]) => {
      const top = yPct(s);
      const h = yPct(e) - yPct(s);
      if (h < 2.5) return "";
      const label = h >= 7 ? `<span class="c2-free-label">open</span>` : "";
      return `<div class="c2-free" aria-hidden="true" style="top:${top.toFixed(3)}%;height:${h.toFixed(3)}%">${label}</div>`;
    }).join("");
    const evs = d.timed.map((ev, ti) => {
      const top = pct(ev.timing.startMin);
      const bottom = Math.min(ev.timing.endMin, winEnd);
      const height = (yPct(bottom) - yPct(ev.timing.startMin)).toFixed(3);
      const left = ((ev.col / ev.cols) * 100).toFixed(2);
      const width = (100 / ev.cols).toFixed(2);
      const timeLabel = `${fmtMin(ev.timing.startMin)} – ${fmtMin(ev.timing.endMin)}`;
      // Details ride along in the card and reveal when the rendered card
      // is tall enough (container query in CSS) — no click needed.
      const shownDetails = ev.content.details.slice(0, 6);
      const moreCount = ev.content.details.length - shownDetails.length;
      const googleLink = calendarGoogleEventLinkForItem(ev, calendarGoogleEvents);
      const body = shownDetails.length
        ? `<span class="c2-ev-body">${shownDetails.map(t => `<i>${escHtml(t)}</i>`).join("")}${moreCount > 0 ? `<i class="c2-ev-more">+${moreCount} more</i>` : ""}</span>`
        : "";
      return `
        <button class="c2-ev${ev.cat.tbc ? " is-tbc" : ""}${googleLink ? " has-google-link" : ""}" data-cat="${escAttr(ev.cat.key)}"
                data-c2-ev="t:${di}:${ti}" type="button"
                style="top:${top}%;height:${height}%;left:${left}%;width:calc(${width}% - 2px)"
                aria-label="${escAttr(`${timeLabel} ${ev.content.title}`)}">
          <span class="c2-ev-in">
            <span class="c2-ev-time">${escHtml(timeLabel)}${ev.cat.tbc ? `<i class="c2-ev-tbc">tbc</i>` : ""}</span>
            <span class="c2-ev-title">${escHtml(ev.content.title)}</span>
            ${body}
          </span>
        </button>`;
    }).join("");
    const nowLine = d.isToday ? `<div class="c2-now" aria-hidden="true"><i class="c2-now-dot"></i></div>` : "";
    return `
      <div class="c2-col ${d.isToday ? "is-today" : ""} ${isWeekend(d.name) ? "is-weekend" : ""}" data-day="${di}">
        ${freeBlocks}${evs}${nowLine}
      </div>`;
  }).join("");

  // ── recurring footer + legend ────────────────────────────────────────
  const legend = `
    <div class="c2-key" role="list" aria-label="event categories">
      ${C2_LEGEND.map(c => `<span class="c2-key-item" data-cat="${escAttr(c.key)}"><i class="c2-chip-dot" aria-hidden="true"></i>${escHtml(c.label)}</span>`).join("")}
    </div>`;
  const recurringHtml = recurring.length ? `
    <div class="c2-recur">
      <span class="c2-recur-h">recurring</span>
      ${recurring.map(r => `<span class="c2-recur-item">${escHtml(r.what)}</span>`).join("")}
    </div>` : "";

  return `
    <section class="c2" data-phase="${escAttr(phase)}">
      ${masthead}
      ${staleBanner}
      <div class="c2-board" role="grid" aria-label="week timeline">
        <div class="c2-row c2-daysbar">
          <div class="c2-gutter-cell"></div>
          ${headCells}
        </div>
        ${alldayRow}
        <div class="c2-scroll">
          <div class="c2-grid" style="--c2-units:${totalUnits.toFixed(2)}" data-c2-segs="${escAttr(segsJson)}">
            <div class="c2-hours">${hourLabels}</div>
            ${cols}
            <div class="c2-rules" aria-hidden="true">${hourLines}</div>
            <div class="c2-skips" aria-hidden="true">${skipBands}</div>
          </div>
        </div>
      </div>
      <footer class="c2-foot">
        ${legend}
        ${recurringHtml}
        <div class="c2-source">
          <span>source · <a href="${escAttr(CALENDAR_URL)}" data-external>os-web.shaperotator.xyz/calendar.json</a></span>
          <span aria-hidden="true">·</span>
          <span>cohort may 18 → jul 26 2026</span>
        </div>
      </footer>
    </section>`;
}

// ── behavior — now-line tick + initial scroll ────────────────────────
// Returns a teardown fn; the consumer calls it before every repaint so
// intervals don't stack (same contract as attachWeekViewBehavior).
export function attachCalendarPageBehavior(root, { scrollToNow = true } = {}) {
  if (!root) return () => {};
  const grid = root.querySelector(".c2-grid");
  const scroll = root.querySelector(".c2-scroll");
  if (!grid) return () => {};
  // Piecewise time→y mapping serialized by the renderer — the axis is
  // non-linear (collapsed gaps), so the tick must use the same segments.
  let segs = [];
  try { segs = JSON.parse(grid.dataset.c2Segs || "[]"); } catch {}

  let placedOnce = false;
  function placeNow() {
    const line = grid.querySelector(".c2-now");
    if (!line) return;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    const seg = segs.find(s => m >= s.s && m <= s.e);
    if (!seg) { line.style.display = "none"; return; }
    line.style.display = "";
    line.style.top = (seg.y0 + (seg.y1 - seg.y0) * ((m - seg.s) / (seg.e - seg.s))).toFixed(3) + "%";
    // Enable the eased glide only AFTER the first placement, so the line
    // doesn't slide in from top:0 on mount.
    if (placedOnce) line.classList.add("is-tracking");
    placedOnce = true;
  }
  placeNow();
  const timer = setInterval(placeNow, 30000);

  if (scrollToNow && scroll) {
    requestAnimationFrame(() => {
      const line = grid.querySelector(".c2-now");
      if (line && line.style.display !== "none") {
        // Park the now-line a third of the way down the viewport so the next
        // few hours are what the eye lands on — gliding it into view rather
        // than jumping (honors reduced-motion via the smooth/auto switch).
        let reduce = false;
        try {
          reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            || document.documentElement.getAttribute("data-reduce-motion") === "1";
        } catch {}
        const top = Math.max(0, line.offsetTop - scroll.clientHeight * 0.35);
        try { scroll.scrollTo({ top, behavior: reduce ? "auto" : "smooth" }); }
        catch { scroll.scrollTop = top; }
      }
    });
  }

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
      ${(addEventHref || googleLink) ? `
        <div class="c2-modal-actions">
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

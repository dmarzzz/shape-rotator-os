// cohort-calendar-week.js — the "broadsheet week" calendar surface used
// by both Shape Rotator OS and the sibling web app.
//
// Pure HTML-string renderer. Consumers handle data loading (live URL with
// bundled fallback), state, and event delegation. The shape mirrors how
// cohort-card.js works — strings out, hooks attached by the consumer.
//
// Data source: the JSON shipped at the Phala URL embedded below (also
// mirrored into the surface bundle every 30 minutes by the calendar-sync
// GitHub Action — see scripts/sync-calendar.js).
//
// Shape of the JSON:
//   {
//     last_refresh: "<ISO datetime>",
//     tabs: {
//       "May 18 Start": [
//         <header row>,
//         <meta row>,
//         <10 week rows: [weekNum, "dates\n\ntheme", Mon..Sun, onsite, fb, notes]>,
//         <recurring rows from index 12 onward>
//       ],
//       "Weekly Themes": [...]
//     }
//   }
//
// API:
//   CALENDAR_URL                      — public Phala endpoint
//   PROGRAM_START_MS / PROGRAM_END_MS — cohort window
//   currentWeekIdx()                  — 0..9 clamped
//   phaseFor(week1Based)              — "m1" | "m2" | "m3"
//   parseWeekRow(row, weekIdx, eventsByDayMs) — { theme, dateRange, days, ... }
//   parseRecurring(rows)              — [{ when, what }]
//   renderWeekView({ data, weekIdx, dayIdx, sub, source, events }) — HTML string
//   renderSkeletonWeek()              — HTML string; ghost of the week layout shown while data loads
//
// Three sub-views via `sub`:
//   "day"       — full-width typeset agenda of one day. Default when the
//                 calendar tab first mounts. Past events dim; the next event
//                 carries an "up next" cue; an event in progress carries
//                 "happening now". Day pills above let users peek at other
//                 days within the same week without leaving day view.
//   "week"      — 7-column broadsheet grid with horizontal scroll. Each day
//                 column has a min-width so event titles always read; today
//                 auto-scrolls into view on mount.
//   "presence"  — caller-supplied (the availability gantt lives in the
//                 consuming app, not in this shared module).

import { escHtml, escAttr } from "./escape.js";

export const CALENDAR_URL = "https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/cadence/calendar.json";

const PRIMARY_TAB     = "May 18 Start";
const COHORT_START_MS = Date.UTC(2026, 4, 18);                // mon may 18 2026
const COHORT_END_MS   = Date.UTC(2026, 6, 26);                // sun jul 26 2026
const WEEK_COUNT      = 10;

export const PROGRAM_START_MS = COHORT_START_MS;
export const PROGRAM_END_MS   = COHORT_END_MS;

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES_FULL = {
  mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday",
  fri: "friday", sat: "saturday", sun: "sunday",
};

// ── time helpers ─────────────────────────────────────────────────────
function todayUtcMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Fraction of the day elapsed (local time), clamped to [0, 1].
// Used to position the "now" line within today's day cell.
function nowFraction() {
  const d = new Date();
  return Math.min(1, Math.max(0, (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400));
}
function fmtShortDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}
function fmtSyncStamp(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }).toLowerCase();
  } catch { return null; }
}
function isoToDayMs(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function currentWeekIdx(nowMs = Date.now()) {
  const days = Math.floor((nowMs - COHORT_START_MS) / 86400000);
  return Math.max(0, Math.min(WEEK_COUNT - 1, Math.floor(days / 7)));
}

export function phaseFor(week1Based) {
  if (week1Based <= 4) return "m1";
  if (week1Based <= 9) return "m2";
  return "m3";
}

function ordinal(n) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[n] || String(n);
}

// ── parsing ──────────────────────────────────────────────────────────

// Strip the redundant "Mon May 18:" header line that the upstream cell
// often leads with — the column header already names the day.
function stripDayHeader(text, dayName) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines[0] && new RegExp("^" + dayName + "[a-z]* \\w+ \\d+:?\\s*$", "i").test(lines[0].trim())) {
    return lines.slice(1).join("\n").trimStart();
  }
  return text;
}

// Bold HH:MM and HH:MM[-–—:]HH:MM occurrences. Operates on already-escaped
// HTML so the wrap stays safe.
function boldTimes(htmlSafe) {
  return htmlSafe.replace(/(\d{1,2}:\d{2}(?:\s*[-–—:]\s*\d{1,2}:\d{2})?)/g, '<strong>$1</strong>');
}

// Split a title line that leads with a time range into { time, rest }.
// e.g. "12:00-14:00 onsite kickoff" → { time: "12:00–14:00", rest: "onsite kickoff" }
//      "19:00 founder & sorting hat" → { time: "19:00",       rest: "founder & sorting hat" }
//      "team check-in"               → { time: "",            rest: "team check-in" }
// The upstream data is inconsistent about separators (`-`, `–`, `—`, even
// `:`), and sometimes uses "12:00:14:00" as a range. Normalize all those
// to an en-dash for display while keeping the original string available
// to boldTimes for the title fallback.
function splitLeadingTime(line) {
  const range = line.match(/^(\d{1,2}:\d{2})\s*[-–—:]\s*(\d{1,2}:\d{2})\s*(.*)$/);
  if (range) {
    return { time: `${range[1]}–${range[2]}`, rest: range[3].trim() };
  }
  const single = line.match(/^(\d{1,2}:\d{2})\s+(.*)$/);
  if (single) return { time: single[1], rest: single[2].trim() };
  const bareTime = line.match(/^(\d{1,2}:\d{2})\s*$/);
  if (bareTime) return { time: bareTime[1], rest: "" };
  return { time: "", rest: line.trim() };
}

// Turn one event block (separated by blank lines in the cell) into
// structured HTML. The title row uses a two-column grid: a tight mono
// time column (~52px, tabular-nums) and a flexible italic title that can
// wrap to two lines without truncation. Stacking time-over-title in
// narrow day cards (the previous layout) was clipping titles after two
// characters; pulling time off the title line frees the whole card
// width for the words that actually identify the event.
function renderEventBlock(blockText) {
  const lines = blockText.split("\n").map(l => l.replace(/\s+$/, ""));
  if (!lines.length) return "";
  const firstRaw = lines[0].trim();
  let { time, rest } = splitLeadingTime(firstRaw);
  // Edge case: the first line is JUST a bare time (e.g. "19:00"). Don't
  // render an empty title cell next to a lonely time stamp — promote the
  // time to the title slot and drop the time column for this row.
  let titleText = rest;
  if (time && !rest) {
    titleText = time;
    time = "";
  } else if (!time && !rest) {
    titleText = firstRaw;
  }
  const titleHtml = titleText ? escHtml(titleText) : "";
  const timeHtml  = time ? `<span class="cev-time">${escHtml(time)}</span>` : `<span class="cev-time cev-time--empty" aria-hidden="true"></span>`;
  const tail = lines.slice(1);
  const bullets = [];
  const extras  = [];
  for (const raw of tail) {
    if (!raw.trim()) continue;
    const top  = raw.match(/^\s{1,3}-\s+(.+)$/);
    const deep = raw.match(/^\s{4,}-\s+(.+)$/);
    if (deep && bullets.length) {
      bullets[bullets.length - 1].sub.push(boldTimes(escHtml(deep[1].trim())));
    } else if (top) {
      bullets.push({ text: boldTimes(escHtml(top[1].trim())), sub: [] });
    } else {
      extras.push(`<div class="cal-event-extra">${boldTimes(escHtml(raw.trim()))}</div>`);
    }
  }
  const bulletsHtml = bullets.length
    ? `<ul class="cal-bullets">${bullets.map(b => {
        const sub = b.sub.length
          ? `<ul class="cal-bullets">${b.sub.map(s => `<li>${s}</li>`).join("")}</ul>`
          : "";
        return `<li>${b.text}${sub}</li>`;
      }).join("")}</ul>`
    : "";
  return `<div class="cal-event-row">${timeHtml}<span class="cal-event-title">${titleHtml}</span></div>${extras.join("")}${bulletsHtml}`;
}

// Parse one week's row from the Phala tab structure. Returns:
//   { dateRange, theme, weekStartMs, days: [{ name, date, isToday, isEmpty, blocks[], anchors[] }] }
export function parseWeekRow(row, weekIdx, eventsByDayMs = new Map()) {
  const meta = (row && row[1] != null ? String(row[1]) : "").split("\n");
  const dateRange = (meta[0] || "").trim().toLowerCase();
  const theme     = meta.slice(1).filter(s => s.trim()).join(" — ").toLowerCase();
  const weekStartMs = COHORT_START_MS + weekIdx * 7 * 86400000;
  const todayMs = todayUtcMs();

  const days = DAY_NAMES.map((name, i) => {
    const raw = stripDayHeader((row && row[2 + i] != null ? String(row[2 + i]) : "").trim(), name);
    const dayMs = weekStartMs + i * 86400000;
    const anchors = eventsByDayMs.get(dayMs) || [];
    const blocks = raw ? raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean) : [];
    const dayOffset = Math.round((dayMs - todayMs) / 86400000);
    const relLabel = dayOffset === -1 ? "yesterday" : dayOffset === 1 ? "tomorrow" : null;
    return {
      name,
      date: fmtShortDate(new Date(dayMs)),
      dayMs,
      isToday: dayMs === todayMs,
      relLabel,
      isEmpty: blocks.length === 0 && anchors.length === 0,
      blocks,
      anchors,
    };
  });
  return { dateRange, theme, weekStartMs, days };
}

// Parse the recurring section that sits below the week rows (typically
// rows 12+ in the May 18 Start tab). We flatten everything non-empty into
// a single ledger and strip the boilerplate "RECURRING (all weeks):" prefix
// the source spreadsheet uses so the rendered ledger reads as content.
export function parseRecurring(rows) {
  const out = [];
  const prefixRe = /^\s*RECURRING\s*(?:\([^)]*\))?\s*:\s*/i;
  for (let r = 12; r < (rows?.length || 0); r++) {
    for (let c = 0; c < (rows[r]?.length || 0); c++) {
      let v = (rows[r][c] || "").toString().trim();
      if (!v) continue;
      v = v.replace(prefixRe, "").trim();
      if (v) out.push({ when: "", what: v });
    }
  }
  return out;
}

// Build an event index keyed by UTC-day milliseconds so the renderer can
// look up anchor events for each day in O(1).
export function buildEventsByDay(events = []) {
  const m = new Map();
  for (const e of events) {
    if (!e) continue;
    const startMs = isoToDayMs(e.range_start || e.date);
    const endMs   = isoToDayMs(e.range_end   || e.date);
    if (!startMs) continue;
    for (let d = startMs; d <= (endMs || startMs); d += 86400000) {
      if (!m.has(d)) m.set(d, []);
      m.get(d).push({
        record_id: e.record_id,
        kind: e.kind || "anchor",
        title: e.title || "—",
        subtitle: e.subtitle || null,
      });
    }
  }
  return m;
}

// ── day-view helpers ─────────────────────────────────────────────────

// Pull the leading time-range off a block and return it as minutes-since-
// midnight bounds. Used by the day view to compute past / current / up-next
// state per event. Single times (no end) get a notional 30-min duration so
// "current" doesn't collapse to a single minute. Returns null if no time.
function parseBlockTiming(blockText) {
  const firstLine = (blockText || "").split("\n")[0].trim();
  const range = firstLine.match(/^(\d{1,2}):(\d{2})\s*[-–—:]\s*(\d{1,2}):(\d{2})/);
  if (range) {
    return { startMin: +range[1] * 60 + +range[2], endMin: +range[3] * 60 + +range[4] };
  }
  const single = firstLine.match(/^(\d{1,2}):(\d{2})/);
  if (single) {
    const m = +single[1] * 60 + +single[2];
    return { startMin: m, endMin: m + 30 };
  }
  return null;
}

function currentMinutesOfDay() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Render one day as a full-width typeset agenda. Returns a section element
// containing day-of-week pills (peek at any day in this week) and an agenda
// list of events with mono time gutter + italic display titles.
//
//   days     — the 7-element array from parseWeekRow(...).days
//   dayIdx   — 0..6 of which day to render
//   theme    — string; the week's theme, surfaced in the day header meta
//   weekNum  — 1..10; surfaced in the day header meta (e.g. "w1 · m1")
//   phase    — "m1" | "m2" | "m3"; tints the meta
function renderDayView({ days, dayIdx, theme, weekNum, phase }) {
  const safeIdx = Math.max(0, Math.min(6, dayIdx | 0));
  const day = days[safeIdx];
  if (!day) return "";

  const showingToday = !!day.isToday;
  const nowMin = showingToday ? currentMinutesOfDay() : null;

  // ── day pills — let the user jump between any day of this week without
  // ── leaving day view. The active pill tints; today carries an oxide rule.
  const pills = days.map((d, i) => {
    const isSel = i === safeIdx;
    const count = (d.blocks?.length || 0) + (d.anchors?.length || 0);
    const countLabel = count === 0 ? "open" : count === 1 ? "1 event" : `${count} events`;
    const dayNum = d.date.replace(/^[a-z]+\s+/, "");
    return `
      <button class="cal-day-pill ${d.isToday ? "is-today" : ""} ${d.isEmpty ? "is-empty" : ""}"
              data-cal-day-pick="${i}"
              aria-selected="${isSel}"
              type="button">
        <span class="cdp-name">${d.name}${d.isToday ? " · today" : d.relLabel ? ` · ${escHtml(d.relLabel)}` : ""}</span>
        <span class="cdp-date">${escHtml(dayNum)}</span>
        <span class="cdp-count">${countLabel}</span>
      </button>`;
  }).join("");

  // ── Merge anchors + blocks into one timeline. Anchors without time pin
  // ── at the top as the day's narrative spine; timed blocks sort by start.
  const items = [];
  for (const a of (day.anchors || [])) {
    items.push({ kind: "anchor", title: a.title, subtitle: a.subtitle, startMin: -1, endMin: -1 });
  }
  for (const block of (day.blocks || [])) {
    const t = parseBlockTiming(block);
    items.push({
      kind: "event",
      raw: block,
      startMin: t ? t.startMin : 1e9,
      endMin:   t ? t.endMin   : 1e9,
    });
  }
  items.sort((a, b) => a.startMin - b.startMin);

  // ── "up next" pointer: first future event when viewing today.
  let upNextIdx = -1;
  if (showingToday && nowMin != null) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "event") continue;
      if (it.startMin < 1e9 && it.startMin > nowMin) { upNextIdx = i; break; }
    }
  }

  const weekday = DAY_NAMES_FULL[day.name] || day.name;
  const dayNum  = day.date.replace(/^[a-z]+\s+/, "");

  // ── agenda rows
  const rowHtml = items.map((it, i) => {
    if (it.kind === "anchor") {
      const sub = it.subtitle ? `<div class="cda-row-meta">${escHtml(it.subtitle)}</div>` : "";
      return `
        <article class="cda-row cda-row-anchor">
          <div class="cda-row-time"><span class="cda-row-time-dot" aria-hidden="true">◆</span></div>
          <div class="cda-row-body">
            <h3 class="cda-row-title">${escHtml(it.title)}</h3>
            ${sub}
          </div>
        </article>`;
    }
    // Event block: parse like the week renderer, but with full-width
    // typography — the day card is the entire column width, so the title
    // can be 26–32px italic without competing for space with anything.
    const lines = it.raw.split("\n").map(l => l.replace(/\s+$/, ""));
    const firstRaw = lines[0].trim();
    let { time, rest } = splitLeadingTime(firstRaw);
    let title = rest;
    if (!title && time) { title = time; time = ""; }
    if (!title) title = firstRaw;

    const tail = lines.slice(1);
    const bullets = [];
    const extras  = [];
    for (const raw of tail) {
      if (!raw.trim()) continue;
      const top  = raw.match(/^\s{1,3}-\s+(.+)$/);
      const deep = raw.match(/^\s{4,}-\s+(.+)$/);
      if (deep && bullets.length) {
        bullets[bullets.length - 1].sub.push(boldTimes(escHtml(deep[1].trim())));
      } else if (top) {
        bullets.push({ text: boldTimes(escHtml(top[1].trim())), sub: [] });
      } else {
        extras.push(`<div class="cda-row-meta">${boldTimes(escHtml(raw.trim()))}</div>`);
      }
    }
    const bulletsHtml = bullets.length
      ? `<ul class="cda-bullets">${bullets.map(b => {
          const sub = b.sub.length
            ? `<ul class="cda-bullets cda-bullets-sub">${b.sub.map(s => `<li>${s}</li>`).join("")}</ul>`
            : "";
          return `<li>${b.text}${sub}</li>`;
        }).join("")}</ul>`
      : "";

    let state = "future";
    if (showingToday && nowMin != null && it.startMin < 1e9) {
      if (it.endMin < nowMin) state = "past";
      else if (it.startMin <= nowMin && it.endMin >= nowMin) state = "current";
      else if (i === upNextIdx) state = "upnext";
    }

    return `
      <article class="cda-row" data-state="${state}">
        <div class="cda-row-time">${time ? escHtml(time) : `<span class="cda-row-time-dim">—</span>`}</div>
        <div class="cda-row-body">
          <h3 class="cda-row-title">${escHtml(title)}</h3>
          ${extras.join("")}
          ${bulletsHtml}
        </div>
      </article>`;
  }).join("");

  const body = items.length
    ? `<div class="cal-day-agenda">${rowHtml}</div>`
    : `<div class="cal-day-empty">
         <em class="cde-line">${showingToday ? "today is open" : "no scheduled events"}</em>
         <span class="cde-sub">nothing on the cohort calendar · use the day pills above to peek at other days</span>
       </div>`;

  const metaTag = weekNum
    ? `<span class="cdc-h-tag" data-phase="${escAttr(phase || "m1")}">w${weekNum} · ${escAttr(phase || "m1")}</span>`
    : "";

  return `
    <section class="cal-day-view" data-cal-view="day" data-phase="${escAttr(phase || "m1")}">
      <nav class="cal-day-pills" role="tablist" aria-label="day of week">
        ${pills}
      </nav>

      <header class="cal-day-canvas-h">
        <div class="cdc-h-left">
          <h2 class="cdc-h-date">
            <em class="cdc-h-weekday">${escHtml(weekday)}</em>
            <span class="cdc-h-num">${escHtml(dayNum)}</span>
          </h2>
        </div>
        <div class="cdc-h-meta">
          ${day.isToday ? `<span class="cdc-h-today">today</span>` : ""}
          ${metaTag}
          ${theme ? `<span class="cdc-h-theme">${escHtml(theme)}</span>` : ""}
        </div>
      </header>

      ${body}
    </section>`;
}

// ── markup ───────────────────────────────────────────────────────────

// renderWeekView({ data, weekIdx, dayIdx, sub, source, events, presenceHtml, surface })
//
//   data         — the raw Phala JSON (live or bundled)
//   weekIdx      — 0..9
//   sub          — "week" | "presence"
//   source       — "live" | "bundled" | null (null = no data; banner suppressed)
//   bundledStamp — "wed may 13 · 9:14am" or similar; shown in stale banner
//   events       — array of event records (from cohort.events) for anchor merge
//   presenceHtml — caller-supplied HTML for the presence sub-tab (null = link
//                  out / no content). Lets each surface plug in its own
//                  presence renderer without this module knowing about it.
//   surface      — "electron" (default) | "web". Tweaks copy that differs by
//                  consumer — currently just the stale banner: Electron says
//                  "offline, try again now"; web says "dates may be partially
//                  out of sync, download the app for the latest" with a link
//                  back to the landing page's install CTA.
export function renderWeekView({
  data,
  weekIdx = 0,
  dayIdx  = null,
  sub = "day",
  source = null,
  bundledStamp = null,
  events = [],
  presenceHtml = "",
  surface = "electron",
} = {}) {
  const tab = data?.tabs?.[PRIMARY_TAB] || [];
  const rows = tab;
  const safeWeekIdx = Math.max(0, Math.min(WEEK_COUNT - 1, weekIdx | 0));
  const weekRow = rows[2 + safeWeekIdx] || [];
  const eventsByDay = buildEventsByDay(events);
  const week = parseWeekRow(weekRow, safeWeekIdx, eventsByDay);
  const phase = phaseFor(safeWeekIdx + 1);
  const recurring = parseRecurring(rows);

  const isLive    = source === "live";
  const isBundled = source === "bundled";
  const isStale   = isBundled; // any non-live source is "stale"; refine later if we add a third tier
  const syncStateClass = isLive ? "is-live" : isBundled ? "is-bundled" : "is-unknown";
  const syncLabel = (() => {
    if (source == null) return "no calendar data yet";
    const stamp = fmtSyncStamp(data?.last_refresh) || "—";
    return isLive ? `synced live · ${stamp}` : `bundled snapshot · ${stamp}`;
  })();

  // ── scrubber dots — labeled 1..10, phase-tinted, with current selection ─
  const scrubDots = Array.from({ length: WEEK_COUNT }, (_, i) => {
    const w1 = i + 1;
    const ph = phaseFor(w1);
    return `
      <button class="cal-scrub-dot"
              data-week="${i}"
              data-phase="${escAttr(ph)}"
              aria-selected="${i === safeWeekIdx}"
              aria-label="week ${w1}"
              type="button">
        <span class="csd-mark">${w1}</span>
      </button>`;
  }).join("");

  // ── now-line position ────────────────────────────────────────────────
  // Rendered once at HTML-string time; attachWeekViewBehavior ticks it live.
  const nowPct = nowFraction();
  const nowLineHtml = `<div class="cal-now-line" aria-hidden="true" style="top:${(nowPct * 100).toFixed(2)}%"></div>`;

  // ── day cells ───────────────────────────────────────────────────────
  const dayCells = week.days.map(d => {
    const anchorRows = d.anchors.map(a => `
      <div class="cal-day-anchor" data-kind="${escAttr(a.kind)}">
        <span class="cda-glyph" aria-hidden="true">◆</span>
        <span class="cda-title">${escHtml(a.title)}</span>
        ${a.subtitle ? `<span class="cda-sub">${escHtml(a.subtitle)}</span>` : ""}
      </div>`).join("");
    const blockRows = d.blocks.map(b => `
      <div class="cal-event">${renderEventBlock(b)}</div>`).join("");
    return `
      <article class="cal-day ${d.isToday ? "is-today" : ""} ${d.isEmpty ? "is-empty" : ""}"
               data-phase="${escAttr(phase)}"
               role="listitem"
               aria-current="${d.isToday ? "date" : "false"}">
        <header class="cal-day-h">
          <span class="cdh-name">${d.name}</span>
          <span class="cdh-date">${escHtml(d.date)}</span>
          ${d.isToday ? `<span class="cdh-today">today</span>` : ""}
          ${d.relLabel ? `<span class="cdh-rel">${escHtml(d.relLabel)}</span>` : ""}
        </header>
        ${d.isToday ? nowLineHtml : ""}
        ${anchorRows}
        ${d.isEmpty
          ? `<div class="cal-day-empty" aria-label="nothing scheduled">—</div>`
          : blockRows}
      </article>`;
  }).join("");

  // ── recurring footer ───────────────────────────────────────────────
  const recurringHtml = recurring.length
    ? `<ul class="cal-recur-list" role="list">
         ${recurring.map(r => `
           <li class="cal-recur-item">
             <span class="cri-what">${boldTimes(escHtml(r.what))}</span>
           </li>`).join("")}
       </ul>`
    : `<p class="cal-recur-empty">no recurring rituals yet.</p>`;

  // ── stale banner ───────────────────────────────────────────────────
  // Two flavors of copy: the Electron app already IS the install, so its
  // banner offers a retry; the web encourages users to grab the desktop app
  // for a more reliable always-up-to-date experience.
  const stampHint = bundledStamp || fmtSyncStamp(data?.last_refresh) || "an earlier sync";
  const staleMsg = surface === "web"
    ? `dates may be partially out of sync · <a class="cs-install-link" href="/" data-cal-install>download the app for the latest</a>`
    : `offline · showing bundled snapshot from ${escHtml(stampHint)} · connect to the internet to refresh, or <button class="cs-retry" type="button" data-cal-retry="1">try again now</button>`;
  const staleBanner = isStale
    ? `<div class="cal-stale" role="status">
         <span class="cs-glyph" aria-hidden="true">░</span>
         <span class="cs-msg">${staleMsg}</span>
       </div>`
    : "";

  // ── presence sub-tab body ─────────────────────────────────────────
  // Note: the canvas wrapper below renders sub-views conditionally, so each
  // sub-view's markup only mounts when it's the active tab. The masthead
  // (tabs + scrubber + dateline) lives ABOVE the sub-views so it's visible
  // from every tab — switching between day / week / presence is one click,
  // not a hunt for hidden chrome.
  const presenceBody = `${presenceHtml || `<p class="cal-presence-empty">presence view not available on this surface.</p>`}`;

  // ── today's column index (0 = mon … 6 = sun, or null if today isn't in
  // this week). Used by .cal-grid both to mark today and for the week view's
  // auto-scroll-to-today behavior. We no longer widen today's column via
  // grid-template tricks — the week view now scrolls horizontally with a
  // uniform per-day min-width, so titles render legibly in every column.
  const todayColIdx = week.days.findIndex(d => d.isToday);
  const todayColAttr = todayColIdx >= 0 ? `data-today-col="${todayColIdx}"` : "";

  // ── day view: which day is selected? Default to today if today is in
  // this week; otherwise pin to Monday of the visible week.
  const safeDayIdx = (() => {
    if (Number.isInteger(dayIdx) && dayIdx >= 0 && dayIdx <= 6) return dayIdx;
    return todayColIdx >= 0 ? todayColIdx : 0;
  })();
  const dayViewHtml = sub === "day"
    ? renderDayView({
        days:    week.days,
        dayIdx:  safeDayIdx,
        theme:   week.theme,
        weekNum: safeWeekIdx + 1,
        phase,
      })
    : "";

  return `
    <header class="cal-page-head">
      <div class="cal-page-title-row">
        <h1 class="cal-page-title">cohort <em>calendar</em></h1>
        <div class="cal-page-sync ${syncStateClass}">
          <span class="cps-dot" aria-hidden="true">●</span>
          <span class="cps-label">${escHtml(syncLabel)}</span>
        </div>
      </div>
    </header>

    ${staleBanner}

    <div class="cal-canvas" data-sub="${escAttr(sub)}" data-phase="${escAttr(phase)}">

      <header class="cal-masthead" data-phase="${escAttr(phase)}">

        <div class="cal-masthead-rail">
          <nav class="cal-subtabs" role="tablist" aria-label="calendar view">
            <button class="cal-subtab" data-cal-sub="day" aria-selected="${sub === "day"}" type="button">
              <span class="cs-label">day</span>
            </button>
            <button class="cal-subtab" data-cal-sub="week" aria-selected="${sub === "week"}" type="button">
              <span class="cs-label">week</span>
            </button>
            <button class="cal-subtab" data-cal-sub="presence" aria-selected="${sub === "presence"}" type="button">
              <span class="cs-label">presence</span>
            </button>
          </nav>

          <div class="cal-scrub" role="tablist" aria-label="program week">
            <div class="cal-scrub-track" aria-hidden="true"></div>
            ${scrubDots}
          </div>

          <div class="cal-dateline-nav" role="group" aria-label="week navigation">
            <button class="cdn-btn cdn-arrow" data-cal-nav="prev"  aria-label="previous week" ${safeWeekIdx === 0 ? "disabled" : ""} type="button">←</button>
            <button class="cdn-btn cdn-today" data-cal-nav="today" type="button">this week</button>
            <button class="cdn-btn cdn-arrow" data-cal-nav="next"  aria-label="next week" ${safeWeekIdx === WEEK_COUNT - 1 ? "disabled" : ""} type="button">→</button>
          </div>
        </div>

        <div class="cal-dateline" data-phase="${escAttr(phase)}">
          <div class="cal-dateline-meta">
            <span class="cal-dateline-tag" data-phase="${escAttr(phase)}">w${safeWeekIdx + 1} · ${phase}</span>
            <span class="cal-dateline-sep" aria-hidden="true">·</span>
            <span class="cal-dateline-theme">${escHtml(week.theme || "no theme yet")}</span>
          </div>
          <div class="cal-dateline-range">${escHtml(week.dateRange || "—")}</div>
        </div>

      </header>

      ${sub === "day" ? dayViewHtml : ""}

      ${sub === "week" ? `
        <section class="cal-week" data-cal-view="week" data-phase="${escAttr(phase)}">
          <header class="cal-week-heading">
            <h2 class="cwh-display"><em>week ${ordinal(safeWeekIdx + 1)} of ten</em></h2>
            <span class="cwh-range">${escHtml(week.dateRange || "—")}</span>
          </header>
          <div class="cal-grid-scroller">
            <div class="cal-grid" role="list" ${todayColAttr}>
              ${dayCells}
            </div>
          </div>

          <footer class="cal-recur">
            <h2 class="cal-recur-h">recurring</h2>
            ${recurringHtml}
          </footer>

          <div class="cal-page-foot">
            <span>source · <a href="${escAttr(CALENDAR_URL)}" data-external>phala /cadence/calendar.json</a></span>
            <span aria-hidden="true">·</span>
            <span>cohort may 18 → jul 26 2026</span>
          </div>

          <div class="cal-kbd-hints" aria-hidden="true">
            <span class="ckh-pair"><kbd class="ckh-key">←</kbd><kbd class="ckh-key">→</kbd><span class="ckh-label">prev / next week</span></span>
            <span class="ckh-sep" aria-hidden="true">·</span>
            <span class="ckh-pair"><kbd class="ckh-key">t</kbd><span class="ckh-label">jump to this week</span></span>
          </div>
        </section>
      ` : ""}

      ${sub === "presence" ? `
        <section class="cal-presence" data-cal-view="presence">
          ${presenceBody}
        </section>
      ` : ""}

    </div>
  `;
}

// Mobile behavior helper — attaches week-swipe gestures + auto-scrolls the
// today card into view on first render of the week view. Returns a teardown
// fn the consumer can call before re-render to remove listeners (otherwise
// listeners stack up across renders).
//
// Args:
//   root            — the container the renderWeekView markup was mounted in
//   onWeekChange    — (delta: -1 | +1) => void; consumer flips state + rerenders
//   scrollToToday   — bool; if true (default), scrolls today into view on mount
//   isMobile        — optional () => bool; defaults to matchMedia <= 760px
export function attachWeekViewBehavior(root, { onWeekChange, scrollToToday = true, isMobile } = {}) {
  if (!root) return () => {};
  const mobile = typeof isMobile === "function"
    ? isMobile
    : () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;

  // ── auto-scroll to today on mobile ───────────────────────────────────
  // Only on initial mount of the week view. Lets the sticky dateline stay
  // at the top, then scrolls so the today card sits just under it.
  if (scrollToToday && mobile()) {
    requestAnimationFrame(() => {
      const today = root.querySelector(".cal-day.is-today");
      const dateline = root.querySelector(".cal-dateline");
      if (!today) return;
      const datelineH = dateline ? dateline.getBoundingClientRect().height : 0;
      const y = today.getBoundingClientRect().top + (window.pageYOffset || 0) - datelineH - 8;
      window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
    });
  }

  // ── now-line live tick ────────────────────────────────────────────────
  // Updates the "cal-now-line" top position every minute so it stays
  // accurate without requiring a full re-render.
  let nowTimer = null;
  function tickNowLine() {
    const line = root.querySelector(".cal-now-line");
    if (!line) return;
    const d = new Date();
    const frac = Math.min(1, Math.max(0, (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400));
    line.style.top = (frac * 100).toFixed(2) + "%";
  }
  // Align the first tick to the next whole minute so subsequent ticks stay
  // on-the-minute rather than drifting. This is a best-effort alignment
  // (exact only if the JS event loop is not blocked at tick time).
  const msUntilNextMinute = 60000 - (Date.now() % 60000);
  nowTimer = setTimeout(() => {
    tickNowLine();
    nowTimer = setInterval(tickNowLine, 60000);
  }, msUntilNextMinute);

  // ── swipe-to-navigate weeks (mobile only) ────────────────────────────
  let touchStartX = 0;
  let touchStartY = 0;
  let touchActive = false;
  function onTouchStart(e) {
    if (!mobile()) return;
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchActive = true;
  }
  function onTouchEnd(e) {
    if (!touchActive) return;
    touchActive = false;
    if (!mobile()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    // Horizontal intent: must be > 60px horizontal AND mostly horizontal
    // (|dx| > 2 * |dy|) so we don't hijack vertical scrolls.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (typeof onWeekChange !== "function") return;
    onWeekChange(dx > 0 ? -1 : +1);
  }
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchend",   onTouchEnd,   { passive: true });

  return function teardown() {
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchend",   onTouchEnd);
    if (nowTimer != null) { clearTimeout(nowTimer); clearInterval(nowTimer); nowTimer = null; }
  };
}

// Ghost skeleton of the week view — rendered instantly before data arrives so
// the page never shows a blank mount. Uses the real CSS layout classes (so
// proportions match the actual calendar) with .csk-bar rects in place of
// text content. A soft pulse animation communicates "loading" without being
// distracting; prefers-reduced-motion falls back to static opacity.
export function renderSkeletonWeek() {
  const dots = Array.from({ length: WEEK_COUNT }, () =>
    `<div class="cal-scrub-dot" aria-hidden="true"></div>`).join("");
  const dayCols = Array.from({ length: 7 }, () => `
    <article class="cal-day" role="listitem" aria-hidden="true">
      <div class="csk-bar" style="width:58%;height:9px;margin-bottom:11px"></div>
      <div class="csk-bar" style="width:92%;height:8px;margin-bottom:7px"></div>
      <div class="csk-bar" style="width:75%;height:8px;margin-bottom:7px"></div>
      <div class="csk-bar" style="width:85%;height:8px"></div>
    </article>`).join("");
  return `
    <div class="cal-skeleton" role="status" aria-label="loading calendar" aria-busy="true">
      <header class="cal-page-head">
        <div class="cal-page-title-row">
          <div class="csk-bar" style="width:192px;height:28px"></div>
          <div class="csk-bar" style="width:128px;height:9px"></div>
        </div>
      </header>
      <div class="cal-week">
        <div class="cal-masthead">
          <div class="cal-masthead-rail">
            <nav class="cal-subtabs" aria-hidden="true">
              <div class="csk-bar" style="width:48px;height:20px"></div>
              <div class="csk-bar" style="width:64px;height:20px"></div>
            </nav>
            <div class="cal-scrub">${dots}</div>
          </div>
          <div class="cal-dateline">
            <div class="csk-bar" style="width:86px;height:9px;margin-bottom:12px"></div>
            <div class="csk-bar" style="width:248px;height:46px;margin-bottom:9px"></div>
            <div class="csk-bar" style="width:132px;height:9px"></div>
          </div>
        </div>
        <div class="cal-grid" role="list">${dayCols}</div>
      </div>
    </div>`;
}

// Convenience: try the live URL first, fall back to the supplied bundle.
// Returns { data, source, bundledStamp }.
export async function loadCalendar({ bundled = null, fetchOpts = {} } = {}) {
  try {
    const r = await fetch(CALENDAR_URL, { cache: "no-store", ...fetchOpts });
    if (!r.ok) throw new Error("http " + r.status);
    const data = await r.json();
    return { data, source: "live", bundledStamp: null };
  } catch (e) {
    if (bundled) {
      return { data: bundled, source: "bundled", bundledStamp: fmtSyncStamp(bundled.last_refresh) };
    }
    return { data: null, source: null, bundledStamp: null };
  }
}

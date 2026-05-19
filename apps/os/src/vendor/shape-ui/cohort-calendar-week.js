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
//   renderWeekView({ data, weekIdx, sub, source, events }) — HTML string

import { escHtml, escAttr } from "./escape.js";

export const CALENDAR_URL = "https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/cadence/calendar.json";

const PRIMARY_TAB     = "May 18 Start";
const COHORT_START_MS = Date.UTC(2026, 4, 18);                // mon may 18 2026
const COHORT_END_MS   = Date.UTC(2026, 6, 26);                // sun jul 26 2026
const WEEK_COUNT      = 10;

export const PROGRAM_START_MS = COHORT_START_MS;
export const PROGRAM_END_MS   = COHORT_END_MS;

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// ── time helpers ─────────────────────────────────────────────────────
function todayUtcMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
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

// Turn one event block (separated by blank lines in the cell) into
// structured HTML: title line + a nested bullet tree (one level deep;
// deeper indentation collapses into the first sublevel).
function renderEventBlock(blockText) {
  const lines = blockText.split("\n").map(l => l.replace(/\s+$/, ""));
  if (!lines.length) return "";
  const titleHtml = boldTimes(escHtml(lines[0].trim()));
  const rest = lines.slice(1);
  const bullets = [];
  const extras  = [];
  for (const raw of rest) {
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
  return `<span class="cal-event-title">${titleHtml}</span>${extras.join("")}${bulletsHtml}`;
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
    return {
      name,
      date: fmtShortDate(new Date(dayMs)),
      dayMs,
      isToday: dayMs === todayMs,
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

// ── markup ───────────────────────────────────────────────────────────

// renderWeekView({ data, weekIdx, sub, source, events, presenceHtml })
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
export function renderWeekView({
  data,
  weekIdx = 0,
  sub = "week",
  source = null,
  bundledStamp = null,
  events = [],
  presenceHtml = "",
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
        </header>
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
  const stampHint = bundledStamp || fmtSyncStamp(data?.last_refresh) || "an earlier sync";
  const staleBanner = isStale
    ? `<div class="cal-stale" role="status">
         <span class="cs-glyph" aria-hidden="true">░</span>
         <span class="cs-msg">offline · showing bundled snapshot from ${escHtml(stampHint)} · connect to the internet to refresh, or <button class="cs-retry" type="button" data-cal-retry="1">try again now</button></span>
       </div>`
    : "";

  // ── presence sub-tab body ─────────────────────────────────────────
  const presenceSection = `
    <section class="cal-presence" data-cal-view="presence" ${sub === "presence" ? "" : "hidden"}>
      ${presenceHtml || `<p class="cal-presence-empty">presence view not available on this surface.</p>`}
    </section>`;

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

    <nav class="cal-subtabs" role="tablist" aria-label="calendar view">
      <button class="cal-subtab" data-cal-sub="week"     aria-selected="${sub === "week"}"     type="button">
        <span class="cs-label">week</span>
        <span class="cs-hint">live schedule</span>
      </button>
      <button class="cal-subtab" data-cal-sub="presence" aria-selected="${sub === "presence"}" type="button">
        <span class="cs-label">presence</span>
        <span class="cs-hint">who's here, when</span>
      </button>
    </nav>

    <section class="cal-week" data-cal-view="week" data-phase="${escAttr(phase)}" ${sub === "week" ? "" : "hidden"}>

      <div class="cal-scrub" role="tablist" aria-label="program week">
        <div class="cal-scrub-track" aria-hidden="true"></div>
        ${scrubDots}
        <div class="cal-scrub-phases" aria-hidden="true">
          <span class="csp m1">m1 · weeks 1–4</span>
          <span class="csp m2">m2 · weeks 5–9</span>
          <span class="csp m3">m3 · week 10</span>
        </div>
      </div>

      <div class="cal-dateline" data-phase="${escAttr(phase)}">
        <div class="cal-dateline-row">
          <span class="cal-dateline-tag" data-phase="${escAttr(phase)}">w${safeWeekIdx + 1} · ${phase}</span>
          <span class="cal-dateline-sep" aria-hidden="true">·</span>
          <span class="cal-dateline-theme">${escHtml(week.theme || "no theme yet")}</span>
        </div>
        <div class="cal-dateline-display">
          <em class="cal-dateline-ordinal">week ${ordinal(safeWeekIdx + 1)} of ten</em>
        </div>
        <div class="cal-dateline-range">${escHtml(week.dateRange || "—")}</div>

        <div class="cal-dateline-nav" role="group" aria-label="week navigation">
          <button class="cdn-btn" data-cal-nav="prev"  aria-label="previous week" ${safeWeekIdx === 0 ? "disabled" : ""} type="button">←</button>
          <button class="cdn-btn cdn-today" data-cal-nav="today" type="button">this week</button>
          <button class="cdn-btn" data-cal-nav="next"  aria-label="next week" ${safeWeekIdx === WEEK_COUNT - 1 ? "disabled" : ""} type="button">→</button>
        </div>
      </div>

      <div class="cal-grid" role="list">
        ${dayCells}
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

    ${presenceSection}
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
  };
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

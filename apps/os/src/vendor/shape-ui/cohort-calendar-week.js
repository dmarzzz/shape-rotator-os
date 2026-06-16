// cohort-calendar-week.js — the "broadsheet week" calendar surface used
// by both Shape Rotator OS and the sibling web app.
//
// Pure HTML-string renderer. Consumers handle data loading (live URL with
// bundled fallback), state, and event delegation. The shape mirrors how
// cohort-card.js works — strings out, hooks attached by the consumer.
//
// Data source: the JSON shipped at the CALENDAR_URL below — our own
// schedule, regenerated from the Shape Rotator admin Google Calendar and
// mirrored into the surface bundle hourly by the calendar-sync GitHub
// Action (see scripts/build-calendar-from-google.js).
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
//       "Weekly Themes": [...]   // legacy — no longer emitted; only "May 18 Start" is built + rendered
//     }
//   }
//
// API:
//   CALENDAR_URL                      — our calendar.json feed (os-web.shaperotator.xyz)
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

// Our own schedule feed, served by apps/web (vendor:web copies cohort-data/calendar.json
// → /calendar.json) and regenerated from our Google calendar by the calendar-sync bot.
export const CALENDAR_URL = "https://os-web.shaperotator.xyz/calendar.json";

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
function localCalendarDayMs(date = new Date()) {
  const src = date instanceof Date ? date : new Date(date);
  return Date.UTC(src.getFullYear(), src.getMonth(), src.getDate());
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
  const days = Math.floor((localCalendarDayMs(nowMs) - COHORT_START_MS) / 86400000);
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
// Collapse consecutive identical lines within a block. The upstream
// calendar occasionally repeats a line verbatim (e.g. an "[All Day] Anarchy
// Day…" note stored twice). Left alone that renders as an italic title PLUS a
// duplicate sub-line, which both reads wrong and inflates the day column's
// height (stretching every other column in the equal-height week grid). We
// can't fix it in the JSON — the sync would overwrite it — so we dedupe at
// render time, hardening both surfaces against any repeated upstream line.
function dedupeAdjacentLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev != null && line.trim() && prev.trim() === line.trim()) continue;
    out.push(line);
  }
  return out;
}

function renderEventBlock(blockText, sources = []) {
  const lines = dedupeAdjacentLines(blockText.split("\n").map(l => l.replace(/\s+$/, "")));
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
  const timeHtml  = time ? `<span class="cev-time">${escHtml(time)}</span>` : `<span class="cev-time cev-time--empty" aria-hidden="true"></span>`;
  const tail = lines.slice(1);
  const bullets = [];
  const extras  = [];
  for (const raw of tail) {
    if (!raw.trim()) continue;
    const top  = raw.match(/^\s*-\s+(.+)$/);
    const deep = raw.match(/^\s{4,}-\s+(.+)$/);
    if (deep && bullets.length) {
      bullets[bullets.length - 1].sub.push(boldTimes(escHtml(deep[1].trim())));
    } else if (top) {
      const rawText = top[1].trim();
      bullets.push({ raw: rawText, text: boldTimes(escHtml(rawText)), sub: [] });
    } else {
      extras.push(`<div class="cal-event-extra">${boldTimes(escHtml(raw.trim()))}</div>`);
    }
  }
  const { byLine: bulletSources, fallback: titleSources } = splitSourcesByLines(sources, bullets.map(b => b.raw));
  const titleHtml = titleText ? `${escHtml(titleText)}${renderInlineTranscriptLinks(titleSources)}` : "";
  const bulletsHtml = bullets.length
    ? `<ul class="cal-bullets">${bullets.map((b, i) => {
        const sub = b.sub.length
          ? `<ul class="cal-bullets">${b.sub.map(s => `<li>${s}</li>`).join("")}</ul>`
          : "";
        return `<li>${b.text}${renderInlineTranscriptLinks(bulletSources[i])}${sub}</li>`;
      }).join("")}</ul>`
    : "";
  return `<div class="cal-event-row">${timeHtml}<span class="cal-event-title">${titleHtml}</span></div>${extras.join("")}${bulletsHtml}`;
}

// Infer a coarse category from event text so cards can be color-coded the way
// the cohort week-timetable reads. Pure heuristic over the existing calendar
// cell text — no schema change, no new event data required.
//
// These are the STRUCTURED, RECURRING slot types (office hours / weekly /
// coordination / demo review / hacking / self-organized). Salons are the
// inverse: bespoke one-off topic sessions that don't match any of these and
// aren't a standing ritual — see eventCategory.
const CAL_CATEGORIES = [
  { key: "review",  label: "Demo Review",     re: /demo review|product review|internal .*review/i },
  { key: "demo",    label: "Demo Night",      re: /demo night|showcase|demo day/i },
  { key: "oh",      label: "Office Hour",     re: /office hour|pmf check|\bcheck[ -]?point|\b1:1/i },
  { key: "weekly",  label: "SR Weekly",       re: /\bweekly\b|what did you do|\bwdydlw\b/i },
  { key: "coord",   label: "Coordination",    re: /coordinat|attribution/i },
  { key: "hack",    label: "Hacking",         re: /\bhack|hackathon|open jam|\bfinals\b|submission|build night/i },
  { key: "anarchy", label: "Self-organized",  re: /anarchy|self-organ|no .*program|protected build|team-led/i },
];

// Standing daily rituals that read as neutral. They recur but aren't a
// structured program slot, so they stay uncolored rather than becoming a
// salon (tea on roof, coffee, lunch, stand-ups).
const CAL_RITUAL_RE = /tea on roof|\btea\b|coffee|lunch|breakfast|stand[- ]?up/i;

function eventCategory(text) {
  const t = String(text || "");
  const tbc = /\btbc\b|to be confirmed|\(tbc\)/i.test(t);
  // An explicit "salon" label always wins.
  if (/\bsalon\b/i.test(t)) return { key: "salon", label: "Salon", tbc };
  // Structured, recurring slot types keep their own category.
  for (const c of CAL_CATEGORIES) if (c.re.test(t)) return { key: c.key, label: c.label, tbc };
  // Standing daily ritual → neutral, not a salon.
  if (CAL_RITUAL_RE.test(t)) return { key: "default", label: "", tbc };
  // Otherwise it's a custom, one-off topic session (often guest-/host-led) —
  // a salon. Require at least one letter so empty / dash-only cells stay
  // neutral instead of rendering an empty salon chip.
  if (/[a-z]/i.test(t)) return { key: "salon", label: "Salon", tbc };
  return { key: "default", label: "", tbc };
}

// Wrap one event block in a color-coded card with a category chip (+ TBC pill).
function renderEventCard(blockText, sources = []) {
  const cat = eventCategory(blockText);
  const chip = (cat.label || cat.tbc)
    ? `<div class="cev-cat">${cat.label ? escHtml(cat.label) : ""}${cat.tbc ? `<span class="cev-tbc">TBC</span>` : ""}</div>`
    : "";
  return `<div class="cal-event ev-${cat.key}${cat.tbc ? " is-tbc" : ""}" data-cat="${escAttr(cat.key)}" data-cal-event role="button" tabindex="0" aria-label="open event details">${chip}${renderEventBlock(blockText, sources)}</div>`;
}

// Open a full-detail popover for a clicked week-view event card. The card
// already holds the full (CSS-clamped) content, so we clone it into a modal
// that lifts the clamp — no data plumbing, works in Electron + web.
export function openEventDetail(cardEl) {
  if (!cardEl || typeof document === "undefined") return;
  const dayEl = cardEl.closest(".cal-day");
  const dow = dayEl?.querySelector(".cdh-name")?.textContent?.trim() || "";
  const date = dayEl?.querySelector(".cdh-date")?.textContent?.trim() || "";
  const cat = cardEl.getAttribute("data-cat") || "default";
  document.querySelector(".cal-event-modal")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "cal-event-modal";
  overlay.innerHTML =
    `<div class="cem-panel" data-cat="${escAttr(cat)}" role="dialog" aria-modal="true" aria-label="event details">
       <button class="cem-close" type="button" aria-label="close">×</button>
       ${(dow || date) ? `<div class="cem-day">${escHtml(dow)}${date ? ` · ${escHtml(date)}` : ""}</div>` : ""}
       <div class="cem-body">${cardEl.innerHTML}</div>
     </div>`;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".cem-close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

// Ordered category legend for the week-view key bar.
const CAL_CATEGORY_LEGEND = [
  { key: "oh",      label: "Office Hours" },
  { key: "salon",   label: "Salon" },
  { key: "weekly",  label: "Weekly / Self-organized" },
  { key: "coord",   label: "Coordination" },
  { key: "review",  label: "Demo Review" },
  { key: "hack",    label: "Hacking" },
  { key: "demo",    label: "Demo Night" },
];
// Category → hex, mirrors the CSS palette so the PNG export matches the
// on-screen color-coding.
const CAL_CAT_HEX = {
  oh: "#d98a5c", salon: "#c9a8d8", weekly: "#a8c79f", coord: "#e3c77f",
  review: "#f3b174", hack: "#9fb8d8", demo: "#e07a4e", anarchy: "#a8c79f",
  default: "#8f817a",
};

// One-tap, mobile-optimized PNG of the current week: a tall portrait card
// (1080px wide) with days stacked vertically and color-coded event blocks —
// shaped to drop straight into a phone screenshot / story. Pure canvas-2D, no
// deps; works in both the Electron renderer and the web OS. Triggers a
// download (and the Electron save dialog when available).
export function exportWeekPng({ data, weekIdx = 0 } = {}) {
  const tab = data?.tabs?.[PRIMARY_TAB] || [];
  const safeWeekIdx = Math.max(0, Math.min(WEEK_COUNT - 1, weekIdx | 0));
  const week = parseWeekRow(tab[2 + safeWeekIdx] || [], safeWeekIdx);
  const days = week.days.filter(d => !d.isEmpty);

  const S = 2;                         // retina scale
  const W = 1080;                      // mobile portrait width
  const PAD = 48;
  const COL = W - PAD * 2;
  const measure = document.createElement("canvas").getContext("2d");
  const wrap = (text, font, maxW) => {
    measure.font = font;
    const words = String(text).split(/\s+/);
    const lines = []; let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (measure.measureText(t).width > maxW && line) { lines.push(line); line = w; }
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  };
  // Parse a block into its time, title, and detail lines (bullets / extra
  // lines) so the card shows the full event, not just the first line.
  const parseBlock = (block) => {
    const lines = block.split("\n").map(l => l.replace(/\s+$/, "")).filter(l => l.trim());
    const first = (lines[0] || "").trim();
    const { time, rest } = splitLeadingTime(first);
    const title = (rest || (time ? "" : first)).trim();
    const details = lines.slice(1).map(l => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);
    return { time: time || "", title, details };
  };
  const hexA = (hex, a) => {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  // ── type scale ───────────────────────────────────────────────────────
  const CHIP_FONT  = `700 13px "JetBrains Mono", ui-monospace, monospace`;
  const TIME_FONT  = `600 16px "JetBrains Mono", ui-monospace, monospace`;
  const TITLE_FONT = `600 22px "JetBrains Mono", ui-monospace, monospace`;
  const DET_FONT   = `400 16px "JetBrains Mono", ui-monospace, monospace`;
  const TITLE_LH = 30, DET_LH = 24, PADX = 22;

  // ── measure pass: compute total height ───────────────────────────────
  let H = 216;                         // header
  const layout = [];
  for (const d of days) {
    layout.push({ kind: "dayhead", d });
    H += 56;
    for (const block of d.blocks) {
      const ev = parseBlock(block);
      const cat = eventCategory(block);
      const titleLines = ev.title ? wrap(ev.title, TITLE_FONT, COL - PADX * 2) : [];
      const detailLines = [];
      for (const det of ev.details)
        for (const ln of wrap(det, DET_FONT, COL - PADX * 2 - 14)) detailLines.push(ln);
      let ch = 14;                                       // top pad
      if (cat.label || cat.tbc) ch += 24;                // chip
      if (ev.time) ch += 22;                             // time line
      ch += titleLines.length * TITLE_LH;
      if (detailLines.length) ch += 8 + detailLines.length * DET_LH;
      ch += 14;                                          // bottom pad
      layout.push({ kind: "event", time: ev.time, titleLines, detailLines, cat, ch });
      H += ch + 10;
    }
    H += 14;
  }
  H += 92;                             // footer

  const cnv = document.createElement("canvas");
  cnv.width = W * S; cnv.height = H * S;
  const ctx = cnv.getContext("2d");
  ctx.scale(S, S);

  // background — warm radial, same family as the app stage
  const bg = ctx.createRadialGradient(W * 0.2, 0, 80, W / 2, H / 2, Math.max(W, H));
  bg.addColorStop(0, "#2b1c16"); bg.addColorStop(0.5, "#19130f"); bg.addColorStop(1, "#0d0b0a");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // ── header ───────────────────────────────────────────────────────────
  let y = 70;
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = "#f3b174"; ctx.font = `700 16px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillText(`SHAPE ROTATOR · WEEK ${safeWeekIdx + 1} OF 10`, PAD, y);
  y += 50;
  ctx.fillStyle = "#f0e7df"; ctx.font = `italic 52px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillText(week.theme ? week.theme.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 26) : `Week ${safeWeekIdx + 1}`, PAD, y);
  y += 36;
  ctx.fillStyle = "#bcaea5"; ctx.font = `400 19px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillText((week.dateRange || "").toUpperCase(), PAD, y);
  y += 60;

  // ── days + events ────────────────────────────────────────────────────
  ctx.textBaseline = "top";
  for (const item of layout) {
    if (item.kind === "dayhead") {
      ctx.fillStyle = "#3a2c26"; ctx.fillRect(PAD, y + 2, COL, 1);
      ctx.textAlign = "left";
      ctx.fillStyle = "#f3b174"; ctx.font = `700 16px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillText((DAY_NAMES_FULL[item.d.name] || item.d.name).toUpperCase(), PAD, y + 22);
      ctx.textAlign = "right";
      ctx.fillStyle = "#8f817a"; ctx.font = `400 15px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillText(String(item.d.date).toUpperCase(), W - PAD, y + 23);
      ctx.textAlign = "left";
      y += 56;
      continue;
    }
    const hex = CAL_CAT_HEX[item.cat.key] || CAL_CAT_HEX.default;
    const ch = item.ch;
    // card — subtle category tint + full-height color rail
    ctx.fillStyle = item.cat.key === "default" ? "rgba(255,255,255,0.035)" : hexA(hex, 0.07);
    roundRect(ctx, PAD, y, COL, ch, 13); ctx.fill();
    ctx.fillStyle = hex; roundRect(ctx, PAD, y, 5, ch, 2.5); ctx.fill();
    const tx = PAD + PADX;
    let ty = y + 14;
    if (item.cat.label || item.cat.tbc) {
      const chipText = (item.cat.label || "").toUpperCase();
      ctx.font = CHIP_FONT; ctx.fillStyle = hex;
      if (chipText) ctx.fillText(chipText, tx, ty);
      if (item.cat.tbc) {
        const off = chipText ? ctx.measureText(chipText).width + 12 : 0;
        ctx.fillStyle = "#e3c77f"; roundRect(ctx, tx + off, ty - 2, 40, 17, 8); ctx.fill();
        ctx.fillStyle = "#161311"; ctx.font = `700 11px "JetBrains Mono", ui-monospace, monospace`;
        ctx.fillText("TBC", tx + off + 9, ty + 1);
      }
      ty += 24;
    }
    if (item.time) {
      ctx.font = TIME_FONT; ctx.fillStyle = "#e9dccb";
      ctx.fillText(item.time, tx, ty); ty += 22;
    }
    ctx.font = TITLE_FONT; ctx.fillStyle = "#f4ede3";
    for (const ln of item.titleLines) { ctx.fillText(ln, tx, ty); ty += TITLE_LH; }
    if (item.detailLines.length) {
      ty += 8;
      ctx.font = DET_FONT; ctx.fillStyle = "#b3a59b";
      for (const ln of item.detailLines) { ctx.fillText(ln, tx + 14, ty); ty += DET_LH; }
    }
    y += ch + 10;
  }
  ctx.textBaseline = "alphabetic";

  // ── footer ───────────────────────────────────────────────────────────
  y += 24;
  ctx.fillStyle = "#8f817a"; ctx.font = `400 15px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.fillText("SHAPE ROTATOR · COHORT CALENDAR · TENTATIVE — CONFIRM IN ANNOUNCEMENTS", W / 2, y);

  const dataUrl = cnv.toDataURL("image/png");
  const stamp = (week.dateRange || `week-${safeWeekIdx + 1}`).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filename = `shape-rotator-week-${safeWeekIdx + 1}-${stamp}`;
  if (typeof window !== "undefined" && window.api?.exportCalendar) {
    window.api.exportCalendar({ format: "png", dataUrl, filename }).catch(() => fallbackDownload(dataUrl, filename));
  } else {
    fallbackDownload(dataUrl, filename);
  }
}
function fallbackDownload(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl; a.download = `${filename}.png`;
  document.body.appendChild(a); a.click(); a.remove();
}
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function renderCalendarKeyBar() {
  const keys = CAL_CATEGORY_LEGEND.map(c => {
    // The "weekly / self-organized" legend item controls both the weekly
    // and the anarchy (self-organized) card colors, so it filters both.
    const cats = c.key === "weekly" ? "weekly anarchy" : c.key;
    return `<button class="cal-key" type="button" data-cal-filter="${escAttr(cats)}" data-cat="${escAttr(c.key)}" aria-pressed="true"><span class="cal-key-dot"></span>${escHtml(c.label)}</button>`;
  }).join("");
  return `<div class="cal-keybar" role="group" aria-label="filter by event category">${keys}<button class="cal-key cal-key--tbc" type="button" data-cal-filter="tbc" data-cat="tbc" aria-pressed="true"><span class="cal-key-dot"></span>TBC (tentative)</button></div>`;
}

// Parse one week's row from the calendar tab structure. Returns:
//   { dateRange, theme, weekStartMs, days: [{ name, date, isToday, isEmpty, blocks[], anchors[] }] }
export function parseWeekRow(row, weekIdx, eventsByDayMs = new Map()) {
  const meta = (row && row[1] != null ? String(row[1]) : "").split("\n");
  const dateRange = (meta[0] || "").trim().toLowerCase();
  const theme     = meta.slice(1).filter(s => s.trim()).join(" — ").toLowerCase();
  const weekStartMs = COHORT_START_MS + weekIdx * 7 * 86400000;
  const todayMs = localCalendarDayMs();

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

function dayIso(dayMs) {
  return new Date(dayMs).toISOString().slice(0, 10);
}

function matchFragments(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function normalizedMatchText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const SOURCE_LINE_STOPWORDS = new Set([
  "and", "the", "with", "transcript", "notes", "note", "session", "source",
  "project", "projects", "intro", "intros", "segment", "guests",
]);

function transcriptSourcesForBlock(matches, dateIso, blockText) {
  if (!Array.isArray(matches) || !dateIso || !blockText) return [];
  const hay = normalizedMatchText(blockText);
  const out = [];
  const seen = new Set();
  for (const match of matches) {
    if (!match || match.date !== dateIso) continue;
    const fragments = matchFragments(match.title_contains || match.contains || match.title);
    if (!fragments.length) continue;
    if (!fragments.every(fragment => hay.includes(normalizedMatchText(fragment)))) continue;
    for (const source of (match.sources || [])) {
      if (!source?.path) continue;
      const key = `${source.path}:${source.role || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...source,
        confidence: source.confidence || match.confidence || "high",
        section: source.section || match.section || "",
      });
    }
  }
  return out;
}

function sourceKey(source) {
  return `${source?.path || ""}:${source?.role || ""}`;
}

function sourceLineTokens(source) {
  const raw = `${source?.label || ""} ${source?.section || ""}`.toLowerCase();
  const tokens = raw.match(/[a-z0-9]+/g) || [];
  return [...new Set(tokens.filter(token => (
    token.length > 2 && !SOURCE_LINE_STOPWORDS.has(token)
  )))];
}

function sourcesForLine(sources = [], lineText = "") {
  const hay = normalizedMatchText(lineText);
  if (!hay) return [];
  return sources.filter(source => sourceLineTokens(source).some(token => hay.includes(token)));
}

function splitSourcesByLines(sources = [], lineTexts = []) {
  const byLine = lineTexts.map(line => sourcesForLine(sources, line));
  const matched = new Set();
  for (const lineSources of byLine) {
    for (const source of lineSources) matched.add(sourceKey(source));
  }
  return {
    byLine,
    fallback: sources.filter(source => !matched.has(sourceKey(source))),
  };
}

function renderTranscriptLink(source) {
  if (!source?.path) return "";
  const confidence = source.confidence || "high";
  const role = source.role === "notes" ? "notes" : "transcript";
  const label = source.label || source.section || role;
  const title = [source.section, label, confidence === "high" ? "" : confidence]
    .filter(Boolean)
    .join(" · ");
  return `
    <button class="cal-source-link"
            type="button"
            data-cal-transcript-path="${escAttr(source.path)}"
            data-confidence="${escAttr(confidence)}"
            aria-label="${escAttr(`open ${label}`)}"
            title="${escAttr(title)}">
      <span class="csl-role">${escHtml(role)}</span>
    </button>`;
}

function renderInlineTranscriptLinks(sources = []) {
  if (!sources.length) return "";
  return `<span class="cal-source-inline">${sources.map(renderTranscriptLink).join("")}</span>`;
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
function renderDayView({ days, dayIdx, theme, weekNum, phase, transcriptMatches = [] }) {
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
    // Split the rel label out so narrow viewports can hide it (the day
    // name + date + event count are still enough to identify the pill).
    const relSuffix = d.isToday
      ? `<span class="cdp-rel">today</span>`
      : d.relLabel ? `<span class="cdp-rel">${escHtml(d.relLabel)}</span>` : "";
    return `
      <button class="cal-day-pill ${d.isToday ? "is-today" : ""} ${d.isEmpty ? "is-empty" : ""}"
              data-cal-day-pick="${i}"
              aria-selected="${isSel}"
              type="button">
        <span class="cdp-name">${d.name}${relSuffix ? '<span class="cdp-rel-sep">·</span>' : ""}${relSuffix}</span>
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
      sources: transcriptSourcesForBlock(transcriptMatches, dayIso(day.dayMs), block),
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
    const lines = dedupeAdjacentLines(it.raw.split("\n").map(l => l.replace(/\s+$/, "")));
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
      const top  = raw.match(/^\s*-\s+(.+)$/);
      const deep = raw.match(/^\s{4,}-\s+(.+)$/);
      if (deep && bullets.length) {
        bullets[bullets.length - 1].sub.push(boldTimes(escHtml(deep[1].trim())));
      } else if (top) {
        const rawText = top[1].trim();
        bullets.push({ raw: rawText, text: boldTimes(escHtml(rawText)), sub: [] });
      } else {
        extras.push(`<div class="cda-row-meta">${boldTimes(escHtml(raw.trim()))}</div>`);
      }
    }
    const { byLine: bulletSources, fallback: titleSources } = splitSourcesByLines(it.sources, bullets.map(b => b.raw));
    const bulletsHtml = bullets.length
      ? `<ul class="cda-bullets">${bullets.map((b, bulletIdx) => {
          const sub = b.sub.length
            ? `<ul class="cda-bullets cda-bullets-sub">${b.sub.map(s => `<li>${s}</li>`).join("")}</ul>`
            : "";
          return `<li>${b.text}${renderInlineTranscriptLinks(bulletSources[bulletIdx])}${sub}</li>`;
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
          <h3 class="cda-row-title">${escHtml(title)}${renderInlineTranscriptLinks(titleSources)}</h3>
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

// renderWeekView({ data, weekIdx, dayIdx, sub, source, events, transcriptMatches, presenceHtml, surface })
//
//   data         — the raw calendar JSON (live or bundled)
//   weekIdx      — 0..9
//   sub          — "week" | "presence"
//   source       — "live" | "bundled" | null (null = no data; banner suppressed)
//   bundledStamp — "wed may 13 · 9:14am" or similar; shown in stale banner
//   events       — array of event records (from cohort.events) for anchor merge
//   transcriptMatches — reviewed date + block fragment links to local transcripts
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
  transcriptMatches = [],
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

  const isSnapshot = source === "snapshot";
  const isBundled = source === "bundled";
  const isStale   = isSnapshot || isBundled;

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
  // NB: the week grid is NOT a time-grid — events are stacked cards in
  // order, not positioned at their clock time. A "now" line drawn at
  // fraction-of-day therefore lands on an arbitrary card and reads as
  // "we're N minutes into this event" when we're not. The day view carries
  // the accurate now / past / up-next states instead, so the week view
  // deliberately omits a now-line.
  const dayCells = week.days.map(d => {
    const anchorRows = d.anchors.map(a => `
      <div class="cal-day-anchor" data-kind="${escAttr(a.kind)}">
        <span class="cda-glyph" aria-hidden="true">◆</span>
        <span class="cda-title">${escHtml(a.title)}</span>
        ${a.subtitle ? `<span class="cda-sub">${escHtml(a.subtitle)}</span>` : ""}
      </div>`).join("");
    const blockRows = d.blocks.map(b => {
      const sources = transcriptSourcesForBlock(transcriptMatches, dayIso(d.dayMs), b);
      return renderEventCard(b, sources);
    }).join("");
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
        transcriptMatches,
      })
    : "";

  return `
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
            <div class="cwh-titles">
              <h2 class="cwh-display"><em>week ${ordinal(safeWeekIdx + 1)} of ten</em></h2>
              <span class="cwh-range">${escHtml(week.dateRange || "—")}</span>
            </div>
            <button class="cal-png-btn" type="button" data-cal-png="${safeWeekIdx}" aria-label="save this week as a PNG">
              <span class="cpb-glyph" aria-hidden="true">⤓</span> save png
            </button>
          </header>
          ${renderCalendarKeyBar()}
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
            <span>source · <a href="${escAttr(CALENDAR_URL)}" data-external>os-web.shaperotator.xyz/calendar.json</a></span>
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

  // ── auto-scroll to today ─────────────────────────────────────────────
  // On desktop, the week grid is a horizontal scroller; center today's
  // column so a Friday/Saturday/Sunday "today" is not mounted offscreen.
  // On mobile, also move the page vertically so today's card sits just
  // under the sticky dateline.
  if (scrollToToday) {
    requestAnimationFrame(() => {
      const today = root.querySelector(".cal-day.is-today");
      const dateline = root.querySelector(".cal-dateline");
      if (!today) return;
      const scroller = root.querySelector(".cal-grid-scroller");
      if (scroller) {
        const left = today.offsetLeft - Math.max(0, (scroller.clientWidth - today.offsetWidth) / 2);
        scroller.scrollTo({ left: Math.max(0, left), behavior: "auto" });
      }
      if (mobile()) {
        const datelineH = dateline ? dateline.getBoundingClientRect().height : 0;
        const y = today.getBoundingClientRect().top + (window.pageYOffset || 0) - datelineH - 8;
        window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
      }
    });
  }

  // ── category legend → filters ────────────────────────────────────────
  // Each key in the week-view key bar is a toggle: click to hide that
  // category's cards, click again to show them (multi-select, everything
  // visible by default). The "weekly / self-organized" key controls both
  // the weekly and anarchy colors; the TBC key hides every tentative card
  // regardless of its category. Ephemeral by design — it resets when the
  // week re-renders, which reads as a fresh, unfiltered view per week.
  function applyCalFilter() {
    const offCats = new Set();
    let hideTbc = false;
    root.querySelectorAll(".cal-key[data-cal-filter]").forEach(k => {
      if (k.getAttribute("aria-pressed") === "false") {
        const f = k.getAttribute("data-cal-filter") || "";
        if (f === "tbc") hideTbc = true;
        else f.split(/\s+/).forEach(c => c && offCats.add(c));
      }
    });
    root.querySelectorAll(".cal-event").forEach(ev => {
      const cat = ev.getAttribute("data-cat") || "default";
      const off = offCats.has(cat) || (hideTbc && ev.classList.contains("is-tbc"));
      ev.classList.toggle("cal-event--off", off);
    });
  }
  function onCalFilterClick(e) {
    const key = e.target.closest && e.target.closest(".cal-key[data-cal-filter]");
    if (!key || !root.contains(key)) return;
    const wasOn = key.getAttribute("aria-pressed") !== "false";
    key.setAttribute("aria-pressed", String(!wasOn));
    key.classList.toggle("is-off", wasOn);
    applyCalFilter();
  }
  root.addEventListener("click", onCalFilterClick);

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
    root.removeEventListener("click", onCalFilterClick);
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

// Convenience: try the requested calendar URL first, fall back to the supplied bundle.
// Returns { data, source, bundledStamp }.
export async function loadCalendar({ bundled = null, fetchOpts = {}, url = CALENDAR_URL, source = "live" } = {}) {
  try {
    const r = await fetch(url, { cache: "no-store", ...fetchOpts });
    if (!r.ok) throw new Error("http " + r.status);
    const data = await r.json();
    return { data, source, bundledStamp: null };
  } catch (e) {
    if (bundled) {
      return { data: bundled, source: "bundled", bundledStamp: fmtSyncStamp(bundled.last_refresh) };
    }
    return { data: null, source: null, bundledStamp: null };
  }
}

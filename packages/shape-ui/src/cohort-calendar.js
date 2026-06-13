// cohort-calendar.js — shared canvas renderer for the cohort calendar.
//
// Program window comes from cohort-calendar-week.js so both surfaces
// agree on the same May 18 → Jul 26 ten-week span. Used as a lower
// bound when deriving the chart range from cohort.people windows —
// the canvas always extends through the program end even if the latest
// person record's dates_end is earlier (see #126).
import { PROGRAM_START_MS, PROGRAM_END_MS } from "./cohort-calendar-week.js";
//
// Gantt-style canvas: rows = people grouped by team, columns = days from
// program start → end. Each row shows the person's overall window as a
// filled bar in their hash-derived hue; absences render as a striped
// overlay so the visual delta between "in cohort" and "actually here"
// reads at a glance. A vertical "today" marker pulses on top.
//
// API:
//   buildCalendarRows(cohort)   → ordered [{ type, ... }] rows
//   drawCalendar(ctx, W, H, rows, start, end, numDays)
//   renderCohortCalendar({ container, cohort, range })  ← creates canvas
//
// Internal helpers (drawPersonRow, drawHeadcountStrip, roundRect,
// personColors, hsl) stay module-local.

// ── Layout + palette ──────────────────────────────────────────────────
const CAL_DAY_W      = 22;        // pixel width per day column
const CAL_ROW_H      = 32;        // height per person row
const CAL_HEADER_H   = 148;       // top — concurrent strip + month band + week labels + day numbers
const CAL_DENSITY_H  = 32;        // height of the concurrent-headcount strip above the grid
const CAL_TEAM_H     = 36;        // height of team-group header rows
const CAL_LEFT_W     = 240;       // left column — person labels
const CAL_PAD_R      = 40;
const CAL_PAD_B      = 40;
const CAL_FOOTER_H   = 64;        // bottom — date span + legend
// Palette tokens for the gantt are pulled from CSS custom properties
// at draw time via readCalPalette() so the canvas flips when the user
// toggles light/dark mode (data-theme on <html>). The defaults below
// are the dark-mode fallbacks used when the CSS hasn't loaded yet (the
// `let` ⇒ mutable; reassigned by readCalPalette before each draw).
let CAL_BG         = "#231F20";
// Lane background: lifted a notch (was #15120e) so the present/absent
// delta has somewhere to land. Bars on a near-black field read as one
// solid mass; on a slightly-warm field they pop.
let CAL_BG_LANE    = "#2C2728";
// Absence base: pulled darker than the lane so stripes ride on a solid
// hole, not on the same value as everywhere else.
let CAL_ABS_BASE   = "#1A1719";
let CAL_RULE       = "rgba(245, 243, 238, 0.07)";
let CAL_RULE_WEEK  = "rgba(245, 243, 238, 0.14)";
let CAL_INK_1      = "#f5f3ee";
let CAL_INK_2      = "#b8b4ab";
let CAL_INK_3      = "#7a7368";
let CAL_INK_4      = "#3a3833";
let CAL_OXIDE      = "#8F220E";  // today marker (xyz sr-red)
// Today-column wash + glow. Theme-driven (via --cal-today-band/glow, which key
// off --ink-rgb) so they don't stay near-white and vanish on the light/paper
// theme. The dark fallbacks below equal the prior hardcoded values exactly.
let CAL_TODAY_BAND = "rgba(245, 243, 238, 0.05)";
let CAL_TODAY_GLOW = "rgba(245, 243, 238, 0.07)";

// Refresh palette from CSS custom properties — keeps the imperatively
// drawn gantt aligned with the data-theme attribute on <html>. Called
// once at the top of drawCalendar() so every redraw picks up the
// current theme. CSS-side names mirror the JS constants 1:1.
function readCalPalette() {
  if (typeof document === "undefined") return;
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  CAL_BG        = pick("--cal-bg",        CAL_BG);
  CAL_BG_LANE   = pick("--cal-bg-lane",   CAL_BG_LANE);
  CAL_ABS_BASE  = pick("--cal-abs-base",  CAL_ABS_BASE);
  CAL_RULE      = pick("--cal-rule",      CAL_RULE);
  CAL_RULE_WEEK = pick("--cal-rule-week", CAL_RULE_WEEK);
  CAL_INK_1     = pick("--cal-ink-1",     CAL_INK_1);
  CAL_INK_2     = pick("--cal-ink-2",     CAL_INK_2);
  CAL_INK_3     = pick("--cal-ink-3",     CAL_INK_3);
  CAL_INK_4     = pick("--cal-ink-4",     CAL_INK_4);
  CAL_OXIDE     = pick("--cal-oxide",     CAL_OXIDE);
  CAL_TODAY_BAND = pick("--cal-today-band", CAL_TODAY_BAND);
  CAL_TODAY_GLOW = pick("--cal-today-glow", CAL_TODAY_GLOW);
}

// Reasonable defaults for the program; the wrapper API accepts an
// override range, and the surface data may eventually carry its own
// programStart/end which can be fed in directly. Sourced from
// cohort-calendar-week.js so the broadsheet and the gantt agree.
const CAL_PROGRAM_START_D = new Date(PROGRAM_START_MS);
const CAL_PROGRAM_END_D   = new Date(PROGRAM_END_MS);

// ── Date helpers (UTC-anchored to avoid TZ drift) ─────────────────────
function isoToDate(s) {
  if (!s) return null;
  // js-yaml (the live GitHub cohort load) parses ISO dates into Date
  // objects, while the bundled surface carries ISO strings. Accept both:
  // String(Date) is "Wed May 18 2026 …", which the regex below can't
  // read, and a silent null here erases every presence bar + the
  // headcount strip (see whats-new.js's stableStringify for the same
  // dual-shape issue on the fingerprint side).
  if (s instanceof Date) {
    return isNaN(s) ? null : new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  }
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
function fmtShortDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}
function fmtMonth(d) {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).toLowerCase();
}

// ── Row builder ───────────────────────────────────────────────────────
export function buildCalendarRows(cohort) {
  // Group people by team. Within each group: lead first, then alpha by name.
  // Teams without people are skipped — only show what's populated.
  // "_orphan" group (team: null) renders LAST as "individuals (no team)".
  const teams = cohort.teams || [];
  const people = cohort.people || [];
  const teamById = new Map(teams.map(t => [t.record_id, t]));

  const buckets = new Map();
  for (const p of people) {
    const key = p.team || "_orphan";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
    // Also list the person under each secondary team they touch. We
    // tag the clone with __secondary so the renderer can render them
    // with reduced emphasis (no "lead" indicator, etc.).
    const sec = Array.isArray(p.secondary_teams) ? p.secondary_teams : [];
    for (const stk of sec) {
      if (!stk) continue;
      if (!buckets.has(stk)) buckets.set(stk, []);
      buckets.get(stk).push({ ...p, __secondary: true, role: p.role === "lead" ? null : p.role });
    }
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const al = a.role === "lead" ? 0 : 1;
      const bl = b.role === "lead" ? 0 : 1;
      if (al !== bl) return al - bl;
      return String(a.name || a.record_id).localeCompare(String(b.name || b.record_id));
    });
  }

  // Order team groups: leads-with-cards first (by team name), orphan last.
  const orderedKeys = Array.from(buckets.keys()).filter(k => k !== "_orphan").sort((a, b) => {
    const ta = teamById.get(a)?.name || a;
    const tb = teamById.get(b)?.name || b;
    return String(ta).localeCompare(String(tb));
  });
  if (buckets.has("_orphan")) orderedKeys.push("_orphan");

  const rows = [];
  for (const key of orderedKeys) {
    const t = key === "_orphan"
      ? { record_id: "_orphan", name: "individuals", kind: null }
      : (teamById.get(key) || { record_id: key, name: key, kind: null });
    rows.push({ type: "team", team: t });
    for (const p of buckets.get(key)) rows.push({ type: "person", person: p, team: t });
  }
  return rows;
}

// ── Top-level canvas painter ──────────────────────────────────────────
export function drawCalendar(ctx, W, H, rows, start, end, numDays) {
  // Pull palette from CSS custom properties so the gantt respects the
  // current data-theme. Cheap enough to run every draw (string copies).
  readCalPalette();

  // Background: cleared (transparent) so the page's radial gradient shows
  // through the gantt instead of a flat grey panel. The pinned freeze panes
  // lay down their own opaque backdrop (see mountGanttFreezePanes) so
  // scrolled bars don't bleed through the name column / date header, and the
  // PNG/PDF export flattens onto the page colour (see exportCalendar).
  ctx.clearRect(0, 0, W, H);

  const gridX = CAL_LEFT_W;
  const gridY = CAL_HEADER_H;
  const gridW = numDays * CAL_DAY_W;
  // Compute body height from rows.
  let bodyH = 0;
  for (const r of rows) bodyH += (r.type === "team" ? CAL_TEAM_H : CAL_ROW_H);
  const gridH = bodyH;

  // ── Concurrent-headcount strip ─────────────────────────────────────
  drawHeadcountStrip(ctx, rows, start, numDays, gridX);

  // ── Month band — italic Iowan, with a thin baseline above
  ctx.strokeStyle = CAL_RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gridX, CAL_DENSITY_H + 14 + 0.5);
  ctx.lineTo(gridX + numDays * CAL_DAY_W, CAL_DENSITY_H + 14 + 0.5);
  ctx.stroke();
  ctx.font = `italic 22px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.textBaseline = "alphabetic";
  let segStart = 0;
  let segDate = new Date(start);
  for (let i = 1; i <= numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const isLast = i === numDays;
    if (d.getUTCMonth() !== segDate.getUTCMonth() || isLast) {
      const endIdx = isLast ? numDays : i;
      const x = gridX + segStart * CAL_DAY_W;
      const wSeg = (endIdx - segStart) * CAL_DAY_W;
      ctx.fillStyle = CAL_INK_1;
      ctx.globalAlpha = 0.88;
      ctx.fillText(fmtMonth(segDate), x + 6, CAL_DENSITY_H + 12);
      ctx.globalAlpha = 1;
      // Right hairline of month
      ctx.strokeStyle = CAL_RULE_WEEK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + wSeg + 0.5, CAL_HEADER_H - 28);
      ctx.lineTo(x + wSeg + 0.5, CAL_HEADER_H + gridH);
      ctx.stroke();
      segStart = i;
      segDate = d;
    }
  }

  // ── Week zebra (alternating tint per week) ─────────────────────────
  let weekIdx = 0;
  let weekStartCol = 0;
  for (let i = 0; i <= numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const isMonday = i > 0 && d.getUTCDay() === 1;
    const isLast = i === numDays;
    if (isMonday || isLast) {
      const x = gridX + weekStartCol * CAL_DAY_W;
      const w = (i - weekStartCol) * CAL_DAY_W;
      if (weekIdx % 2 === 1) {
        ctx.fillStyle = "rgba(245, 243, 238, 0.022)";
        ctx.fillRect(x, gridY, w, gridH);
      }
      weekStartCol = i;
      weekIdx++;
    }
  }
  // Weekend deeper tint on top of the zebra so Sat/Sun pop within weeks.
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) {
      const x = gridX + i * CAL_DAY_W;
      ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
      ctx.fillRect(x, gridY, CAL_DAY_W, gridH);
    }
  }

  // ── Week labels (W01, W02, ...) above the day numbers ─────────────
  weekIdx = 0;
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    if (i === 0 || d.getUTCDay() === 1) {
      weekIdx++;
      const x = gridX + i * CAL_DAY_W;
      ctx.font = `italic 16px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
      ctx.fillStyle = CAL_INK_1;
      ctx.globalAlpha = 0.90;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`w${String(weekIdx).padStart(2, "0")}`, x + 6, CAL_HEADER_H - 38);
      ctx.globalAlpha = 1;
    }
  }

  // ── Day-of-week single-letter strip (M T W T F S S) above numbers ─
  ctx.font = `500 8.5px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  const dowLetters = ["S", "M", "T", "W", "T", "F", "S"];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const x = gridX + i * CAL_DAY_W;
    const dow = d.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    ctx.fillStyle = CAL_INK_1;
    ctx.globalAlpha = isWeekend ? 0.32 : 0.55;
    ctx.fillText(dowLetters[dow], x + CAL_DAY_W / 2, CAL_HEADER_H - 24);
  }
  ctx.globalAlpha = 1;

  // ── Day-number strip + verticals ───────────────────────────────────
  ctx.font = `500 12.5px "JetBrains Mono", "Berkeley Mono", ui-monospace, monospace`;
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const x = gridX + i * CAL_DAY_W;
    const day = d.getUTCDate();
    const dow = d.getUTCDay();
    const isMonday = dow === 1;
    const isFirstOfMonth = day === 1;
    const isWeekend = dow === 0 || dow === 6;
    ctx.fillStyle = CAL_INK_1;
    ctx.globalAlpha = isMonday || isFirstOfMonth ? 0.95 : (isWeekend ? 0.45 : 0.72);
    ctx.textAlign = "center";
    ctx.fillText(String(day), x + CAL_DAY_W / 2, CAL_HEADER_H - 8);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    if (isFirstOfMonth) {
      ctx.strokeStyle = "rgba(245, 243, 238, 0.42)";
      ctx.lineWidth = 2;
    } else if (isMonday) {
      ctx.strokeStyle = "rgba(245, 243, 238, 0.36)";
      ctx.lineWidth = 1.5;
    } else {
      ctx.strokeStyle = "rgba(245, 243, 238, 0.05)";
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x + 0.5, CAL_HEADER_H - 16);
    ctx.lineTo(x + 0.5, CAL_HEADER_H + gridH);
    ctx.stroke();
  }
  // Closing vertical at the very right edge.
  ctx.strokeStyle = "rgba(245, 243, 238, 0.36)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(gridX + numDays * CAL_DAY_W + 0.5, CAL_HEADER_H - 16);
  ctx.lineTo(gridX + numDays * CAL_DAY_W + 0.5, CAL_HEADER_H + gridH);
  ctx.stroke();

  // ── Body rows ───────────────────────────────────────────────────────
  let y = gridY;
  ctx.textBaseline = "middle";
  for (const r of rows) {
    if (r.type === "team") {
      ctx.strokeStyle = CAL_RULE_WEEK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
      const tcol = personColors(r.team.record_id || r.team.name || "_");
      ctx.fillStyle = hsl(tcol.hue, 0.70, 0.55, 1);
      ctx.fillRect(6, y + 10, 4, CAL_TEAM_H - 20);
      ctx.font = `500 11px "JetBrains Mono", "Berkeley Mono", ui-monospace, monospace`;
      ctx.fillStyle = CAL_INK_1;
      ctx.globalAlpha = 0.95;
      ctx.textAlign = "left";
      const label = String(r.team.name || "—").toUpperCase();
      const track = 1.4;
      let lx = 18;
      for (const ch of label) {
        ctx.fillText(ch, lx, y + CAL_TEAM_H / 2 + 1);
        lx += ctx.measureText(ch).width + track;
      }
      if (r.team.kind === "project") {
        ctx.font = `italic 9.5px "JetBrains Mono", ui-monospace, monospace`;
        ctx.globalAlpha = 0.55;
        ctx.fillText("· project", lx + 6, y + CAL_TEAM_H / 2 + 1);
      }
      ctx.globalAlpha = 1;
      y += CAL_TEAM_H;
      continue;
    }
    // Person row
    const p = r.person;
    const colors = personColors(p.record_id || p.name || "_");
    drawPersonRow(ctx, p, colors, gridX, y, gridW, numDays, start, end);
    y += CAL_ROW_H;
  }

  // Bottom hairline of grid
  ctx.strokeStyle = CAL_RULE_WEEK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(W, y + 0.5);
  ctx.stroke();

  // ── "Today" indicator — column band + line + glow + label puck ────
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const dayIdx = daysBetween(start, todayUTC);
  if (dayIdx >= 0 && dayIdx < numDays) {
    const x = gridX + dayIdx * CAL_DAY_W;
    ctx.fillStyle = CAL_TODAY_BAND;
    ctx.fillRect(x, CAL_HEADER_H - 18, CAL_DAY_W, gridH + 18);
    const grad = ctx.createLinearGradient(x - 6, 0, x + CAL_DAY_W + 6, 0);
    grad.addColorStop(0,   "transparent");
    grad.addColorStop(0.5, CAL_TODAY_GLOW);
    grad.addColorStop(1,   "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(x - 6, CAL_HEADER_H - 18, CAL_DAY_W + 12, gridH + 18);
    const xc = x + CAL_DAY_W / 2;
    // Today line in ink (white on dark, dark on paper) — the red puck above
    // already carries the accent; a red line through the bars read as alarm.
    ctx.strokeStyle = CAL_INK_1;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xc, CAL_HEADER_H - 6);
    ctx.lineTo(xc, CAL_HEADER_H + gridH);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Puck in ink too — the whole today marker reads white-on-dark
    // (dark-on-paper in light mode), no red anywhere in the gantt.
    ctx.fillStyle = CAL_INK_1;
    const puckW = 50;
    const puckH = 16;
    const puckX = Math.max(gridX, xc - puckW / 2);
    const puckY = CAL_HEADER_H - 18;
    roundRect(ctx, puckX, puckY, puckW, puckH, 8);
    ctx.fill();
    ctx.fillStyle = CAL_BG;
    ctx.font = `600 9px "JetBrains Mono", "Berkeley Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("TODAY", puckX + puckW / 2, puckY + puckH / 2 + 0.5);
    ctx.textAlign = "left";
  } else if (dayIdx < 0) {
    const daysUntil = -dayIdx;
    const label = `T-${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
    ctx.fillStyle = CAL_INK_1;
    const puckW = ctx.measureText ? Math.max(72, label.length * 8 + 24) : 96;
    const puckH = 16;
    const puckX = gridX + 6;
    const puckY = CAL_HEADER_H - 18;
    roundRect(ctx, puckX, puckY, puckW, puckH, 8);
    ctx.fill();
    ctx.fillStyle = CAL_BG;
    ctx.font = `600 9px "JetBrains Mono", "Berkeley Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label, puckX + puckW / 2, puckY + puckH / 2 + 0.5);
    ctx.textAlign = "left";
  }

  // ── Footer: program span ───────────────────────────────────────────
  const footerY = CAL_HEADER_H + gridH + 18;
  ctx.font = `400 10px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_3;
  ctx.globalAlpha = 0.7;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`shape rotator · summer 2026 · ${fmtShortDate(start)} – ${fmtShortDate(end)}`, 20, footerY);
  ctx.globalAlpha = 1;
}

function drawPersonRow(ctx, person, colors, gridX, rowY, gridW, numDays, start, end) {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `italic 13.5px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.85;
  const name = person.name || person.record_id || "—";
  ctx.fillText(name, 34, rowY + CAL_ROW_H / 2);
  ctx.globalAlpha = 1;

  // Lane background
  ctx.fillStyle = CAL_BG_LANE;
  ctx.fillRect(gridX, rowY + 4, gridW, CAL_ROW_H - 8);

  // Window: dates_start..dates_end clipped to [start, end]
  const pStart = isoToDate(person.dates_start);
  const pEnd   = isoToDate(person.dates_end);
  if (!pStart || !pEnd) return;
  const winStartIdx = Math.max(0, daysBetween(start, pStart));
  const winEndIdx   = Math.min(numDays - 1, daysBetween(start, pEnd));
  if (winEndIdx < winStartIdx) return;
  const winX = gridX + winStartIdx * CAL_DAY_W;
  const winW = (winEndIdx - winStartIdx + 1) * CAL_DAY_W;

  // Bar body — vivid per-person hue with a vertical gradient from hue1
  // (top, brighter) to hue2 (bottom, slightly darker). The previous pass
  // anchored every bar at s=0.55, l=0.62 and reserved per-person hue for
  // a 1px hairline — at that fidelity the row of bars read as a single
  // gray slab no matter who was who. Saturation is now strong enough
  // (0.78) that every person's hash-derived hue reads as a real color
  // against the warm-dark lane, and the gradient gives the bar enough
  // body so it doesn't feel like a flat sticker.
  const barTop = rowY + 5;
  const barBot = rowY + CAL_ROW_H - 5;
  const barH   = barBot - barTop;
  const bodyS = 0.78;
  const bodyL = 0.62;
  const grad = ctx.createLinearGradient(winX, barTop, winX, barBot);
  grad.addColorStop(0,    hsl(colors.hue,  bodyS, bodyL + 0.06, 1));
  grad.addColorStop(0.55, hsl(colors.hue,  bodyS, bodyL,        1));
  grad.addColorStop(1,    hsl(colors.hue2, bodyS, bodyL - 0.08, 1));
  ctx.fillStyle = grad;
  ctx.fillRect(winX, barTop, winW, barH);

  // Edge accents — brighter top hairline lifts the bar visually; a
  // shadow on the bottom grounds it. Both keep their hue-neutral
  // alphas so the body's color dominates.
  ctx.fillStyle = "rgba(255,255,255,0.30)";
  ctx.fillRect(winX, barTop, winW, 1);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(winX, barBot - 1, winW, 1);

  // Absences — striped overlay. The base block dips BELOW the lane so the
  // hole reads as a hole; the stripes are bright enough (0.42 vs the old
  // 0.18) that the diagonal pattern is recognizable at the canvas's
  // native resolution. Stripe spacing tightened to 5px for denser texture.
  const absences = Array.isArray(person.absences) ? person.absences : [];
  for (const ab of absences) {
    const aS = isoToDate(ab.start);
    const aE = isoToDate(ab.end);
    if (!aS || !aE) continue;
    const aStartIdx = Math.max(winStartIdx, daysBetween(start, aS));
    const aEndIdx   = Math.min(winEndIdx, daysBetween(start, aE));
    if (aEndIdx < aStartIdx) continue;
    const aX = gridX + aStartIdx * CAL_DAY_W;
    const aW = (aEndIdx - aStartIdx + 1) * CAL_DAY_W;
    // Solid darker block under the stripes so absence is unambiguously
    // distinct from "no data" / lane background.
    ctx.fillStyle = CAL_ABS_BASE;
    ctx.fillRect(aX, barTop, aW, barH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(aX, barTop, aW, barH);
    ctx.clip();
    ctx.strokeStyle = `rgba(245, 243, 238, 0.42)`;
    ctx.lineWidth = 1.2;
    const stripeSpacing = 5;
    ctx.beginPath();
    for (let sx = aX - barH; sx < aX + aW + barH; sx += stripeSpacing) {
      ctx.moveTo(sx, barBot);
      ctx.lineTo(sx + barH, barTop);
    }
    ctx.stroke();
    ctx.restore();
    // Edge ticks framing the absence so the start/end boundary reads
    // crisply even when stripes don't quite land on the edge.
    ctx.strokeStyle = `rgba(245, 243, 238, 0.55)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(aX + 0.5, barTop);
    ctx.lineTo(aX + 0.5, barBot);
    ctx.moveTo(aX + aW - 0.5, barTop);
    ctx.lineTo(aX + aW - 0.5, barBot);
    ctx.stroke();
  }
}

function drawHeadcountStrip(ctx, rows, start, numDays, gridX) {
  const counts = new Array(numDays).fill(0);
  let maxCount = 0;
  for (const r of rows) {
    if (r.type !== "person") continue;
    const p = r.person;
    const pStart = isoToDate(p.dates_start);
    const pEnd   = isoToDate(p.dates_end);
    if (!pStart || !pEnd) continue;
    const s = Math.max(0, daysBetween(start, pStart));
    const e = Math.min(numDays - 1, daysBetween(start, pEnd));
    const absences = (Array.isArray(p.absences) ? p.absences : [])
      .map(ab => ({ s: isoToDate(ab.start), e: isoToDate(ab.end) }))
      .filter(ab => ab.s && ab.e);
    for (let i = s; i <= e; i++) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      let absent = false;
      for (const ab of absences) {
        if (day >= ab.s && day <= ab.e) { absent = true; break; }
      }
      if (!absent) counts[i]++;
    }
    if (e >= s && e < numDays) maxCount = Math.max(maxCount, counts[e]);
  }
  for (const c of counts) if (c > maxCount) maxCount = c;
  if (maxCount === 0) return;

  const stripY = 6;
  const stripH = CAL_DENSITY_H - 10;
  ctx.save();
  const grad = ctx.createLinearGradient(0, stripY, 0, stripY + stripH);
  grad.addColorStop(0,   "rgba(245, 243, 238, 0.16)");
  grad.addColorStop(1,   "rgba(245, 243, 238, 0.02)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(gridX, stripY + stripH);
  for (let i = 0; i < numDays; i++) {
    const v = counts[i] / maxCount;
    const top = stripY + (1 - v) * stripH;
    const x0 = gridX + i * CAL_DAY_W;
    const x1 = x0 + CAL_DAY_W;
    ctx.lineTo(x0, top);
    ctx.lineTo(x1, top);
  }
  ctx.lineTo(gridX + numDays * CAL_DAY_W, stripY + stripH);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = "rgba(245, 243, 238, 0.40)";
  ctx.lineWidth = 1;
  for (let i = 0; i < numDays; i++) {
    const v = counts[i] / maxCount;
    const top = stripY + (1 - v) * stripH;
    const x0 = gridX + i * CAL_DAY_W;
    const x1 = x0 + CAL_DAY_W;
    if (i === 0) ctx.moveTo(x0, top);
    else ctx.lineTo(x0, top);
    ctx.lineTo(x1, top);
  }
  ctx.stroke();
  ctx.restore();
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

// FNV-1a hash → two hues in [0,1) for a person, matching the shader's
// per-team palette derivation so each individual's color in the calendar
// echoes their shape on the grid.
function personColors(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const a =  h         & 0xff;
  const b = (h >>> 8)  & 0xff;
  return {
    hue:  a / 255,
    hue2: (a / 255 + 0.33 + (b / 255) * 0.34) % 1,
  };
}

function hsl(h, s, l, a) {
  function f(n) {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `rgba(${r},${g},${b},${a == null ? 1 : a})`;
}

// ── Convenience wrapper ────────────────────────────────────────────────
// Creates a <canvas> inside container, sizes it for DPR, paints. Returns
// the canvas element + the computed size so callers can hook export.
//
// range defaults to the cohort's earliest dates_start → latest dates_end
// across people; if those are missing, falls back to the program-window
// defaults Shape Rotator OS ships with.
export function renderCohortCalendar({ container, cohort, range }) {
  if (!container) return null;
  const r = resolveRange(cohort, range);
  const start = r.start;
  const end   = r.end;
  const numDays = daysBetween(start, end) + 1;
  const rows = buildCalendarRows(cohort || {});
  let bodyH = 0;
  for (const row of rows) bodyH += (row.type === "team" ? CAL_TEAM_H : CAL_ROW_H);
  const w = CAL_LEFT_W + numDays * CAL_DAY_W + CAL_PAD_R;
  const h = CAL_HEADER_H + bodyH + CAL_FOOTER_H + CAL_PAD_B;

  const cnv = document.createElement("canvas");
  cnv.className = "shape-cohort-calendar";
  const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
  cnv.width  = Math.round(w * dpr);
  cnv.height = Math.round(h * dpr);
  cnv.style.width  = w + "px";
  cnv.style.height = h + "px";
  container.appendChild(cnv);

  const ctx = cnv.getContext("2d");
  ctx.scale(dpr, dpr);
  drawCalendar(ctx, w, h, rows, start, end, numDays);

  return { canvas: cnv, width: w, height: h, rows, start, end, numDays };
}

function resolveRange(cohort, range) {
  // Explicit range wins.
  if (range && (range.start || range.end)) {
    const s = range.start instanceof Date ? range.start : isoToDate(range.start) || CAL_PROGRAM_START_D;
    const e = range.end   instanceof Date ? range.end   : isoToDate(range.end)   || CAL_PROGRAM_END_D;
    return { start: s, end: e };
  }
  // Derive from cohort.people windows, but clamp to the program span so
  // the chart always covers the full cohort — even if every person's
  // dates_end falls before the program end (which was the #126 bug).
  const people = (cohort && cohort.people) || [];
  let minStart = null;
  let maxEnd   = null;
  for (const p of people) {
    const s = isoToDate(p.dates_start);
    const e = isoToDate(p.dates_end);
    if (s && (!minStart || s < minStart)) minStart = s;
    if (e && (!maxEnd   || e > maxEnd))   maxEnd   = e;
  }
  const start = (minStart && minStart < CAL_PROGRAM_START_D) ? minStart : CAL_PROGRAM_START_D;
  const end   = (maxEnd   && maxEnd   > CAL_PROGRAM_END_D)   ? maxEnd   : CAL_PROGRAM_END_D;
  return { start, end };
}

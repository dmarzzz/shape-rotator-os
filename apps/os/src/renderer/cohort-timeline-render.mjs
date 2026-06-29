// cohort-timeline-render.mjs — pure HTML-string renderer for the cohort Timeline
// lane view. Takes the structure from buildDefaultTimeline (axis + lanes) and
// emits absolutely-positioned markers on a shared program-time axis. Pure +
// DOM-free so it's unit-testable under node --test; the alchemy view mounts the
// returned string into the canvas and the CSS (cohort-timeline-view.css) does
// the visuals. No fetch, no cross-module imports.

function escHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function pct(n) {
  const v = Number.isFinite(n) ? n : 0;
  return (Math.max(0, Math.min(1, v)) * 100).toFixed(2) + "%";
}
const DAY_MS = 86400000;

// Weekly tick labels across the program window (month/day), for the axis header.
function axisTicks(axis) {
  const { startMs, endMs } = axis || {};
  if (!(endMs > startMs)) return [];
  const ticks = [];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let ms = startMs, i = 0; ms <= endMs; ms += 7 * DAY_MS, i += 1) {
    const d = new Date(ms);
    const frac = (ms - startMs) / (endMs - startMs);
    ticks.push({ frac, label: i % 2 === 0 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : "" });
  }
  return ticks;
}

function pointMarkers(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => {
      const cat = escHtml(it.category || "update");
      const basis = it.basis ? ` data-basis="${escHtml(it.basis)}"` : "";
      const team = it.team ? ` data-const-team="${escHtml(it.team)}"` : "";
      const future = it.isFuture ? " is-future" : "";
      const title = escHtml([it.title, it.detail].filter(Boolean).join(" — "));
      return `<button type="button" class="ctl-dot${future}" data-cat="${cat}"${basis}${team} style="left:${pct(it.fraction)}" title="${title}" aria-label="${title}"></button>`;
    })
    .join("");
}

// ── interactive mode helpers (the calendar follow-board) ──────────────────────
// In interactive mode each point becomes a click-to-reveal marker carrying its
// full payload as data-* attrs (read back by openCalendarTimelineItem), plus a
// hover tooltip string (data-tip). Read-only mode is untouched above.

const TIP_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "jun 24" from an ISO date — lowercase month + day-of-month, UTC to match axis.
function tipDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${TIP_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// "jun 24 · release · <title>" — the hover bubble text. Title truncated ~40 chars
// so the bubble stays a single readable line.
function tipText(it) {
  const date = tipDate(it.date);
  const kind = String(it.category || "update");
  let title = String(it.title || "").trim();
  if (title.length > 40) title = title.slice(0, 39).trimEnd() + "…";
  return [date, kind, title].filter(Boolean).join(" · ");
}

// Revealable point markers — one .ctl-dot per item, each tagged data-c2-timeline-item
// so alchemy's reveal delegate can open the popover, plus the data-* payload it reads.
// No data-const-team here: the old direct-to-dossier click is replaced by the reveal
// ("open team →" lives inside the popover, driven by data-team).
function pointMarkersInteractive(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => {
      const cat = escHtml(it.category || "update");
      const basis = it.basis ? ` data-basis="${escHtml(it.basis)}"` : "";
      const team = it.team ? ` data-team="${escHtml(it.team)}"` : "";
      const future = it.isFuture ? " is-future" : "";
      const title = escHtml(it.title || "");
      const detail = escHtml(it.detail || "");
      const date = escHtml(it.date || "");
      const tip = escHtml(tipText(it));
      return `<button type="button" class="ctl-dot${future}" data-cat="${cat}" data-c2-timeline-item data-kind="${cat}" data-title="${title}" data-detail="${detail}" data-date="${date}"${team}${basis} data-tip="${tip}" style="left:${pct(it.fraction)}" aria-label="${title}"></button>`;
    })
    .join("");
}

// Glyph SVGs keyed by lane kind — small 16px line icons. Mirrors calendar.js
// ROW_ICON; releases/commits/presence/team reuse the same paths; activity,
// meetings, insights, standing, sessions get matching siblings.
export const LANE_GLYPH = {
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  releases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',
  commits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/></svg>',
  meetings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  insights: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>',
  standing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="4" width="3" height="14"/></svg>',
  presence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h3"/></svg>',
};
const laneGlyph = (kind) => LANE_GLYPH[kind] || LANE_GLYPH.team;

function standingMarkers(lane) {
  const max = Number(lane?.stageMax) || 8;
  return (Array.isArray(lane?.points) ? lane.points : [])
    .filter((p) => p && p.stage != null && Number.isFinite(p.fraction))
    .map((p) => {
      const h = Math.max(0, Math.min(1, Number(p.stage) / max));
      const title = escHtml(`${p.label || "week"} · mean stage ${Number(p.stage).toFixed(1)} (${p.teamsWithData} teams)`);
      return `<span class="ctl-bar" style="left:${pct(p.fraction)};height:${pct(h)}" title="${title}"></span>`;
    })
    .join("");
}

function presenceMarkers(lane) {
  return (Array.isArray(lane?.samples) ? lane.samples : [])
    .map((s) => {
      const h = Math.max(0, Math.min(1, Number(s.occupancy) || 0));
      const future = s.isFuture ? " is-future" : "";
      const title = escHtml(`${s.present}/${s.total} in town`);
      return `<span class="ctl-band${future}" style="left:${pct(s.fraction)};height:${pct(h)}" title="${title}"></span>`;
    })
    .join("");
}

function laneHtml(lane, axis) {
  const label = escHtml(lane?.label || lane?.trackKey || "");
  let body = "";
  let count = 0;
  if (lane?.trackKey === "standing") { body = standingMarkers(lane); count = (lane.points || []).filter((p) => p && p.stage != null).length; }
  else if (lane?.trackKey === "presence") { body = presenceMarkers(lane); count = (lane.samples || []).length; }
  else { body = pointMarkers(lane?.items); count = (lane?.items || []).length; }
  const nowLine = Number.isFinite(axis?.nowFraction)
    ? `<span class="ctl-now" style="left:${pct(axis.nowFraction)}"></span>` : "";
  return `
    <div class="ctl-lane" data-track="${escHtml(lane?.trackKey || "")}">
      <div class="ctl-lane-label">${label}<span class="ctl-lane-count">${count}</span></div>
      <div class="ctl-lane-track">${nowLine}${body}</div>
    </div>`;
}

// Interactive lane — a controllable follow-board row. Carries the subscription id
// (for reorder/remove), a drag handle + ▴▾ keys, a kind glyph, an ellipsis label,
// a count, and a remove ✕. Standing/presence markers are NOT individually
// revealable (only .ctl-dot points are) so they stay plain bars/bands.
function laneHtmlInteractive(lane, axis) {
  const id = escHtml(lane?.id || "");
  const kind = escHtml(lane?.kind || lane?.trackKey || "");
  const render = lane?.render || lane?.trackKey;
  const label = escHtml(lane?.label || lane?.trackKey || "");
  let body = "";
  let count = 0;
  if (render === "standing") { body = standingMarkers(lane); count = (lane.points || []).filter((p) => p && p.stage != null).length; }
  else if (render === "presence") { body = presenceMarkers(lane); count = (lane.samples || []).length; }
  else { body = pointMarkersInteractive(lane?.items); count = (lane?.items || []).length; }
  if (Number.isFinite(lane?.count)) count = lane.count;
  const nowLine = Number.isFinite(axis?.nowFraction)
    ? `<span class="ctl-now" style="left:${pct(axis.nowFraction)}"></span>` : "";
  return `
    <div class="ctl-lane is-followed" data-c2-subrow-id="${id}" data-row-kind="${kind}" data-track="${escHtml(lane?.trackKey || "")}">
      <div class="ctl-lane-label rr-frowlab" draggable="true" tabindex="0" role="button"
           title="drag to reorder · ${label}" aria-label="${label} lane — drag, ▴▾, or Alt+↑/↓ to reorder">
        <span class="rr-row-move" aria-hidden="true">
          <button class="rr-row-mv" data-c2-subrow-move="up"   type="button" tabindex="-1" draggable="false" title="move up">▴</button>
          <button class="rr-row-mv" data-c2-subrow-move="down" type="button" tabindex="-1" draggable="false" title="move down">▾</button>
        </span>
        <span class="ctl-lane-ico rr-rowlab-ico" aria-hidden="true">${laneGlyph(kind)}</span>
        <span class="ctl-lane-tx">${label}</span>
        <span class="ctl-lane-count">${count}</span>
        <button class="rr-rowlab-x" data-c2-subrow-remove="${id}" type="button" draggable="false"
                title="remove row" aria-label="remove ${label} lane">×</button>
      </div>
      <div class="ctl-lane-track">${nowLine}${body}</div>
    </div>`;
}

// Render the whole timeline. `timeline` is { axis, lanes } from
// buildDefaultTimeline (read-only) or buildFollowedTimeline (interactive).
// Returns an HTML string (empty axis ⇒ a friendly note).
//
// Options:
//   { interactive = false }  — when true (the calendar follow-board) each lane
//     becomes a controllable row (drag handle, ▴▾, glyph, count, remove ✕) and
//     point markers become click-to-reveal (.ctl-dot[data-c2-timeline-item] with
//     the full data-* payload + a data-tip hover string). When false (the legacy
//     standalone preview) the output is byte-for-byte unchanged.
export function renderTimelineLanesHtml(timeline, { interactive = false } = {}) {
  const axis = timeline?.axis || {};
  const lanes = Array.isArray(timeline?.lanes) ? timeline.lanes : [];
  if (!(axis.endMs > axis.startMs)) {
    return `<div class="ctl"><p class="ctl-empty">timeline window unavailable</p></div>`;
  }
  const ticks = axisTicks(axis)
    .map((t) => `<span class="ctl-tick" style="left:${pct(t.frac)}">${t.label ? `<i>${escHtml(t.label)}</i>` : ""}</span>`)
    .join("");
  const nowHead = Number.isFinite(axis.nowFraction)
    ? `<span class="ctl-now-head" style="left:${pct(axis.nowFraction)}" title="now">now</span>` : "";
  // Interactive (follow-board) mode: controllable lanes + revealable markers, and
  // a friendly empty state when nothing is followed yet.
  if (interactive) {
    const lanesHtml = lanes.length
      ? lanes.map((l) => laneHtmlInteractive(l, axis)).join("")
      : `<p class="ctl-empty">no lanes followed — add one</p>`;
    return `
    <div class="ctl">
      <div class="ctl-axis">${ticks}${nowHead}</div>
      <div class="ctl-lanes">${lanesHtml}</div>
      <div class="ctl-legend">
        <span data-cat="release">release</span>
        <span data-cat="commit">commits</span>
        <span data-cat="insight">session insight</span>
        <span data-cat="ask">ask</span>
        <span data-cat="event">event</span>
        <span class="ctl-legend-inferred">○ inferred</span>
      </div>
    </div>`;
  }
  return `
    <div class="ctl">
      <div class="ctl-axis">${ticks}${nowHead}</div>
      <div class="ctl-lanes">${lanes.map((l) => laneHtml(l, axis)).join("")}</div>
      <div class="ctl-legend">
        <span data-cat="release">release</span>
        <span data-cat="commit">commits</span>
        <span data-cat="insight">session insight</span>
        <span data-cat="ask">ask</span>
        <span data-cat="event">event</span>
        <span class="ctl-legend-inferred">○ inferred</span>
      </div>
    </div>`;
}

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

// Render the whole timeline. `timeline` is { axis, lanes } from
// buildDefaultTimeline. Returns an HTML string (empty axis ⇒ a friendly note).
export function renderTimelineLanesHtml(timeline) {
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

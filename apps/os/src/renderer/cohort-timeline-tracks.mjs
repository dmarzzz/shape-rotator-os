// Pure, DOM-free normalization for the cohort Timeline view.
//
// Turns already-loaded PUBLIC surface data (whats_new, people presence, per-week
// standing) into placeable "lane" structures on a shared program-time axis. The
// Timeline view stacks these lanes under a calendar header so updates read on one
// continuous axis — past on the left, scheduled future on the right.
//
// Design notes:
//   - No fetch, no DOM, no cross-module imports. The renderer passes the canonical
//     program window (PROGRAM_START_MS/PROGRAM_END_MS from cohort-calendar-week.js)
//     and `nowMs` in; tests pass fixtures. Keeping this layer pure is what makes it
//     unit-testable under `node --test` — the renderer .js modules use browser-only
//     ESM (`export const` in a .js file) which the Node test runner can't import.
//   - Immutable: inputs are never mutated; every builder returns fresh objects.
//   - Privacy: every emitted item is tagged tier:'public'. This module only ever
//     sees the public committed surface and must never be handed gated transcript
//     prose. See [[transcript engine quality hardening 2026-06-17]].

const DAY_MS = 86400000;

// ── axis math ──────────────────────────────────────────────────────────────
export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Fraction (0..1) of a timestamp across the program window — the x position every
// lane shares. Out-of-window timestamps clamp to the edges.
export function axisFraction(ms, startMs, endMs) {
  const span = endMs - startMs;
  if (!(span > 0)) return 0;
  return clamp01((ms - startMs) / span);
}

// program week (0-based) → midpoint ms. Weekly-grained sources (standing) sit at
// the middle of their week so they don't masquerade as a precise instant.
export function programWeekToMs(week, startMs) {
  return startMs + (week * 7 + 3.5) * DAY_MS;
}

function parseMs(value) {
  if (value == null) return NaN;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── activity lane (whats_new) ────────────────────────────────────────────────
// The mixed, newest-first feed already assembled by build-bundles. Each item is a
// point on the axis; `category` (event/release/commit/ask) drives lane colour.
export function buildActivityLane(whatsNew, { startMs, endMs, nowMs }) {
  const list = Array.isArray(whatsNew) ? whatsNew : [];
  const items = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const ms = parseMs(raw.date);
    if (!Number.isFinite(ms)) continue;
    const category = String(raw.kind || "update");
    const title = String(raw.label || "");
    const nav = raw.nav && typeof raw.nav === "object" ? raw.nav : null;
    items.push({
      id: `activity:${raw.date}:${category}:${slug(title)}`,
      startMs: ms,
      endMs: null,
      trackKey: "activity",
      category,
      // release/commit feed items nav to their team (mode:'shapes'); events don't.
      team: nav && nav.mode === "shapes" ? nav.recordId || null : null,
      person: null,
      title,
      detail: String(raw.meta || ""),
      detailRef: nav ? { nav } : null,
      tier: "public",
      shape: "point",
      fraction: axisFraction(ms, startMs, endMs),
      endFraction: null,
      isFuture: ms > nowMs,
    });
  }
  items.sort((a, b) => a.startMs - b.startMs);
  return { trackKey: "activity", dim: "category", value: "everything", label: "all activity", items };
}

// ── standing lane (per-week PMF, cohort aggregate) ───────────────────────────
// The default standing lane is the cohort's MEAN PMF stage per program week — one
// legible line rather than 26 overlaid ones. Filtering a lane to a single team
// uses teamStageSeries instead.
export function teamStageSeries(teamCell, weeks, startMs) {
  const list = Array.isArray(weeks) ? weeks : [];
  return list.map((w) => {
    const wk = Number(w.program_week);
    const cell = teamCell?.weeks?.[wk] ?? teamCell?.weeks?.[String(wk)] ?? null;
    const stage = cell && Number.isFinite(Number(cell.stage)) ? Number(cell.stage) : null;
    const ms = programWeekToMs(wk, startMs);
    return { programWeek: wk, ms, stage, confidence: cell ? cell.confidence ?? null : null };
  });
}

export function buildStandingLane(standingWeekly, { startMs, endMs }) {
  const weeks = Array.isArray(standingWeekly?.weeks) ? standingWeekly.weeks : [];
  const byTeam =
    standingWeekly?.byTeam && typeof standingWeekly.byTeam === "object" ? standingWeekly.byTeam : {};
  const teams = Object.values(byTeam);
  const points = weeks
    .map((w) => {
      const wk = Number(w.program_week);
      if (!Number.isFinite(wk)) return null;
      let sum = 0;
      let n = 0;
      for (const t of teams) {
        const cell = t?.weeks?.[wk] ?? t?.weeks?.[String(wk)];
        const stage = cell && Number.isFinite(Number(cell.stage)) ? Number(cell.stage) : null;
        if (stage != null) {
          sum += stage;
          n += 1;
        }
      }
      const ms = programWeekToMs(wk, startMs);
      return {
        programWeek: wk,
        label: String(w.label || `Week ${wk}`),
        ms,
        fraction: axisFraction(ms, startMs, endMs),
        stage: n ? sum / n : null,
        teamsWithData: n,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.programWeek - b.programWeek);
  return {
    trackKey: "standing",
    dim: "category",
    value: "standing",
    label: "standing",
    points,
    stageMax: 8,
    teamCount: teams.length,
  };
}

// ── presence lane (cohort occupancy band) ────────────────────────────────────
// "who's in town" as one background band: at weekly samples, the fraction of
// cohort members present (inside dates_start..dates_end and not on an absence).
export function isPresent(person, ms) {
  const start = parseMs(person?.dates_start);
  const end = parseMs(person?.dates_end);
  if (Number.isFinite(start) && ms < start) return false;
  // dates_end / absence end are inclusive whole days.
  if (Number.isFinite(end) && ms > end + DAY_MS - 1) return false;
  const absences = Array.isArray(person?.absences) ? person.absences : [];
  for (const a of absences) {
    const as = parseMs(a?.start);
    const ae = parseMs(a?.end);
    if (Number.isFinite(as) && Number.isFinite(ae) && ms >= as && ms <= ae + DAY_MS - 1) return false;
  }
  return true;
}

export function buildPresenceLane(people, { startMs, endMs, nowMs, sampleDays = 7 }) {
  const roster = Array.isArray(people)
    ? people.filter((p) => p && (p.dates_start || p.dates_end))
    : [];
  const total = roster.length;
  const step = Math.max(1, sampleDays) * DAY_MS;
  const samples = [];
  for (let ms = startMs; ms <= endMs; ms += step) {
    let present = 0;
    for (const p of roster) if (isPresent(p, ms)) present += 1;
    samples.push({
      ms,
      fraction: axisFraction(ms, startMs, endMs),
      present,
      total,
      occupancy: total ? present / total : 0,
      isFuture: ms > nowMs,
    });
  }
  return { trackKey: "presence", dim: "people", value: "in town", label: "people · in town", samples, total };
}

// ── assembler ────────────────────────────────────────────────────────────────
// The v1 default lane set (activity + standing + presence) plus the shared axis
// descriptor. The renderer injects the canonical program window and nowMs.
export function buildDefaultTimeline({ whatsNew, standingWeekly, people } = {}, { startMs, endMs, nowMs } = {}) {
  const axis = {
    startMs,
    endMs,
    nowMs,
    nowFraction: axisFraction(nowMs, startMs, endMs),
  };
  return {
    axis,
    lanes: [
      buildActivityLane(whatsNew, { startMs, endMs, nowMs }),
      buildStandingLane(standingWeekly, { startMs, endMs }),
      buildPresenceLane(people, { startMs, endMs, nowMs }),
    ],
  };
}

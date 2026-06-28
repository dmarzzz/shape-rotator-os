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

// ── session-insights lane (distilled transcript evidence over time) ──────────
// Each distilled session-insight card placed on the axis at its week, anchored to
// the team it's attributed to (declared content_json.teams, or the inferred
// teams attributeInsightCards() attaches). This is what makes the live transcript
// content legible AS PROGRESS — the dossier's "events over time" shown cohort-wide
// on the shared axis. Empty (no cards / none team-attributed) ⇒ no lane, so the
// timeline degrades to the v1 activity/standing/presence set with no change.
function cardWeekMs(card, startMs) {
  const cj = card && card.content_json && typeof card.content_json === "object" ? card.content_json : {};
  const raw = String(cj.week_start || cj.date || "").slice(0, 10);
  const ms = parseMs(raw);
  return Number.isFinite(ms) ? ms : NaN;
}
export function buildInsightLane(evidenceCards, teamNameById = {}, { startMs, endMs, nowMs } = {}) {
  const names = teamNameById instanceof Map ? teamNameById : new Map(Object.entries(teamNameById || {}));
  const list = Array.isArray(evidenceCards) ? evidenceCards : [];
  const items = [];
  for (const card of list) {
    if (!card || typeof card !== "object") continue;
    const cj = card.content_json && typeof card.content_json === "object" ? card.content_json : {};
    const teams = Array.isArray(cj.teams) ? cj.teams.map((t) => String(t || "").trim()).filter(Boolean) : [];
    if (!teams.length) continue; // unattributed cards have no place on a per-team axis
    const ms = cardWeekMs(card, startMs);
    if (!Number.isFinite(ms)) continue;
    const team = teams[0];
    const title = String(card.claim_text || card.title || "session insight");
    items.push({
      id: `insight:${cj.week_start || cj.date || ""}:${team}:${slug(title).slice(0, 24)}`,
      startMs: ms,
      endMs: null,
      trackKey: "insights",
      category: "insight",
      team,
      person: null,
      title,
      detail: (names.get(team) || team) + (teams.length > 1 ? ` +${teams.length - 1}` : ""),
      detailRef: { nav: { mode: "shapes", recordId: team } },
      tier: "public",
      basis: cj.teams_basis === "inferred" ? "inferred" : "declared",
      shape: "point",
      fraction: axisFraction(ms, startMs, endMs),
      endFraction: null,
      isFuture: ms > nowMs,
    });
  }
  items.sort((a, b) => a.startMs - b.startMs);
  return { trackKey: "insights", dim: "category", value: "insights", label: "session insights", items };
}

// ── local sessions lane (the member's OWN coding sessions over time) ─────────
// LOCAL-ONLY — unlike every other lane here, this is the member's own on-device
// signal (Claude Code / Codex session METADATA: a title/project + a timestamp,
// NEVER body prose). It must be rendered ONLY in the member's own private view and
// NEVER published to the cohort or fed to a remote model — it is tagged tier:'local'
// so a mount can't mistake it for public. Input shape (from self-report-node
// listLocalSessions): [{ id, source, title, project, ms }]. Pure: no fs/DOM here.
export function buildSessionsLane(sessions, { startMs, endMs, nowMs } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const items = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const ms = Number.isFinite(s.ms) ? s.ms : parseMs(s.ms);
    if (!Number.isFinite(ms)) continue;
    const title = String(s.title || s.project || "session");
    items.push({
      id: `session:${s.source || "local"}:${slug(s.id || title).slice(0, 32)}:${Math.round(ms)}`,
      startMs: ms,
      endMs: null,
      trackKey: "sessions",
      category: "session",
      team: null,
      person: s.person ? String(s.person) : null,
      title,
      detail: String(s.project || s.source || ""),
      detailRef: null,
      tier: "local",
      shape: "point",
      fraction: axisFraction(ms, startMs, endMs),
      endFraction: null,
      isFuture: ms > nowMs,
    });
  }
  items.sort((a, b) => a.startMs - b.startMs);
  return { trackKey: "sessions", dim: "category", value: "sessions", label: "my sessions", items };
}

// ── assembler ────────────────────────────────────────────────────────────────
// The default lane set (activity + standing + presence, plus a session-insights
// lane when distilled evidence is present) on the shared axis. The renderer
// injects the canonical program window + nowMs and may pass evidenceCards (the
// attributed transcript_evidence_cards) + teamNameById for the insights lane.
// `localSessions` is OPTIONAL and only ever passed in the member's OWN private
// timeline (never the shared cohort mount) — see buildSessionsLane's tier note.
export function buildDefaultTimeline(
  { whatsNew, standingWeekly, people, evidenceCards, teamNameById, localSessions } = {},
  { startMs, endMs, nowMs } = {},
) {
  const axis = {
    startMs,
    endMs,
    nowMs,
    nowFraction: axisFraction(nowMs, startMs, endMs),
  };
  const lanes = [
    buildActivityLane(whatsNew, { startMs, endMs, nowMs }),
    buildStandingLane(standingWeekly, { startMs, endMs }),
    buildPresenceLane(people, { startMs, endMs, nowMs }),
  ];
  // Only surface the insights lane when it actually has placeable items, so the
  // v1 three-lane default is unchanged when there's no attributed evidence.
  const insights = buildInsightLane(evidenceCards, teamNameById, { startMs, endMs, nowMs });
  if (insights.items.length) lanes.splice(1, 0, insights); // sit it right under activity
  // The member's own sessions lane is opt-in (private mount only) and likewise
  // only appears when there's something to place.
  const sessions = buildSessionsLane(localSessions, { startMs, endMs, nowMs });
  if (sessions.items.length) lanes.push(sessions);
  return { axis, lanes };
}

// Apply viewer preferences to an already-built timeline. This stays pure so the
// calendar can persist controls locally while the standalone timeline view keeps
// its unfiltered default unless the host opts in.
export function filterTimelineByPrefs(timeline, prefs = {}) {
  const hiddenLanes = new Set(Array.isArray(prefs.hiddenLanes) ? prefs.hiddenLanes : []);
  const hiddenCategories = new Set(Array.isArray(prefs.hiddenCategories) ? prefs.hiddenCategories : []);
  const lanes = (Array.isArray(timeline?.lanes) ? timeline.lanes : [])
    .filter((lane) => lane && !hiddenLanes.has(lane.trackKey))
    .map((lane) => {
      if (!hiddenCategories.size || !Array.isArray(lane.items)) return lane;
      return {
        ...lane,
        items: lane.items.filter((item) => !hiddenCategories.has(item?.category)),
      };
    });
  return { ...(timeline || {}), lanes };
}

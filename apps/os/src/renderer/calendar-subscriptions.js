// Calendar follow lanes — the user's chosen set of "lanes" that render on the
// shared program axis (the follow board). Each lane follows one feed/subject (all
// activity, releases, commits, meetings, session insights, standing, presence, or
// one team). Persisted to localStorage so the layout survives relaunches; this is
// the first calendar-view preference to persist (week/scope/filters stay
// session-only by design).
//
// Pure data layer: no DOM, no fetch. alchemy.js loads the list on mount, builds
// the followed timeline from already-loaded surface data, and passes the rendered
// lanes to calendar.js renderCalendarPage(). Mutations here just rewrite
// localStorage and notify listeners; the host repaints.

// Fresh model (lanes on the program axis, not week-grid feed rows). The old key is
// ignored — no migration; first run seeds the new defaults.
const LS_KEY = "srwk:calendar_follow_lanes_v1";

// The lane kinds the picker can add. `needsSubject` lanes pick a team from the
// cohort; the rest are cohort-wide. `glyph` keys the lane icon (LANE_GLYPH in the
// render layer); `hint` is the picker option subline.
export const SUBSCRIPTION_KINDS = [
  { kind: "activity", label: "all activity", needsSubject: false, glyph: "release", hint: "every whats-new point across the cohort" },
  { kind: "releases", label: "releases", needsSubject: false, glyph: "release", hint: "what shipped" },
  { kind: "commits", label: "github commits", needsSubject: false, glyph: "commit", hint: "commit digests across the cohort" },
  { kind: "meetings", label: "meetings", needsSubject: false, glyph: "transcript", hint: "recorded sessions on the calendar" },
  { kind: "insights", label: "session insights", needsSubject: false, glyph: "insight", hint: "attributed transcript evidence" },
  { kind: "standing", label: "standing (pmf)", needsSubject: false, glyph: "standing", hint: "cohort mean pmf stage per week" },
  { kind: "presence", label: "in town", needsSubject: false, glyph: "presence", hint: "cohort occupancy each week" },
  { kind: "team", label: "a team", needsSubject: true, glyph: "team", hint: "releases, commits, insights + meetings for one team" },
];

// First-run lanes: a cohort-wide overview — all activity, standing, presence.
export const DEFAULT_SUBSCRIPTIONS = [
  { id: "lane-activity", kind: "activity", subjectId: null, label: "all activity", hidden: false, builtin: true },
  { id: "lane-standing", kind: "standing", subjectId: null, label: "standing", hidden: false, builtin: true },
  { id: "lane-presence", kind: "presence", subjectId: null, label: "in town", hidden: false, builtin: true },
];

// Legacy lane kinds from the old feed-row model normalize to the new kinds so any
// stray stored value (or hand-edited localStorage) maps cleanly.
const LEGACY_KIND_MAP = {
  shipped: "releases",
  transcripts: "meetings",
};

let _cache = null;
const listeners = new Set();

function clone(rows) {
  return rows.map((r) => ({ ...r }));
}

function sanitize(rows) {
  if (!Array.isArray(rows)) return clone(DEFAULT_SUBSCRIPTIONS);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const id = String(r.id || "").trim();
    const rawKind = String(r.kind || "").trim();
    // Normalize legacy kinds (shipped→releases, transcripts→meetings) so old or
    // hand-edited stored lanes line up with the current kind set.
    const kind = LEGACY_KIND_MAP[rawKind] || rawKind;
    if (!id || !kind || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      subjectId: r.subjectId != null ? String(r.subjectId) : null,
      label: r.label != null ? String(r.label) : "",
      hidden: !!r.hidden,
      builtin: !!r.builtin,
    });
  }
  // Allow a legitimately-empty list through — an intentionally-emptied stack must
  // stay empty, not resurrect the defaults. Defaults seed only a MISSING/corrupt
  // store (handled in load()).
  return out;
}

function load() {
  if (_cache) return _cache;
  let parsed = null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  // Only seed defaults when there's no stored value (first run) or it's corrupt.
  // A stored "[]" (user removed every row) is a valid empty stack and is kept.
  _cache = Array.isArray(parsed) ? sanitize(parsed) : clone(DEFAULT_SUBSCRIPTIONS);
  return _cache;
}

function persist(rows) {
  _cache = sanitize(rows);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(_cache));
  } catch {
    /* storage full / unavailable — keep the in-memory copy */
  }
  for (const fn of listeners) {
    try { fn(clone(_cache)); } catch {}
  }
  return clone(_cache);
}

export function getSubscriptions() {
  return clone(load());
}

export function setSubscriptions(rows) {
  return persist(rows);
}

// A short, stable-ish id. Browser context, so Date.now()/Math.random() are fine.
function makeId(kind, subjectId) {
  const base = `row-${kind}${subjectId ? `-${subjectId}` : ""}`;
  return `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function addSubscription({ kind, subjectId = null, label = "" } = {}) {
  if (!kind) return getSubscriptions();
  const rows = clone(load());
  const sid = subjectId != null ? String(subjectId) : null;
  // Don't add an exact duplicate (same kind + subject); just unhide it.
  const dup = rows.find((r) => r.kind === kind && (r.subjectId || null) === sid);
  if (dup) {
    dup.hidden = false;
    return persist(rows);
  }
  rows.push({ id: makeId(kind, sid), kind, subjectId: sid, label: String(label || ""), hidden: false, builtin: false });
  return persist(rows);
}

export function removeSubscription(id) {
  return persist(load().filter((r) => r.id !== id));
}

export function setSubscriptionHidden(id, hidden) {
  const rows = clone(load());
  const row = rows.find((r) => r.id === id);
  if (row) row.hidden = !!hidden;
  return persist(rows);
}

export function toggleSubscriptionHidden(id) {
  const row = load().find((r) => r.id === id);
  return setSubscriptionHidden(id, !(row && row.hidden));
}

// Drag-to-reorder: move `dragId` to just before (or after) `targetId`. The list's
// order IS the row order rendered top→bottom, so this is the whole reorder.
export function reorderSubscriptions(dragId, targetId, after = false) {
  const rows = clone(load());
  const from = rows.findIndex((r) => r.id === dragId);
  if (from < 0 || dragId === targetId) return getSubscriptions();
  const [moved] = rows.splice(from, 1);
  let to = rows.findIndex((r) => r.id === targetId);
  if (to < 0) return persist([...rows, moved]); // target gone — drop at end
  if (after) to += 1;
  rows.splice(to, 0, moved);
  return persist(rows);
}

export function subscribeToSubscriptions(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

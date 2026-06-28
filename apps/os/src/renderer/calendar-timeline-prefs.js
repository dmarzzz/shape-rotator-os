// calendar-timeline-prefs.js - local view preferences for the calendar's
// program timeline band. Pure storage helpers; alchemy.js owns repaint wiring.

const LS_KEY = "srwk:calendar_timeline_prefs_v1";

export const CALENDAR_TIMELINE_LANES = [
  { key: "activity", label: "activity" },
  { key: "insights", label: "session insights" },
  { key: "standing", label: "standing" },
  { key: "presence", label: "people in town" },
  { key: "sessions", label: "my sessions" },
];

export const CALENDAR_TIMELINE_CATEGORIES = [
  { key: "release", label: "release" },
  { key: "commit", label: "commits" },
  { key: "insight", label: "session insight" },
  { key: "ask", label: "ask" },
  { key: "event", label: "event" },
  { key: "session", label: "my session" },
];

const LANE_KEYS = new Set(CALENDAR_TIMELINE_LANES.map((x) => x.key));
const CATEGORY_KEYS = new Set(CALENDAR_TIMELINE_CATEGORIES.map((x) => x.key));

export const DEFAULT_CALENDAR_TIMELINE_PREFS = Object.freeze({
  hiddenLanes: [],
  hiddenCategories: [],
});

function storageOrDefault(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function cleanList(value, allowed) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const key = String(item || "");
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function normalizeCalendarTimelinePrefs(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    hiddenLanes: cleanList(src.hiddenLanes, LANE_KEYS),
    hiddenCategories: cleanList(src.hiddenCategories, CATEGORY_KEYS),
  };
}

export function getCalendarTimelinePrefs(storage) {
  const ls = storageOrDefault(storage);
  let parsed = null;
  try {
    const raw = ls?.getItem?.(LS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return normalizeCalendarTimelinePrefs(parsed || DEFAULT_CALENDAR_TIMELINE_PREFS);
}

export function setCalendarTimelinePrefs(patch, { storage } = {}) {
  const ls = storageOrDefault(storage);
  const clean = normalizeCalendarTimelinePrefs({
    ...getCalendarTimelinePrefs(storage),
    ...(patch && typeof patch === "object" ? patch : {}),
  });
  try { ls?.setItem?.(LS_KEY, JSON.stringify(clean)); } catch {}
  return clean;
}

function toggle(list, key) {
  const set = new Set(list);
  set.has(key) ? set.delete(key) : set.add(key);
  return [...set];
}

export function toggleCalendarTimelineLane(key, { storage } = {}) {
  const prefs = getCalendarTimelinePrefs(storage);
  if (!LANE_KEYS.has(key)) return prefs;
  return setCalendarTimelinePrefs({ hiddenLanes: toggle(prefs.hiddenLanes, key) }, { storage });
}

export function toggleCalendarTimelineCategory(key, { storage } = {}) {
  const prefs = getCalendarTimelinePrefs(storage);
  if (!CATEGORY_KEYS.has(key)) return prefs;
  return setCalendarTimelinePrefs({ hiddenCategories: toggle(prefs.hiddenCategories, key) }, { storage });
}

// calendar-supabase.mjs — the READ side of the live cohort calendar.
//
// Reads the cohort calendar grid LIVE from Supabase (the public_calendar_grid
// row published by the calendar-sync workflow), so the schedule reflects the
// admin Google calendar within the hour without waiting on a git merge + Vercel
// deploy. Mirrors supabase-evidence.mjs: an anon SELECT of a curated PUBLIC
// projection (never a gated base table), with the bundled snapshot as the
// offline / first-paint fallback.
//
// The row holds the exact grid the app already served publicly as calendar.json
// (single "May 18 Start" tab, public titles + times), so an anon read here
// cannot leak more than the public calendar already did. RLS grants anon only
// SELECT on this one row.

import { fetchAnon } from "./supabase-anon-write.mjs";

// PostgREST path (view + query) for the single public grid row.
const GRID_PATH = "public_calendar_grid?select=grid,source,last_refresh,updated_at&id=eq.current&limit=1";

// PostgREST URL for the single public grid row (kept for callers/tests that want
// the absolute URL; fetchPublicCalendarGrid reads via fetchAnon + GRID_PATH).
export function publicCalendarGridUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${GRID_PATH}`;
}

// Validate the row's grid is the shape the renderer expects ({ tabs: {...} }).
export function normalizeGrid(row) {
  if (!row || typeof row !== "object") return null;
  const grid = row.grid;
  if (!grid || typeof grid !== "object" || !grid.tabs || typeof grid.tabs !== "object") {
    return null;
  }
  return grid;
}

// Fetch the live calendar grid. Always resolves (never throws) so a Supabase
// outage degrades to the committed bundle. Returns { grid, source }: source is
// "supabase" on success, "unconfigured" with no anon key, "empty" when the row
// is missing/malformed, or "error" with an `error` string.
export async function fetchPublicCalendarGrid(opts = {}) {
  const { rows, source, error } = await fetchAnon(GRID_PATH, opts);
  if (source === "unconfigured") return { grid: null, source: "unconfigured" };
  if (source === "error") return { grid: null, source: "error", error };
  const grid = normalizeGrid(rows[0]);
  if (!grid) return { grid: null, source: "empty" };
  return { grid, source: "supabase" };
}

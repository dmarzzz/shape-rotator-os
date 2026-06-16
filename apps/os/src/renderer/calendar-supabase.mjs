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

import { readSupabaseConfig } from "./supabase-evidence.mjs";

// PostgREST URL for the single public grid row.
export function publicCalendarGridUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/public_calendar_grid`);
  url.searchParams.set("select", "grid,source,last_refresh,updated_at");
  url.searchParams.set("id", "eq.current");
  url.searchParams.set("limit", "1");
  return url.toString();
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
export async function fetchPublicCalendarGrid({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { grid: null, source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(publicCalendarGridUrl(url), {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    return { grid: null, source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { grid: null, source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    return { grid: null, source: "error", error: "invalid JSON from Supabase" };
  }
  const grid = normalizeGrid(Array.isArray(rows) ? rows[0] : rows);
  if (!grid) return { grid: null, source: "empty" };
  return { grid, source: "supabase" };
}

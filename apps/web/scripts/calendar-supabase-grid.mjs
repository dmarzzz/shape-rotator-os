// calendar-supabase-grid.mjs — web reader for the LIVE cohort calendar grid.
//
// Parity with the OS reader (apps/os/src/renderer/calendar-supabase.mjs): an
// anon SELECT of the public_calendar_grid row — the curated PUBLIC projection
// the calendar-sync workflow publishes — with /calendar.json + the bundled
// cohort-surface as fallbacks. The row is the same content already served as
// calendar.json, and RLS grants anon only SELECT on this one row, so an anon
// read here cannot leak more than the public calendar already did.

export const DEFAULT_CALENDAR_CONFIG_KEY = "srfg:calendar_ingress_config";
export const DEFAULT_SUPABASE_URL = "https://txjntzwksiluvqcpccpc.supabase.co";
export const DEFAULT_PUBLIC_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4am50endrc2lsdXZxY3BjY3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzA1NzEsImV4cCI6MjA5Njk0NjU3MX0.XjXEUnw3jq1E7PwIOvhr7a3OpO2lyZv6S_Hn3JqogBA";

// Resolve { url, anonKey } from per-deployment calendar config, falling back to
// the published project URL plus the public anon JWT.
export function readSupabaseConfig(storage = globalThis.localStorage) {
  let cfg = {};
  try {
    const raw = storage && storage.getItem ? storage.getItem(DEFAULT_CALENDAR_CONFIG_KEY) : null;
    if (raw) cfg = JSON.parse(raw) || {};
  } catch {
    cfg = {};
  }
  const url = String(cfg.supabaseUrl || DEFAULT_SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = String(cfg.supabaseAnonKey || DEFAULT_PUBLIC_ANON_KEY || "").trim();
  return { url, anonKey };
}

export function publicCalendarGridUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/public_calendar_grid`);
  url.searchParams.set("select", "grid,source,last_refresh,updated_at");
  url.searchParams.set("id", "eq.current");
  url.searchParams.set("limit", "1");
  return url.toString();
}

export function normalizeGrid(row) {
  if (!row || typeof row !== "object") return null;
  const grid = row.grid;
  if (!grid || typeof grid !== "object" || !grid.tabs || typeof grid.tabs !== "object") {
    return null;
  }
  return grid;
}

// Fetch the live grid. Always resolves (never throws) so a Supabase outage
// degrades to the committed snapshot. { grid, source }: "supabase" on success,
// "unconfigured" with no key, "empty" when the row is missing/malformed,
// "error" otherwise.
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

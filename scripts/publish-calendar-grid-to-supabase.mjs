// publish-calendar-grid-to-supabase.mjs
//
// Publishes the verified cohort calendar grid (cohort-data/calendar.json, built
// by scripts/build-calendar-from-google.js) to the public_calendar_grid row in
// Supabase, so the OS + web apps read the schedule LIVE from Supabase instead of
// waiting on a git merge + Vercel deploy. Runs in the calendar-sync workflow
// with the service-role key (server-side only — never shipped to a client).
//
// The grid is the SAME sanitized content the app already served publicly as
// calendar.json (single "May 18 Start" tab, public titles/times), so this adds
// no new exposure. Writes go through the service role, which bypasses RLS; anon
// readers get SELECT-only on the one public row (see the public_calendar_grid
// migration).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRID_PATH = path.join(ROOT, "cohort-data", "calendar.json");
const ROW_ID = "current";

// Build the PostgREST upsert request for the grid. Pure + deterministic (pass
// `now`) so it is unit-testable without a live Supabase.
export function buildUpsertRequest({ url, grid, rowId = ROW_ID, now }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) throw new Error("SUPABASE_URL is required");
  if (!grid || typeof grid !== "object" || !grid.tabs) {
    throw new Error("grid must be an object with a `tabs` map");
  }
  return {
    url: `${base}/rest/v1/public_calendar_grid?on_conflict=id`,
    body: {
      id: rowId,
      grid,
      source: grid.source || "build-calendar-from-google",
      last_refresh: grid.last_refresh || null,
      // Bump on every upsert (the column default only fires on INSERT).
      updated_at: now || new Date().toISOString(),
    },
  };
}

// Fail-closed leak gate (security review #2). The grid is built from the admin
// source calendar, so before it reaches the anon-readable public row we scan the
// rendered text for content that must never be public. A hit throws — the
// publish step fails and the app keeps serving the last good row (safe stale),
// rather than leaking. Patterns are precise to avoid tripping on times/dates;
// names are reported, never the matched value (so the CI log can't echo it).
const LEAK_PATTERNS = [
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["video-call link", /\b(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)\b/i],
  ["private routing marker", /\b(?:do_not_publish|private_1on1|leadership_meeting)\b/i],
  ["candid leadership note", /Goals\s*[—–-]\s*(?:Andrew|Tina|James)|Notion draft/i],
];

export function scanGridForLeaks(grid) {
  const text = JSON.stringify(grid || {});
  return LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// Organizer personal-availability / whereabouts asides (privacy audit 2026-06-17).
// Unlike the hard-no LEAK_PATTERNS above (which FAIL the publish), these recur in
// normal scheduling — so we STRIP them from the grid before publishing rather than
// freeze the whole calendar: the schedule keeps updating hourly, the personal aside
// just never reaches the anon row. Line-level — a cell line matching any pattern is
// dropped; the cell keeps its event titles/times. We deliberately leave the
// calendar's legitimate names/speakers/team pairings (the pairings are already
// public via the cohort directory).
const STRIP_LINE_PATTERNS = [
  /\bout of cohort\b/i,
  /\bout for the day\b/i,
];

// Return a NEW grid with private-aside lines removed from every string cell (the
// input is never mutated).
export function sanitizeGrid(grid) {
  const scrubString = (s) =>
    s.split("\n").filter((line) => !STRIP_LINE_PATTERNS.some((re) => re.test(line))).join("\n");
  const walk = (v) => {
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(grid);
}

// Upsert the grid. Resolves { skipped:true } when Supabase env is absent (local
// dev / unconfigured) so the calendar build never hard-fails on the publish
// step; throws only on a real HTTP error so CI surfaces a misconfiguration.
export async function publishGrid({
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY,
  grid,
  fetchImpl = globalThis.fetch,
  now,
} = {}) {
  // Leak-scan ALWAYS runs, before the credential check, so a leak throws even when
  // the publish target is unconfigured — a rotated/missing secret can't silently
  // disable the only inline privacy gate.
  // Strip recurring private asides first (so the schedule keeps publishing), THEN
  // hard-scan the cleaned grid for the never-publish patterns (fail-closed backstop).
  const cleanGrid = sanitizeGrid(grid);
  const leaks = scanGridForLeaks(cleanGrid);
  if (leaks.length) {
    throw new Error(`refusing to publish — grid contains content that must not be public: ${leaks.join(", ")}`);
  }
  if (!url || !key) {
    return { skipped: true, reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  const { url: reqUrl, body } = buildUpsertRequest({ url, grid: cleanGrid, now });
  const res = await fetchImpl(reqUrl, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      // merge-duplicates = upsert on the id PK; minimal = don't echo the row.
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`.trim());
  }
  return { skipped: false, status: res.status };
}

function readGrid() {
  return JSON.parse(fs.readFileSync(GRID_PATH, "utf8"));
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  publishGrid({ grid: readGrid() })
    .then((r) => {
      console.log(
        r.skipped
          ? `[publish-calendar-grid] skipped — ${r.reason}`
          : `[publish-calendar-grid] published grid to public_calendar_grid (HTTP ${r.status})`,
      );
    })
    .catch((e) => {
      console.error(`[publish-calendar-grid] ${e.message}`);
      process.exit(1);
    });
}

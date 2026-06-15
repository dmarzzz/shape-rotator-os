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
  if (!url || !key) {
    return { skipped: true, reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  const { url: reqUrl, body } = buildUpsertRequest({ url, grid, now });
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

// publish-cohort-events-snapshot.mjs — the cohort_events safety net.
//
// docs/two-way-contribution-layer.md "Direct self-edit + safety net": a daily job
// commits cohort_events to the repo as cohort-data/snapshots/YYYY-MM-DD.json, ON TOP
// OF the database's own automatic daily backups — two independent recovery paths,
// both cheap. Because the spine is append-only, a snapshot is also a point-in-time
// audit of the whole timeline.
//
// Reads via service_role (sibling of publish-calendar-grid / publish-releases). The
// committed snapshot STRIPS claim_token_hash — the read view never exposes the soft
// identity, and neither should the public repo. Pure helpers (buildSnapshot,
// fetchAllEvents with an injected fetch) are exported for node tests; main() does fs.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TABLE = "cohort_events";
const PAGE = 1000;
// Columns to archive — everything the feed needs, MINUS claim_token_hash.
const COLUMNS = "id,record_id,actor,event_type,field,value,weight,supersedes,created_at";

// Page through the whole table via PostgREST Range headers (service_role bypasses
// RLS). Returns all rows oldest-first. Never throws on a clean run; surfaces a
// thrown error to main() so CI fails loudly rather than committing a partial file.
export async function fetchAllEvents({ url, serviceRoleKey, fetchImpl, pageSize = PAGE } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!url || !serviceRoleKey || typeof doFetch !== "function") {
    throw new Error("unconfigured: need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  }
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const res = await doFetch(`${url}/rest/v1/${TABLE}?select=${COLUMNS}&order=created_at.asc`, {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        range: `${from}-${to}`,
        "range-unit": "items",
      },
      cache: "no-store",
    });
    // When the row count is an exact multiple of pageSize, the previous page was
    // full and this request's offset lands at/after the end → PostgREST answers
    // 416 (Range Not Satisfiable). That's clean end-of-data, not an error.
    if (res && res.status === 416) break;
    if (!res || !res.ok) throw new Error(`snapshot read failed: HTTP ${res ? res.status : "no response"}`);
    const page = await res.json();
    const arr = Array.isArray(page) ? page : [];
    rows.push(...arr);
    if (arr.length === 0) break;       // empty page (defensive)
    if (arr.length < pageSize) break;  // last page
  }
  return rows;
}

// Shape the committed snapshot. Pure. Strips claim_token_hash defensively even if a
// caller passed full rows. Sorted oldest-first for a stable, diff-friendly file.
export function buildSnapshot(rows, { dateStr, generatedAt } = {}) {
  const events = (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const { claim_token_hash, ...rest } = r || {};
      return rest;
    })
    .filter((r) => r && r.id)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return {
    generated_at: generatedAt || null,
    date: dateStr || null,
    count: events.length,
    events,
  };
}

function todayUtc() {
  // CI runs in UTC; a date-stamped file per UTC day. (Node script — new Date is fine here.)
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.log("[cohort-events-snapshot] skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return { skipped: true };
  }
  const dateStr = todayUtc();
  const rows = await fetchAllEvents({ url, serviceRoleKey });
  const snapshot = buildSnapshot(rows, { dateStr, generatedAt: new Date().toISOString() });
  const dir = path.resolve(process.cwd(), "cohort-data", "snapshots");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${dateStr}.json`);
  await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`[cohort-events-snapshot] wrote ${snapshot.count} events → cohort-data/snapshots/${dateStr}.json`);
  return { skipped: false, count: snapshot.count, file };
}

// Run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("publish-cohort-events-snapshot.mjs")) {
  main().catch((e) => { console.error("[cohort-events-snapshot]", e?.message || e); process.exit(1); });
}

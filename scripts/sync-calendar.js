#!/usr/bin/env node
/**
 * sync-calendar.js — fetch the live Phala-hosted cohort schedule JSON and
 * write it to cohort-data/calendar.json (atomic, byte-identical on no-op).
 *
 * Run by .github/workflows/calendar-sync.yml every 30 minutes. The workflow
 * commits + PRs any diff. The Phala endpoint is publicly readable — no
 * credentials in this script and no secrets in the workflow.
 *
 * Why we mirror into the repo instead of fetching from Phala at runtime:
 *   - PR loop gives a human-readable audit trail of schedule changes
 *   - Repo-bundled fallback when the app is offline or Phala is down
 *
 * The app still attempts a live fetch first (see calendar.js / alchemy.js)
 * and only uses this snapshot on failure, surfacing a "may be stale" banner.
 *
 * Usage:
 *   node scripts/sync-calendar.js                  # fetch + write
 *   node scripts/sync-calendar.js --check          # exit 0 if up to date, 1 if drift
 */

const fs   = require("node:fs");
const path = require("node:path");

const URL = "https://915c8197b20b831c52cf97a9fb7e2e104cdc6ae8-8080.dstack-pha-prod7.phala.network/cadence/calendar.json";
const OUT = path.resolve(__dirname, "..", "cohort-data", "calendar.json");

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "shape-rotator-os-calendar-sync" },
    // Node's fetch picks up AbortSignal.timeout() in node 20+.
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`upstream returned HTTP ${res.status}`);
  return res.json();
}

// Strip last_refresh before comparing so a refresh with no schedule changes
// doesn't churn the repo every 30 minutes. We still write the fresh value
// when something *did* change.
function strip(j) {
  const { last_refresh: _drop, ...rest } = j || {};
  return rest;
}

function fmt(j) { return JSON.stringify(j, null, 2) + "\n"; }

async function main() {
  const check = process.argv.includes("--check");
  const upstream = await fetchJson(URL).catch(e => {
    console.error(`[sync-calendar] fetch failed: ${e.message}`);
    process.exit(2);
  });

  const existing = fs.existsSync(OUT)
    ? JSON.parse(fs.readFileSync(OUT, "utf8"))
    : null;

  const drift = !existing || JSON.stringify(strip(existing)) !== JSON.stringify(strip(upstream));

  if (check) {
    if (drift) {
      console.error("[sync-calendar] --check: calendar.json is stale vs upstream");
      process.exit(1);
    }
    console.log("[sync-calendar] --check: calendar.json is in sync");
    return;
  }

  if (!drift) {
    console.log("[sync-calendar] no schedule change — leaving last_refresh untouched");
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, fmt(upstream));
  const tabs = upstream.tabs ? Object.keys(upstream.tabs) : [];
  console.log(`[sync-calendar] wrote ${path.relative(path.resolve(__dirname, ".."), OUT)} (tabs: ${tabs.join(", ") || "—"})`);
}

main();

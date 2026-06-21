#!/usr/bin/env node
// Prove a cohort_app key reads the gated T2 tier end-to-end — the exact path the
// app uses (apikey: anon, Authorization: Bearer <cohortKey>). Hits the three gated
// views and reports row counts, so "the key works" is verifiable, not assumed.
//
// Usage:
//   node scripts/verify-cohort-key.mjs --env-file .env.calendar.local
//   SRFG_COHORT_KEY=<jwt> node scripts/verify-cohort-key.mjs --env-file .env.calendar.local
//
// Reads the key from SRFG_COHORT_KEY, else the gitignored baked file
// (apps/os/build-resources/cohort-app-key.json). Needs SUPABASE_URL + SUPABASE_ANON_KEY.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/env-file.cjs";
import { decodeJwtPayload } from "./lib/cohort-key.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argval = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const envFile = argval("--env-file");
if (envFile) loadEnvFile(envFile, { cwd: ROOT });

function resolveCohortKey() {
  if (process.env.SRFG_COHORT_KEY) return process.env.SRFG_COHORT_KEY.trim();
  try {
    const baked = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "os", "build-resources", "cohort-app-key.json"), "utf8"));
    if (baked && typeof baked.cohortKey === "string" && baked.cohortKey.trim()) return baked.cohortKey.trim();
  } catch {}
  const arg = argv.find((a) => !a.startsWith("--") && a.split(".").length === 3);
  return arg || "";
}

const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const anon = process.env.SUPABASE_ANON_KEY || "";
const cohortKey = resolveCohortKey();

if (!url || !anon) {
  console.error("SUPABASE_URL + SUPABASE_ANON_KEY required (pass --env-file .env.calendar.local).");
  process.exit(2);
}
if (!cohortKey) {
  console.error("No cohort key found. Set SRFG_COHORT_KEY, or run mint-cohort-key.mjs first.");
  process.exit(2);
}

const payload = decodeJwtPayload(cohortKey);
const role = payload?.role || "(unknown)";
const expNote = payload?.exp ? ` · exp ${new Date(payload.exp * 1000).toISOString().slice(0, 10)}` : "";
console.log(`cohort key role=${role}${expNote}`);
if (role !== "cohort_app") console.log("  ⚠ expected role=cohort_app — gated reads will likely 401.");

const VIEWS = [
  ["cohort_app_transcript_evidence_cards", "named evidence (T2)"],
  ["cohort_app_transcript_distillations", "distilled readouts"],
  ["cohort_app_cohort_insight_cards", "collaboration edges"],
];

let allOk = true;
for (const [view, label] of VIEWS) {
  let res;
  try {
    res = await fetch(`${url}/rest/v1/${view}?select=id`, {
      headers: { apikey: anon, authorization: `Bearer ${cohortKey}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    allOk = false;
    console.log(`✗ ${label.padEnd(24)} request failed: ${error?.message || error}`);
    continue;
  }
  if (!res.ok) {
    allOk = false;
    console.log(`✗ ${label.padEnd(24)} HTTP ${res.status} (${res.status === 401 ? "bad/expired key or missing grant" : res.status === 404 ? "view not deployed" : "error"})`);
    continue;
  }
  const rows = await res.json().catch(() => null);
  console.log(`✓ ${label.padEnd(24)} ${Array.isArray(rows) ? rows.length : "?"} rows`);
}

console.log(allOk
  ? "\nPASS — the cohort key reads every gated view. Bake it (SRFG_COHORT_KEY) into a release and T2 lights up for all installs."
  : "\nFAIL — see above. 401 ⇒ wrong/expired key or missing cohort_app grant; 404 ⇒ the gated view isn't deployed.");
process.exit(allOk ? 0 : 1);

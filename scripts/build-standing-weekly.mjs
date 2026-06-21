#!/usr/bin/env node
// Regenerate apps/os/src/cohort-standing-weekly.json from the Supabase
// `team_standing_weekly` table (public-read). Run after the weekly stage/
// confidence reads are updated so the standing/targets goal views move with
// real data. The artifact is the build output; Supabase is the source of truth.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_SUPABASE_URL = "https://txjntzwksiluvqcpccpc.supabase.co";
export const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4am50endrc2lsdXZxY3BjY3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzA1NzEsImV4cCI6MjA5Njk0NjU3MX0.XjXEUnw3jq1E7PwIOvhr7a3OpO2lyZv6S_Hn3JqogBA";

const WEEK_LABELS = { 0: "Program start" };

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

export function readStandingWeeklyConfig(env = process.env) {
  return {
    url: normalizeUrl(env.SUPABASE_URL || DEFAULT_SUPABASE_URL),
    key: String(env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_ANON_KEY).trim(),
  };
}

export function standingWeeklyUrl(urlBase) {
  return `${normalizeUrl(urlBase)}/rest/v1/public_team_standing_weekly?select=record_id,program_week,stage,confidence,target_stage,target_source&order=record_id,program_week`;
}

export async function fetchStandingWeeklyRows({ url, key, fetchImpl = fetch } = {}) {
  if (!url || !key) throw new Error("Supabase URL and anon key are required");
  const res = await fetchImpl(standingWeeklyUrl(url), {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    throw new Error(`fetch failed: ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function weekLabel(programWeek, highestWeek) {
  if (programWeek === highestWeek) return "Latest";
  return WEEK_LABELS[programWeek] || `Week ${programWeek}`;
}

export function buildStandingWeeklyArtifact(rows = []) {
  const weeksSet = new Set();
  const byTeam = {};

  for (const r of rows) {
    if (!r || typeof r !== "object" || !r.record_id) continue;
    const programWeek = Number(r.program_week);
    if (!Number.isFinite(programWeek)) continue;
    weeksSet.add(programWeek);
    const recordId = String(r.record_id);
    const t = byTeam[recordId] || (byTeam[recordId] = {
      target_stage: r.target_stage ?? null,
      target_source: r.target_source || null,
      weeks: {},
    });
    if (r.target_stage != null) t.target_stage = r.target_stage;
    if (r.target_source) t.target_source = r.target_source;
    t.weeks[programWeek] = {
      stage: Number(r.stage),
      confidence: typeof r.confidence === "number" ? r.confidence : null,
    };
  }

  const weekValues = [...weeksSet].sort((a, b) => a - b);
  const highestWeek = weekValues.at(-1);
  const weeks = weekValues.map((programWeek) => ({
    program_week: programWeek,
    label: weekLabel(programWeek, highestWeek),
  }));

  return { schema_version: 1, generated: "supabase", source: "team_standing_weekly", weeks, byTeam };
}

export async function buildStandingWeekly({ env = process.env, fetchImpl = fetch } = {}) {
  const cfg = readStandingWeeklyConfig(env);
  const rows = await fetchStandingWeeklyRows({ ...cfg, fetchImpl });
  return buildStandingWeeklyArtifact(rows);
}

function isCli() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCli()) {
  try {
    const artifact = await buildStandingWeekly();
    const out = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "os", "src", "cohort-standing-weekly.json");
    writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
    console.log(`[standing-weekly] wrote ${Object.keys(artifact.byTeam).length} teams x ${artifact.weeks.length} weeks -> ${out}`);
  } catch (err) {
    console.error(`[standing-weekly] ${err.message}`);
    process.exit(1);
  }
}

// standing-supabase.mjs — the READ side of live per-week team standing.
//
// Reads `team_standing_weekly` LIVE from Supabase (public-read) at runtime, so the
// standing lane in the cohort Timeline (and the standing/targets goal views)
// reflects the latest weekly PMF reads without waiting on a repo rebuild + the
// committed mirror. Mirrors calendar-supabase.mjs: an anon SELECT of a public-read
// projection, normalized to the {weeks, byTeam} shape the renderer already
// consumes, with the committed cohort-standing-weekly.json as the offline /
// first-paint fallback. Same row→shape transform as scripts/build-standing-weekly.mjs
// (the build-time mirror generator).
//
// team_standing_weekly is the source of truth; the committed mirror is a snapshot.
// The anon view exposes only the public columns the build mirror already shipped
// publicly (per-team program-week stage/confidence/target) — not evidence_card_ids,
// as_of, or internal ids. Requires the public_team_standing_weekly migration to be
// deployed to the cohort project; until then this read 404s and degrades to the mirror.

import { fetchAnon } from "./supabase-anon-write.mjs";

// PostgREST path for the curated anon-readable standing projection. anon reads
// public_* views, never base tables (the base team_standing_weekly has a public
// RLS policy but NO anon GRANT — see 20260616010000_revoke_stray_anon_grants.sql),
// so the live read targets the public_team_standing_weekly view.
const STANDING_PATH = "public_team_standing_weekly?select=record_id,program_week,stage,confidence,target_stage,target_source&order=record_id,program_week";

export function publicTeamStandingWeeklyUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${STANDING_PATH}`;
}

// Rows → { weeks:[{program_week,label}], byTeam:{rid:{target_stage,target_source,weeks:{n:{stage,confidence}}}} }.
// Mirrors scripts/build-standing-weekly.mjs. Labels the lowest week "Program start"
// and the highest "Latest" so live data of ANY length reads correctly (the build
// mirror's static 0..4 labels assume week 4 is latest — wrong once the program
// runs past it).
export function normalizeStandingRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const weeksSet = new Set();
  const byTeam = {};
  for (const r of rows) {
    if (!r || r.record_id == null) continue;
    const pw = Number(r.program_week);
    if (!Number.isFinite(pw)) continue;
    weeksSet.add(pw);
    const t =
      byTeam[r.record_id] ||
      (byTeam[r.record_id] = { target_stage: r.target_stage ?? null, target_source: r.target_source || null, weeks: {} });
    if (r.target_stage != null) t.target_stage = r.target_stage;
    if (r.target_source) t.target_source = r.target_source;
    t.weeks[pw] = { stage: r.stage, confidence: r.confidence };
  }
  const sorted = [...weeksSet].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const maxWk = sorted[sorted.length - 1];
  const weeks = sorted.map((pw) => ({
    program_week: pw,
    label: pw === 0 ? "Program start" : pw === maxWk ? "Latest" : `Week ${pw}`,
  }));
  return { weeks, byTeam };
}

// Fetch live standing. Always resolves (never throws) so a Supabase outage degrades
// to the committed mirror. Returns { data, source }: source is "supabase" on
// success, "unconfigured" with no anon key, "empty" when there are no rows, or
// "error" with an `error` string.
export async function fetchStandingWeekly(opts = {}) {
  const { rows, source, error } = await fetchAnon(STANDING_PATH, opts);
  if (source === "unconfigured") return { data: null, source: "unconfigured" };
  if (source === "error") return { data: null, source: "error", error };
  const data = normalizeStandingRows(rows);
  if (!data) return { data: null, source: "empty" };
  return { data, source: "supabase" };
}

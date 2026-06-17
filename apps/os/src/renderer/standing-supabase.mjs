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

import { readSupabaseConfig } from "./supabase-evidence.mjs";

// PostgREST URL for the curated anon-readable standing projection. anon reads
// public_* views, never base tables (the base team_standing_weekly has a public
// RLS policy but NO anon GRANT — see 20260616010000_revoke_stray_anon_grants.sql),
// so the live read targets the public_team_standing_weekly view.
export function publicTeamStandingWeeklyUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/public_team_standing_weekly`);
  url.searchParams.set("select", "record_id,program_week,stage,confidence,target_stage,target_source");
  url.searchParams.set("order", "record_id,program_week");
  return url.toString();
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
export async function fetchStandingWeekly({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { data: null, source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(publicTeamStandingWeeklyUrl(url), {
      headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    return { data: null, source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { data: null, source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    return { data: null, source: "error", error: "invalid JSON from Supabase" };
  }
  const data = normalizeStandingRows(rows);
  if (!data) return { data: null, source: "empty" };
  return { data, source: "supabase" };
}

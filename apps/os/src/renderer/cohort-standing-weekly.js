// Read-only per-week standing loader for the goal views (standing / targets).
//
// Source of truth is the Supabase table `team_standing_weekly`; the committed
// `cohort-standing-weekly.json` is the build output (regenerate with
// scripts/build-standing-weekly.mjs). The goal views read each team's PMF stage
// per program week from here, so the "as of [week]" timeline dropdown actually
// moves them. Today the rows are a deterministic seed ending at each team's
// current stage; swap them for real weekly reads and rebuild — no renderer
// change needed.

import { fetchStandingWeekly } from "./standing-supabase.mjs";

const STANDING_URL = new URL("../cohort-standing-weekly.json", import.meta.url);

let _cache = null;
let _promise = null;

function normalize(data) {
  const src = data && typeof data === "object" ? data : {};
  const weeks = Array.isArray(src.weeks)
    ? src.weeks
        .filter((w) => w && Number.isFinite(Number(w.program_week)))
        .map((w) => ({ program_week: Number(w.program_week), label: String(w.label || `Week ${w.program_week}`) }))
        .sort((a, b) => a.program_week - b.program_week)
    : [];
  const byTeam = src.byTeam && typeof src.byTeam === "object" ? src.byTeam : {};
  return { weeks, byTeam };
}

export async function getStandingWeekly() {
  if (_cache) return _cache;
  if (_promise) return _promise;
  _promise = (async () => {
    // Live read first — team_standing_weekly is public-read, so the standing line
    // reflects the latest weekly reads without a rebuild. The committed mirror is
    // the offline / first-paint fallback. Same {weeks, byTeam} shape either way.
    try {
      const { data, source } = await fetchStandingWeekly({ storage: globalThis.localStorage });
      if (source === "supabase" && data) return (_cache = normalize(data));
    } catch { /* fall through to the committed mirror */ }
    const res = await fetch(STANDING_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`standing weekly unavailable: HTTP ${res.status}`);
    _cache = normalize(await res.json());
    return _cache;
  })().finally(() => {
    _promise = null;
  });
  return _promise;
}
